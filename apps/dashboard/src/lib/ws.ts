"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatEntry, DaemonMessage, DaemonResponse, WorkerState } from "@/lib/types";

const MAX_CHAT_ENTRIES = 200;

export function useHive(daemonUrl: string) {
  const [connected, setConnected] = useState(false);
  const [workers, setWorkers] = useState<Map<string, WorkerState>>(new Map());
  const [chatEntries, setChatEntries] = useState<Map<string, ChatEntry[]>>(new Map());

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const subscribedRef = useRef<string | null>(null);

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
        // Clear existing entries so the fresh history from server replaces them
        setChatEntries((prev) => {
          const next = new Map(prev);
          next.delete(workerId);
          return next;
        });
        send({ type: "subscribe", workerId });
      }
    },
    [send]
  );

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
        // Re-subscribe if we had a subscription before reconnect
        if (subscribedRef.current) {
          ws.send(JSON.stringify({ type: "subscribe", workerId: subscribedRef.current }));
        }
      };

      ws.onmessage = (event) => {
        let data: DaemonResponse;
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
              setChatEntries((prev) => {
                const next = new Map(prev);
                const existing = next.get(wid) ?? [];
                // Dedup: skip incoming user messages that match a recent optimistic entry.
                // Optimistic entries have a timestamp; server echoes don't (or have a different one).
                // Match by role + text within the last 5 entries to avoid duplicates.
                const recentTexts = new Set(
                  existing.slice(-5).filter(e => e.role === "user").map(e => e.text)
                );
                const deduped = newEntries.filter(e =>
                  !(e.role === "user" && recentTexts.has(e.text))
                );
                const updated = [...existing, ...deduped];
                // Keep within limit
                if (updated.length > MAX_CHAT_ENTRIES) {
                  updated.splice(0, updated.length - MAX_CHAT_ENTRIES);
                }
                next.set(wid, updated);
                return next;
              });
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

          case "orchestrator":
          case "error":
            break;
        }
      };

      ws.onclose = () => {
        setConnected(false);
        wsRef.current = null;
        reconnectTimerRef.current = setTimeout(connect, 3000);
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
  }, [daemonUrl]);

  /** Optimistically add a user message to the chat (shows immediately before server echo) */
  const addOptimisticEntry = useCallback(
    (workerId: string, text: string) => {
      const entry: ChatEntry = { role: "user", text, timestamp: Date.now() };
      setChatEntries((prev) => {
        const next = new Map(prev);
        const existing = next.get(workerId) ?? [];
        next.set(workerId, [...existing, entry]);
        return next;
      });
    },
    []
  );

  return { connected, workers, chatEntries, send, subscribeTo, addOptimisticEntry };
}
