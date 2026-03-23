"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentModel, ChatEntry, ConnectedMachine, DaemonMessage, DaemonResponse, HiveUser, ReviewItem, UploadedFileRef, WorkerContextSnapshot, WorkerState } from "@/lib/types";

/** Extended response type for message types beyond the base DaemonResponse union */
type ExtendedResponse = DaemonResponse
  | { type: "models"; models?: AgentModel[] }
  | { type: "vapid_key"; vapidKey?: string }
  | { type: "push_status"; subscribed?: boolean }
  | { type: "user_list"; users?: unknown[] }
  | { type: "user_created"; user?: unknown }
  | { type: "user_removed"; userId?: string; ok?: boolean };

const MAX_CHAT_ENTRIES = 150;

/** Normalize text for comparison  --  matches tty-input.ts cleaning */
const norm = (s: string) => s.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();

export function useHive(daemonUrl: string) {
  const [connected, setConnected] = useState(false);
  const [workers, setWorkers] = useState<Map<string, WorkerState>>(new Map());
  const [chatEntries, setChatEntries] = useState<Map<string, ChatEntry[]>>(new Map());
  const [workerContexts, setWorkerContexts] = useState<Map<string, WorkerContextSnapshot>>(new Map());
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [reviews, setReviews] = useState<ReviewItem[]>([]);
  const [models, setModels] = useState<AgentModel[]>([
    { id: "claude", label: "Claude" },
    { id: "codex", label: "Codex" },
    { id: "openclaw", label: "OpenClaw" },
  ]);
  const [vapidKey, setVapidKey] = useState<string | null>(null);
  const [machines, setMachines] = useState<ConnectedMachine[]>([]);
  const [presence, setPresence] = useState<HiveUser[]>([]);
  const [activity, setActivity] = useState<{ text: string; timestamp: number } | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const subscribedRef = useRef<string | null>(null);
  const [connectEpoch, setConnectEpoch] = useState(0);
  const reconnectDelayRef = useRef(500);
  // Track optimistic user messages for dedup: Set of unique IDs
  const optimisticIdsRef = useRef<Set<string>>(new Set());
  // Monotonic counter for unique optimistic entry IDs
  const optimisticSeqRef = useRef(0);
  const pendingUploadsRef = useRef(new Map<string, {
    resolve: (upload: UploadedFileRef) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>());
  const pendingMessagesRef = useRef<DaemonMessage[]>([]);
  const flushPendingMessages = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const queue = pendingMessagesRef.current.slice();
    if (queue.length === 0) return;
    pendingMessagesRef.current.length = 0;
    for (const queued of queue) {
      ws.send(JSON.stringify(queued));
    }
  }, []);

  const send = useCallback(
    (msg: DaemonMessage): boolean => {
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) {
        if (pendingMessagesRef.current.length > 0) {
          flushPendingMessages();
        }
        ws.send(JSON.stringify(msg));
        return true;
      }
      pendingMessagesRef.current.push(msg);
      return true;
    },
    [flushPendingMessages]
  );

  // Track whether we received a non-empty full history for the current subscription.
  // If not, retry after a delay (session file might not be mapped yet).
  const chatReceivedRef = useRef(false);
  const chatRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Subscribe to a worker's chat stream.
   *  force=true bypasses the idempotent guard (re-subscribes even if already subscribed). */
  const subscribeTo = useCallback(
    (workerId: string | null, force?: boolean) => {
      // Idempotent: skip if already subscribed to this worker (unless forced).
      // Prevents double-fire from onPointerDown + onClick racing.
      if (!force && workerId === subscribedRef.current) return;

      // Clear retry timer
      if (chatRetryTimerRef.current) {
        clearTimeout(chatRetryTimerRef.current);
        chatRetryTimerRef.current = null;
      }

      // Unsubscribe from previous
      if (subscribedRef.current) {
        send({ type: "unsubscribe", workerId: subscribedRef.current });
      }
      subscribedRef.current = workerId;
      chatReceivedRef.current = false;
      if (workerId) {
        send({ type: "subscribe", workerId });
        // Auto-retry if no full history received within 3s.
        // Covers: session file not mapped yet, satellite relay delay, lost response.
        const retryWid = workerId;
        chatRetryTimerRef.current = setTimeout(() => {
          if (subscribedRef.current === retryWid && !chatReceivedRef.current) {
            send({ type: "subscribe", workerId: retryWid });
          }
        }, 3_000);
      }
    },
    [send]
  );

  // Reviews are sent over WS on connect (no REST needed  --  tunnel only exposes WS port)

  useEffect(() => {
    if (!daemonUrl) return;

    function connect() {
      // Append auth token as query param for server-side validation
      const token = localStorage.getItem("hive_token") || "";
      const sep = daemonUrl.includes("?") ? "&" : "?";
      const authedUrl = token ? `${daemonUrl}${sep}token=${encodeURIComponent(token)}` : daemonUrl;

      const ws = new WebSocket(authedUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        reconnectDelayRef.current = 500; // Reset backoff on success
        // Re-subscribe if we had a subscription before reconnect.
        // Reset chatReceived so the retry timer kicks in if response is delayed.
        chatReceivedRef.current = false;
        if (subscribedRef.current) {
          ws.send(JSON.stringify({ type: "subscribe", workerId: subscribedRef.current }));
        }
        flushPendingMessages();
      };

      ws.onmessage = (event) => {
        let data: ExtendedResponse;
        try {
          data = JSON.parse(event.data);
        } catch {
          return;
        }

        switch (data.type) {
          case "workers": {
            const next = new Map<string, WorkerState>();
            if (data.workers) {
              for (const w of data.workers) {
                next.set(w.id, w);
              }
            }
            setWorkers(next);
            break;
          }

          case "worker_update": {
            if (data.worker) {
              const w = data.worker;
              setWorkers((prev) => {
                const next = new Map(prev);
                next.set(w.id, w);
                return next;
              });
            }
            break;
          }

          case "worker_removed": {
            if (data.workerId) {
              const rid = data.workerId;
              setWorkers((prev) => {
                if (!prev.has(rid)) return prev;
                const next = new Map(prev);
                next.delete(rid);
                return next;
              });
              setWorkerContexts((prev) => {
                if (!prev.has(rid)) return prev;
                const next = new Map(prev);
                next.delete(rid);
                return next;
              });
            }
            break;
          }
          case "presence": {
            setPresence(data.users ?? []);
            break;
          }
          case "activity": {
            if (data.userName && data.action && typeof data.timestamp === "number") {
              setActivity({
                text: `${data.userName} ${data.action}`,
                timestamp: data.timestamp,
              });
            }
            break;
          }

          case "chat_history": {
            if (data.workerId && data.messages) {
              const wid = data.workerId;

              // Ignore stale responses from workers we're no longer subscribed to.
              // This prevents cross-contamination when rapidly switching agents.
              if (wid !== subscribedRef.current) break;

              const newEntries = data.messages;

              if (data.full) {
                // Mark that we received history  --  cancels the auto-retry timer.
                chatReceivedRef.current = true;
                // Full history  --  authoritative replace from server.
                // Merge: server state is ground truth, but append any optimistic
                // user messages that aren't yet reflected in the server history.
                setChatEntries((prev) => {
                  const next = new Map(prev);
                  const serverEntries = newEntries.length > MAX_CHAT_ENTRIES
                    ? newEntries.slice(-MAX_CHAT_ENTRIES)
                    : [...newEntries];

                  // Find optimistic entries not yet in server history
                  const existing = prev.get(wid) ?? [];
                  const pendingOptimistic = existing.filter(e =>
                    e.role === "user" && e._optimisticId && optimisticIdsRef.current.has(e._optimisticId)
                  );

                  // Check which optimistic entries are already in server history
                  // by matching normalized text against the last N server user messages
                  const serverUserTexts = new Set(
                    serverEntries.filter(e => e.role === "user").slice(-10).map(e => norm(e.text))
                  );
                  const stillPending = pendingOptimistic.filter(e => !serverUserTexts.has(norm(e.text)));

                  // Clear all optimistic IDs that ARE in server history
                  for (const e of pendingOptimistic) {
                    if (e._optimisticId && serverUserTexts.has(norm(e.text))) {
                      optimisticIdsRef.current.delete(e._optimisticId);
                    }
                  }

                  const updated = [...serverEntries, ...stillPending];
                  next.set(wid, updated);
                  return next;
                });
              } else {
                // Incremental update  --  append with optimistic dedup.
                setChatEntries((prev) => {
                  const next = new Map(prev);
                  const existing = next.get(wid) ?? [];

                  const deduped = newEntries.filter(e => {
                    if (e.role === "user") {
                      const eNorm = norm(e.text);
                      // Find the oldest matching optimistic entry and consume it
                      for (const oid of optimisticIdsRef.current) {
                        const match = existing.find(x =>
                          x._optimisticId === oid && norm(x.text) === eNorm
                        );
                        if (match) {
                          optimisticIdsRef.current.delete(oid);
                          return false; // Skip server echo  --  optimistic already shown
                        }
                      }
                      // Also deduplicate against the very last entry to catch edge cases
                      const last = existing[existing.length - 1];
                      if (last?.role === "user" && norm(last.text) === eNorm && !last._optimisticId) {
                        // Same text from server arrived twice  --  skip
                        return false;
                      }
                    }
                    return true;
                  });

                  if (deduped.length === 0) {
                    return prev; // No change  --  skip re-render
                  }
                  const updated = [...existing, ...deduped];
                  if (updated.length > MAX_CHAT_ENTRIES) {
                    updated.splice(0, updated.length - MAX_CHAT_ENTRIES);
                  }
                  next.set(wid, updated);
                  return next;
                });
              }
            }
            break;
          }

          case "chat": {
            // Legacy: raw stdout from managed workers
            if (data.workerId && data.content) {
              const wid = data.workerId;
              const entry: ChatEntry = { role: "agent", text: data.content };
              setChatEntries((prev) => {
                const next = new Map(prev);
                const existing = next.get(wid) ?? [];
                const updated = [...existing, entry];
                if (updated.length > MAX_CHAT_ENTRIES) {
                  updated.splice(0, updated.length - MAX_CHAT_ENTRIES);
                }
                next.set(wid, updated);
                return next;
              });
            }
            break;
          }

          case "worker_context": {
            const context = data.context;
            const workerId = data.workerId;
            if (workerId && context) {
              setWorkerContexts((prev) => {
                const next = new Map(prev);
                next.set(workerId, context);
                return next;
              });
            }
            break;
          }

          case "upload_result": {
            const requestId = data.requestId;
            if (!requestId) break;
            const pending = pendingUploadsRef.current.get(requestId);
            if (!pending) break;
            clearTimeout(pending.timer);
            pendingUploadsRef.current.delete(requestId);
            if (data.ok && data.upload) {
              pending.resolve(data.upload);
            } else {
              pending.reject(new Error(data.error || "Upload failed"));
            }
            break;
          }

          case "reviews": {
            if (data.reviews && Array.isArray(data.reviews)) {
              setReviews(data.reviews);
            }
            break;
          }

          case "review_added": {
            if (data.review) {
              const newReview = data.review;
              setReviews((prev) => [newReview, ...prev]);
            }
            break;
          }

          case "models": {
            if (data.models && Array.isArray(data.models)) {
              setModels(data.models);
            }
            break;
          }

          case "machines": {
            if (data.machines && Array.isArray(data.machines)) {
              setMachines(data.machines);
            }
            break;
          }

          case "auth": {
            setIsAdmin(data.admin ?? false);
            break;
          }

          case "vapid_key": {
            if (data.vapidKey) setVapidKey(data.vapidKey);
            break;
          }

          case "push_status":
            break;

          case "user_list":
          case "user_created":
          case "user_removed": {
            // Forward to InviteDialog via custom event
            const target = typeof window !== "undefined"
              ? (window as unknown as Record<string, EventTarget>).__hiveInviteTarget
              : null;
            if (target) {
              target.dispatchEvent(new CustomEvent("msg", { detail: data }));
            }
            break;
          }

          case "orchestrator":
          case "error":
            break;
        }
      };

      ws.onclose = () => {
        setConnected(false);
        wsRef.current = null;
        for (const pending of pendingUploadsRef.current.values()) {
          clearTimeout(pending.timer);
          pending.reject(new Error("Disconnected"));
        }
        pendingUploadsRef.current.clear();
        reconnectTimerRef.current = setTimeout(connect, reconnectDelayRef.current);
        reconnectDelayRef.current = Math.min(reconnectDelayRef.current * 2, 8000);
      };

      ws.onerror = () => {
        ws.close();
      };
    }

    connect();

    return () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
        wsRef.current = null;
      }
      for (const pending of pendingUploadsRef.current.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Disconnected"));
      }
      pendingUploadsRef.current.clear();
      setConnected(false);
    };
  }, [daemonUrl, connectEpoch]);

  /** Optimistically add a user message to the chat (shows immediately before server echo) */
  const addOptimisticEntry = useCallback(
    (workerId: string, text: string) => {
      const oid = `opt_${++optimisticSeqRef.current}`;
      optimisticIdsRef.current.add(oid);
      const entry: ChatEntry = { role: "user", text, timestamp: Date.now(), _optimisticId: oid };
      setChatEntries((prev) => {
        const next = new Map(prev);
        const existing = next.get(workerId) ?? [];
        next.set(workerId, [...existing, entry]);
        return next;
      });
      // Auto-expire optimistic tracking after 30s (server echo should arrive well before)
      setTimeout(() => { optimisticIdsRef.current.delete(oid); }, 30_000);
    },
    []
  );

  /** Force reconnect (e.g. after token change) */
  const reconnect = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (wsRef.current) {
      wsRef.current.onclose = null;
      wsRef.current.close();
      wsRef.current = null;
    }
    setIsAdmin(null);
    setConnected(false);
    setConnectEpoch((e) => e + 1);
  }, []);

  /** Mark a review as seen */
  const markReviewSeen = useCallback(
    (id: string) => {
      setReviews((prev) => prev.map(r => r.id === id ? { ...r, seen: true } : r));
      send({ type: "review_seen", reviewId: id });
    },
    [send]
  );

  /** Dismiss a review */
  const dismissReview = useCallback(
    (id: string) => {
      setReviews((prev) => prev.filter(r => r.id !== id));
      send({ type: "review_dismiss", reviewId: id });
    },
    [send]
  );

  /** Mark all reviews as seen */
  const markAllReviewsSeen = useCallback(
    () => {
      setReviews((prev) => prev.map(r => ({ ...r, seen: true })));
      send({ type: "review_seen_all" });
    },
    [send]
  );

  /** Clear all reviews */
  const clearAllReviews = useCallback(
    () => {
      setReviews([]);
      send({ type: "review_clear_all" });
    },
    [send]
  );

  const requestWorkerContext = useCallback(
    (workerId: string, opts: { includeHistory?: boolean; historyLimit?: number } = {}) => {
      send({
        type: "worker_context",
        workerId,
        includeHistory: opts.includeHistory !== false,
        ...(typeof opts.historyLimit === "number" ? { historyLimit: opts.historyLimit } : {}),
      });
    },
    [send]
  );

  const uploadToWorker = useCallback(
    (workerId: string, payload: {
      fileName: string;
      mimeType?: string;
      size: number;
      dataBase64: string;
    }) => new Promise<UploadedFileRef>((resolve, reject) => {
      if (wsRef.current?.readyState !== WebSocket.OPEN) {
        reject(new Error("Dashboard is disconnected"));
        return;
      }
      const requestId = `upload_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const timer = setTimeout(() => {
        pendingUploadsRef.current.delete(requestId);
        reject(new Error("Upload timed out"));
      }, 30_000);
      pendingUploadsRef.current.set(requestId, { resolve, reject, timer });
      wsRef.current.send(JSON.stringify({
        type: "upload_file",
        requestId,
        workerId,
        fileName: payload.fileName,
        mimeType: payload.mimeType,
        size: payload.size,
        dataBase64: payload.dataBase64,
      } satisfies DaemonMessage));
    }),
    []
  );

  return {
    connected, workers, chatEntries, workerContexts, send, subscribeTo, addOptimisticEntry, isAdmin, reconnect,
    requestWorkerContext, uploadToWorker,
    reviews, markReviewSeen, dismissReview, markAllReviewsSeen, clearAllReviews, models, vapidKey, machines,
    presence, activity,
  };
}
