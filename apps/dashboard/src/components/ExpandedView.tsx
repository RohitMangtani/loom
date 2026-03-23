"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatEntry, WorkerState } from "@/lib/types";
import { dotColor, DOT_BG, statusLabel, quickButtons, modelLabel } from "./AgentCard";
import { describePins, type Pin } from "./LivePreview";

export function ExpandedView({
  worker,
  num,
  entries,
  draft,
  onDraftChange,
  onSend,
  onDismiss,
  previewUrl,
  onPreviewUrlChange,
  onSuggestionApply,
}: {
  worker: WorkerState;
  num: number;
  entries: ChatEntry[];
  draft: string;
  onDraftChange: (v: string) => void;
  onSend: (msg: string) => boolean;
  onDismiss: () => void;
  previewUrl: string;
  onPreviewUrlChange: (url: string) => void;
  onSuggestionApply?: (appliedLabel: string, shownLabels: string[]) => void;
}) {
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const lastSendRef = useRef<{ text: string; at: number }>({ text: "", at: 0 });
  const color = dotColor(worker);
  const canSend = worker.managed || !!worker.tty;
  const stuck = worker.status === "stuck";
  const buttons = stuck ? quickButtons(worker) : [];

  // Reference points
  const [pins, setPins] = useState<Pin[]>([]);
  const pinCounterRef = useRef(0);

  const handleAddPin = useCallback((x: number, y: number) => {
    pinCounterRef.current += 1;
    setPins((prev) => [...prev, { id: pinCounterRef.current, x, y }]);
  }, []);

  const handleRemovePin = useCallback((id: number) => {
    setPins((prev) => prev.filter((p) => p.id !== id));
  }, []);

  const handleClearPins = useCallback(() => {
    setPins([]);
    pinCounterRef.current = 0;
  }, []);

  const guardedSend = (msg: string): boolean => {
    const augmented = msg + describePins(pins);
    const now = Date.now();
    if (augmented === lastSendRef.current.text && now - lastSendRef.current.at < 1000)
      return false;
    const ok = onSend(augmented);
    if (ok) {
      lastSendRef.current = { text: augmented, at: now };
      if (pins.length > 0) handleClearPins();
    }
    return ok;
  };

  // Auto-scroll chat
  const prevEntriesLen = useRef(0);
  useEffect(() => {
    const el = chatScrollRef.current;
    if (!el) return;
    const wasEmpty = prevEntriesLen.current === 0;
    prevEntriesLen.current = entries.length;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    if (nearBottom || wasEmpty) {
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight;
      });
    }
  }, [entries]);

  const recentEntries = entries.filter((e) => e.role !== "tool").slice(-20);

  return (
    <div className="h-full flex flex-col animate-expand-in">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-2.5 border-b border-[var(--border)] shrink-0 bg-[var(--bg-card)]">
        <button
          type="button"
          onClick={onDismiss}
          className="text-[var(--text-light)] hover:text-[var(--text)] transition-colors text-sm cursor-pointer"
        >
          &#8592;
        </button>
        <span
          className={`w-2 h-2 rounded-full shrink-0 ${stuck ? "animate-pulse" : ""}`}
          style={{ background: DOT_BG[color] }}
        />
        <span className="font-semibold text-[13px]">{modelLabel(worker)} {num}</span>
        <span className="text-[11px] text-[var(--text-light)] truncate">
          {worker.projectName}
        </span>
        <span className="text-[10px] text-[var(--text-muted)] ml-auto truncate max-w-[30%]">
          {statusLabel(worker)}
        </span>
      </div>

      {/* Main: chat */}
      <div className="flex-1 min-h-0 flex flex-col">
        <div className="flex-1 min-h-0 flex flex-col">
          {/* Chat transcript */}
          {recentEntries.length > 0 && (
            <div className="flex-1 min-h-0">
              <div
                ref={chatScrollRef}
                className="overflow-y-auto px-3 py-2 space-y-1.5 h-full"
              >
                {recentEntries.map((entry, i) => (
                  <div
                    key={i}
                    className={`text-[11px] leading-snug ${entry.role === "user" ? "text-right" : ""}`}
                  >
                    <span
                      className={`inline-block max-w-[90%] px-2.5 py-1 rounded-lg ${
                        entry.role === "user"
                          ? "bg-[var(--accent)] text-white rounded-br-sm"
                          : "bg-[var(--bg-panel)] text-[var(--text-muted)] rounded-bl-sm border border-[var(--border)]"
                      }`}
                    >
                      {entry.text.length > 300 ? entry.text.slice(0, 300) + "..." : entry.text}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Chat input  --  always visible as fallback */}
          {canSend && (
            <div className="border-t border-[var(--border)] px-3 py-2 shrink-0">
              {stuck && buttons.length > 0 && (
                <div className="flex items-center gap-1.5 mb-2 flex-wrap">
                  <span className="text-[10px] text-[#fbbf24] shrink-0">
                    {worker.currentAction}:
                  </span>
                  {buttons.map((b) => (
                    <button
                      key={b.value}
                      type="button"
                      onClick={() => onSend(b.value)}
                      className="quick-reply-btn text-[10px] px-2 py-0.5"
                    >
                      {b.label}
                    </button>
                  ))}
                </div>
              )}
              {pins.length > 0 && (
                <div className="flex items-center gap-1.5 mb-1.5">
                  <span className="text-[10px] text-[var(--accent)]">
                    {pins.length} pin{pins.length !== 1 ? "s" : ""} attached
                  </span>
                  <button
                    type="button"
                    onClick={handleClearPins}
                    className="text-[10px] text-[var(--text-light)] hover:text-[var(--text)] cursor-pointer"
                  >
                    clear
                  </button>
                </div>
              )}
              <div className="flex gap-2 items-center">
                <input
                  ref={inputRef}
                  type="text"
                  value={draft}
                  onChange={(e) => onDraftChange(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      if (draft.trim()) {
                        const sent = guardedSend(draft.trim());
                        if (sent) onDraftChange("");
                      }
                    }
                  }}
                  placeholder="Message agent..."
                  className="chat-input flex-1 min-w-0 !h-[40px] text-[13px] !py-0"
                />
                <button
                  type="button"
                  disabled={!draft.trim()}
                  onClick={() => {
                    if (draft.trim()) {
                      const sent = guardedSend(draft.trim());
                      if (sent) onDraftChange("");
                    }
                  }}
                  className="send-btn !h-[40px] !max-h-[40px] !text-[12px] !px-4"
                >
                  Send
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
