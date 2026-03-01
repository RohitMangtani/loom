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
    (msg: DaemonMessage) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify(msg));
      }
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
        setAuthFailed(false);
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
                const updated = [...existing, ...newEntries];
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

  return { connected, workers, chatEntries, send, subscribeTo };
}
