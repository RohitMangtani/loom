"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DaemonMessage, DaemonResponse, WorkerState } from "@/lib/types";

const MAX_CHAT_MESSAGES = 500;

export function useHive(daemonUrl: string, token: string) {
  const [connected, setConnected] = useState(false);
  const [workers, setWorkers] = useState<Map<string, WorkerState>>(new Map());
  const [chatMessages, setChatMessages] = useState<Map<string, string[]>>(
    new Map()
  );

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const send = useCallback(
    (msg: Omit<DaemonMessage, "token">) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ ...msg, token }));
      }
    },
    [token]
  );

  useEffect(() => {
    if (!daemonUrl || !token) return;

    function connect() {
      const ws = new WebSocket(daemonUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        // Authenticate and request initial worker list
        ws.send(JSON.stringify({ type: "list", token }));
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

          case "chat": {
            if (data.workerId && data.content) {
              const wid = data.workerId;
              const content = data.content;
              setChatMessages((prev) => {
                const next = new Map(prev);
                const existing = next.get(wid) ?? [];
                const updated = [...existing, content];
                // Cap at MAX_CHAT_MESSAGES
                if (updated.length > MAX_CHAT_MESSAGES) {
                  updated.splice(0, updated.length - MAX_CHAT_MESSAGES);
                }
                next.set(wid, updated);
                return next;
              });
            }
            break;
          }

          case "orchestrator":
          case "error":
            // These are handled by the page/components directly if needed
            break;
        }
      };

      ws.onclose = () => {
        setConnected(false);
        wsRef.current = null;
        // Auto-reconnect after 5 seconds
        reconnectTimerRef.current = setTimeout(connect, 5000);
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
        wsRef.current.onclose = null; // Prevent reconnect on intentional cleanup
        wsRef.current.close();
        wsRef.current = null;
      }
      setConnected(false);
    };
  }, [daemonUrl, token]);

  return { connected, workers, chatMessages, send };
}
