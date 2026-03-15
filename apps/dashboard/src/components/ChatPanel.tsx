"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatEntry, WorkerState } from "@/lib/types";
import { dotColor, DOT_BG, statusLabel, quickButtons, modelLabel } from "./AgentCard";
import { describePins, type Pin } from "./LivePreview";

export function ChatPanel({
  worker, num, entries, draft, onDraftChange, onSend, onClose, onDismiss, expanded, onExpand,
  previewUrl, onPreviewUrlChange,
}: {
  worker: WorkerState; num: number; entries: ChatEntry[];
  draft: string; onDraftChange: (v: string) => void;
  onSend: (msg: string) => boolean; onClose: () => void; onDismiss: () => void;
  expanded: boolean; onExpand: (v: boolean) => void;
  previewUrl: string; onPreviewUrlChange: (url: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const touchStartY = useRef<number | null>(null);
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

  // Guard against double-sends from rapid clicks/keypresses before React re-renders.
  // Augments message with pin reference context when pins exist.
  const guardedSend = (msg: string): boolean => {
    const augmented = msg + describePins(pins);
    const now = Date.now();
    if (augmented === lastSendRef.current.text && now - lastSendRef.current.at < 1000) return false;
    const ok = onSend(augmented);
    if (ok) {
      lastSendRef.current = { text: augmented, at: now };
      // Clear pins after sending — they've been consumed
      if (pins.length > 0) handleClearPins();
    }
    return ok;
  };

  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const onExpandRef = useRef(onExpand);
  onExpandRef.current = onExpand;
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  const prevEntriesLen = useRef(0);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const wasEmpty = prevEntriesLen.current === 0;
    prevEntriesLen.current = entries.length;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 150;
    if (nearBottom || wasEmpty) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
      });
    }
  }, [entries]);

  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;

    const onStart = (e: TouchEvent) => {
      touchStartY.current = e.touches[0].clientY;
    };
    const onMove = (e: TouchEvent) => {
      if (touchStartY.current === null) return;
      e.preventDefault();
      const dy = e.touches[0].clientY - touchStartY.current;
      if (dy > 20) {
        touchStartY.current = null;
        if (expandedRef.current) { onExpandRef.current(false); textareaRef.current?.blur(); }
        else if (document.activeElement === textareaRef.current) textareaRef.current?.blur();
        else onDismissRef.current();
      } else if (dy < -8) {
        touchStartY.current = null;
        if (!expandedRef.current) { onExpandRef.current(true); setTimeout(() => textareaRef.current?.focus(), 350); }
      }
    };
    const onEnd = (e: TouchEvent) => {
      if (touchStartY.current === null) return;
      const dy = e.changedTouches[0].clientY - touchStartY.current;
      touchStartY.current = null;
      if (dy > 20) {
        if (expandedRef.current) { onExpandRef.current(false); textareaRef.current?.blur(); }
        else if (document.activeElement === textareaRef.current) textareaRef.current?.blur();
        else onDismissRef.current();
      } else if (dy < -8) {
        if (!expandedRef.current) { onExpandRef.current(true); setTimeout(() => textareaRef.current?.focus(), 350); }
      }
    };

    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd, { passive: true });
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
    };
  }, []);

  useEffect(() => {
    const handler = () => {
      if (document.visibilityState === "visible" && textareaRef.current) {
        setTimeout(() => textareaRef.current?.focus(), 100);
      }
    };
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  }, []);

  return (
      <div className="chat-panel flex-1 min-h-0 flex flex-col overflow-hidden">
        <div
          ref={headerRef}
          className="relative flex items-start justify-between gap-3 px-5 pt-6 pb-5 border-b border-[var(--border)] shrink-0 cursor-grab active:cursor-grabbing touch-none bg-[rgba(8,12,24,0.92)] backdrop-blur-xl"
        >
          <div className="absolute top-2 left-1/2 -translate-x-1/2 w-10 h-1 rounded-full bg-[rgba(148,163,184,0.35)]" />
          <div className="min-w-0 flex items-start gap-3">
            <div className="card-slot-badge shrink-0">{num}</div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="card-model-pill">{modelLabel(worker)}</span>
                <span className="card-project-pill">{worker.projectName || "Unknown project"}</span>
                <span className={`card-status-pill card-status-${color}`}>
                  <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${stuck ? "animate-pulse" : ""}`} style={{ background: DOT_BG[color] }} />
                  {stuck ? "Waiting" : worker.status === "working" ? "Active" : "Idle"}
                </span>
              </div>
              <p className="mt-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--text-light)]">
                Selected worker relay
              </p>
              <p className="mt-1 text-sm text-[var(--text)] leading-snug">
                {statusLabel(worker)}
              </p>
              {previewUrl && (
                <p className="mt-2 max-w-full truncate text-[10px] font-mono text-[var(--text-light)]">
                  Preview: {previewUrl}
                </p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button onClick={onClose} className="loom-icon-btn !h-9 !w-9 text-lg leading-none">&times;</button>
          </div>
        </div>

        <div className="relative flex-1 min-h-0">
        <div className="absolute left-2 bottom-2 z-10 flex flex-col gap-1.5">
          <button
            type="button"
            onClick={() => {
              const el = scrollRef.current;
              if (!el) return;
              const bubbles = el.querySelectorAll(".chat-bubble.group\\/msg");
              const scrollTop = el.scrollTop;
              let target: Element | null = null;
              for (let j = bubbles.length - 1; j >= 0; j--) {
                const rect = bubbles[j].getBoundingClientRect();
                const elRect = el.getBoundingClientRect();
                const relTop = rect.top - elRect.top + scrollTop;
                if (relTop < scrollTop - 5) { target = bubbles[j]; break; }
              }
              if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
              else el.scrollTo({ top: 0, behavior: "smooth" });
            }}
            className="chat-nav-btn"
            aria-label="Scroll to previous message"
          >&#9650;</button>
          <button
            type="button"
            onClick={() => { if (scrollRef.current) scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" }); }}
            className="chat-nav-btn"
            aria-label="Scroll to bottom"
          >&#9660;</button>
        </div>
        <div
          ref={scrollRef}
          className="chat-scroll absolute inset-0 overflow-y-auto p-4 space-y-3 overscroll-contain"
        >
          {entries.length === 0 && (
            <p className="text-center text-[var(--text-light)] text-xs mt-6">No messages yet</p>
          )}
          {(() => {
            const rendered: React.ReactNode[] = [];
            let i = 0;
            while (i < entries.length) {
              const entry = entries[i];
              if (entry.role === "user") {
                rendered.push(
                  <div key={i} className="chat-bubble flex justify-end">
                    <div className="max-w-[85%] bg-[var(--accent)] text-white rounded-2xl rounded-br-md px-4 py-2.5 text-[15px] leading-relaxed">
                      <pre className="whitespace-pre-wrap break-words font-sans">{entry.text}</pre>
                    </div>
                  </div>
                );
                i++;
              } else if (entry.role === "tool") {
                const toolStart = i;
                while (i < entries.length && entries[i].role === "tool") i++;
                const toolCount = i - toolStart;
                rendered.push(
                  <details key={`tools-${toolStart}`} className="chat-bubble group/tools">
                    <summary className="cursor-pointer text-[11px] text-[var(--text-light)] font-mono px-1 py-0.5 hover:text-[var(--text-muted)] select-none list-none flex items-center gap-1">
                      <span className="text-[10px] opacity-60 group-open/tools:rotate-90 transition-transform duration-150">&#9654;</span>
                      {toolCount} tool {toolCount === 1 ? "call" : "calls"}
                    </summary>
                    <div className="space-y-0.5 mt-1 ml-3 border-l border-[var(--border)] pl-2">
                      {entries.slice(toolStart, i).map((t, ti) => (
                        <div key={toolStart + ti} className="text-[10px] text-[var(--text-light)] font-mono truncate">
                          {t.text}
                        </div>
                      ))}
                    </div>
                  </details>
                );
              } else {
                rendered.push(
                  <div key={i} className="chat-bubble group/msg">
                    <div className="relative bg-[var(--bg-panel)] border border-[var(--border)] rounded-2xl rounded-bl-md px-4 py-3 text-[15px] leading-relaxed">
                      <button
                        type="button"
                        onClick={(e) => {
                          navigator.clipboard.writeText(entry.text);
                          const btn = e.currentTarget;
                          btn.textContent = "\u2713";
                          btn.style.animation = "none";
                          void btn.offsetHeight;
                          btn.style.animation = "btn-flash 0.4s ease-out";
                          setTimeout(() => { btn.textContent = "\u2398"; btn.style.animation = ""; }, 1200);
                        }}
                        className="absolute top-2 right-2 w-7 h-7 flex items-center justify-center text-[12px] text-[var(--text-light)] hover:text-[var(--text)] bg-[var(--bg-card)] border border-[var(--border)] rounded-md sm:opacity-0 sm:group-hover/msg:opacity-100 transition-all duration-150 active:scale-90"
                        title="Copy"
                      >&#9112;</button>
                      <pre className="whitespace-pre-wrap break-words font-sans text-[var(--text)] pr-8">{entry.text}</pre>
                    </div>
                  </div>
                );
                i++;
              }
            }
            return rendered;
          })()}
          {worker.status === "working" && (
            <div className="chat-bubble flex justify-start">
              <div className="bg-[var(--bg-panel)] border border-[var(--border)] rounded-2xl rounded-bl-md px-4 py-3 flex items-center gap-1">
                {[0, 1, 2].map((i) => (
                  <span
                    key={i}
                    className="w-1.5 h-1.5 rounded-full bg-[var(--text-light)]"
                    style={{ animation: `typing-dot 1.2s ease-in-out ${i * 0.2}s infinite` }}
                  />
                ))}
              </div>
            </div>
          )}
          {stuck && (worker.stuckMessage || worker.currentAction) && (
            <div className="chat-bubble flex justify-start">
              <div className="bg-[rgba(234,179,8,0.08)] border border-[rgba(234,179,8,0.25)] rounded-2xl rounded-bl-md px-4 py-3 text-[15px] leading-relaxed">
                <pre className="whitespace-pre-wrap break-words font-sans text-[#fbbf24]">{worker.stuckMessage || worker.currentAction}</pre>
              </div>
            </div>
          )}
        </div>

        </div>

        {canSend && (
          <div className="border-t border-[var(--border)] bg-[rgba(8,12,24,0.88)] px-4 py-3 shrink-0">
            {stuck && buttons.length > 0 && (
              <div className="flex items-center gap-1.5 mb-2 flex-wrap">
                <span className="text-[10px] text-[#fbbf24] shrink-0">{worker.currentAction}:</span>
                {buttons.map((b) => (
                  <button key={b.value} type="button" onClick={() => onSend(b.value)} className="quick-reply-btn text-[10px] px-2 py-0.5">
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
            <div className="flex gap-2 items-end">
              <textarea
                ref={textareaRef}
                value={draft}
                onChange={(e) => onDraftChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    if (draft.trim()) { const sent = guardedSend(draft.trim()); if (sent) onDraftChange(""); }
                  }
                }}
                onFocus={() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }}
                placeholder="Message agent..."
                rows={1}
                className="chat-input flex-1 min-w-0 !h-[112px] !max-h-[112px] !overflow-y-auto"
              />
              <button
                type="button"
                disabled={!draft.trim()}
                onClick={() => { if (draft.trim()) { const sent = guardedSend(draft.trim()); if (sent) onDraftChange(""); } }}
                className="send-btn"
              >
                Send
              </button>
            </div>
          </div>
        )}
      </div>
  );
}
