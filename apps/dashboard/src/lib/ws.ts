"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentModel, ChatEntry, DaemonMessage, DaemonResponse, ReviewItem, WorkerState } from "@/lib/types";

/** Extended response type until shared types package adds "models" */
type ExtendedResponse = DaemonResponse | { type: "models"; models?: AgentModel[] } | { type: "vapid_key"; vapidKey?: string } | { type: "push_status"; subscribed?: boolean };

const MAX_CHAT_ENTRIES = 200;

/** Normalize text for comparison — matches tty-input.ts cleaning */
const norm = (s: string) => s.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();

export function useHive(daemonUrl: string) {
  const [connected, setConnected] = useState(false);
  const [workers, setWorkers] = useState<Map<string, WorkerState>>(new Map());
  const [chatEntries, setChatEntries] = useState<Map<string, ChatEntry[]>>(new Map());
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [reviews, setReviews] = useState<ReviewItem[]>([]);
  const [models, setModels] = useState<AgentModel[]>([
    { id: "claude", label: "Claude" },
    { id: "codex", label: "Codex" },
    { id: "openclaw", label: "OpenClaw" },
    { id: "gemini", label: "Gemini" },
  ]);
  const [vapidKey, setVapidKey] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const subscribedRef = useRef<string | null>(null);
  const [connectEpoch, setConnectEpoch] = useState(0);
  const reconnectDelayRef = useRef(500);
  // Track optimistic user messages for dedup: Set of unique IDs
  const optimisticIdsRef = useRef<Set<string>>(new Set());
  // Monotonic counter for unique optimistic entry IDs
  const optimisticSeqRef = useRef(0);

  const send = useCallback(
    (msg: DaemonMessage): boolean => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify(msg));
        return true;
      }
      return false;
    },
    []
  );

  /** Subscribe to a worker's chat stream */
  const subscribeTo = useCallback(
    (workerId: string | null) => {
      // Unsubscribe from previous
      if (subscribedRef.current) {
        send({ type: "unsubscribe", workerId: subscribedRef.current });
      }
      subscribedRef.current = workerId;
      if (workerId) {
        send({ type: "subscribe", workerId });
      }
    },
    [send]
  );

  // Reviews are sent over WS on connect (no REST needed — tunnel only exposes WS port)

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
        // Re-subscribe if we had a subscription before reconnect
        if (subscribedRef.current) {
          ws.send(JSON.stringify({ type: "subscribe", workerId: subscribedRef.current }));
        }
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

          case "chat_history": {
            if (data.workerId && data.messages) {
              const wid = data.workerId;
              const newEntries = data.messages;

              if (data.full) {
                // Full history — authoritative replace from server.
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
                // Incremental update — append with optimistic dedup.
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
                          return false; // Skip server echo — optimistic already shown
                        }
                      }
                      // Also deduplicate against the very last entry to catch edge cases
                      const last = existing[existing.length - 1];
                      if (last?.role === "user" && norm(last.text) === eNorm && !last._optimisticId) {
                        // Same text from server arrived twice — skip
                        return false;
                      }
                    }
                    return true;
                  });

                  if (deduped.length === 0) {
                    return prev; // No change — skip re-render
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

          case "orchestrator":
          case "error":
            break;
        }
      };

      ws.onclose = () => {
        setConnected(false);
        wsRef.current = null;
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

  return {
    connected, workers, chatEntries, send, subscribeTo, addOptimisticEntry, isAdmin, reconnect,
    reviews, markReviewSeen, dismissReview, markAllReviewsSeen, clearAllReviews, models, vapidKey,
  };
}
