"use client";

import { useEffect, useRef } from "react";
import type { ChatEntry, WorkerState } from "@/lib/types";
import { dotColor, DOT_BG, statusLabel, quickButtons } from "./AgentCard";

export function ChatPanel({
  worker, num, entries, draft, onDraftChange, onSend, onClose, onDismiss, expanded, onExpand,
}: {
  worker: WorkerState; num: number; entries: ChatEntry[];
  draft: string; onDraftChange: (v: string) => void;
  onSend: (msg: string) => boolean; onClose: () => void; onDismiss: () => void;
  expanded: boolean; onExpand: (v: boolean) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const touchStartY = useRef<number | null>(null);
  const color = dotColor(worker);
  const canSend = worker.managed || !!worker.tty;
  const stuck = worker.status === "stuck";
  const buttons = stuck ? quickButtons(worker) : [];

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
      <div className="chat-panel flex-1 min-h-0 flex flex-col border-t border-[var(--border)] bg-[var(--bg-card)]">
        <div
          ref={headerRef}
          className="relative flex items-center justify-between px-4 pt-5 pb-4 border-b border-[var(--border)] shrink-0 cursor-grab active:cursor-grabbing touch-none bg-[var(--bg-card)]/95 backdrop-blur-sm"
        >
          <div className="absolute top-1.5 left-1/2 -translate-x-1/2 w-8 h-1 rounded-full bg-[var(--border-light)]" />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: DOT_BG[color] }} />
              <span className="font-semibold text-[15px]">Agent {num}</span>
            </div>
            <p className="text-[11px] text-[var(--text-light)] mt-0.5 ml-[18px]">
              {statusLabel(worker)}
            </p>
          </div>
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-full text-[var(--text-light)] hover:text-[var(--text)] hover:bg-[var(--bg-panel)] text-lg leading-none transition-colors">&times;</button>
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
          <div className="border-t border-[var(--border)] px-3 py-2 shrink-0">
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
            <div className="flex gap-2 items-end">
              <textarea
                ref={textareaRef}
                value={draft}
                onChange={(e) => onDraftChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    if (draft.trim()) { const sent = onSend(draft.trim()); if (sent) onDraftChange(""); }
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
                onClick={() => { if (draft.trim()) { const sent = onSend(draft.trim()); if (sent) onDraftChange(""); } }}
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
