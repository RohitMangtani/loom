"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useHive } from "@/lib/ws";
import { getAuthMode, unlockAdmin, lockAdmin } from "@/components/SitePasswordGate";
import { SpawnDialog } from "@/components/SpawnDialog";
import type { ChatEntry, WorkerState } from "@/lib/types";

const DEFAULT_URL = process.env.NEXT_PUBLIC_WS_URL || "ws://localhost:3002";
const MAX_SLOTS = 4;

/**
 * Fixed 4-slot numbering with slot recycling.
 * Workers get assigned to slots 1-4. When a worker dies, its slot
 * frees up for the next new worker. Workers beyond 4 are ignored.
 */
function useStableNumbering(workers: Map<string, WorkerState>) {
  const assignmentRef = useRef<Map<string, number>>(new Map());

  return useMemo(() => {
    const assignments = assignmentRef.current;

    // Remove workers that no longer exist — frees their slot
    for (const id of assignments.keys()) {
      if (!workers.has(id)) assignments.delete(id);
    }

    // Find which slots (1-4) are currently taken
    const usedSlots = new Set(assignments.values());

    // Sort unassigned workers by startedAt for deterministic ordering
    const sorted = Array.from(workers.values()).sort((a, b) => a.startedAt - b.startedAt);

    for (const w of sorted) {
      if (assignments.has(w.id)) continue; // already has a slot

      // Find the lowest free slot (1-4)
      for (let slot = 1; slot <= MAX_SLOTS; slot++) {
        if (!usedSlots.has(slot)) {
          assignments.set(w.id, slot);
          usedSlots.add(slot);
          break;
        }
      }
      // If all 4 slots taken, this worker is ignored
    }

    // Return assigned workers in slot order
    return sorted
      .filter((w) => assignments.has(w.id))
      .sort((a, b) => assignments.get(a.id)! - assignments.get(b.id)!)
      .map((w) => ({ worker: w, num: assignments.get(w.id)! }));
  }, [workers]);
}

// --- Helpers ---

type DotColor = "green" | "yellow" | "red";

function dotColor(w: WorkerState): DotColor {
  if (w.status === "working") return "green";
  if (w.status === "stuck") return "yellow";
  return "red";
}

const DOT_BG: Record<DotColor, string> = {
  green: "var(--dot-active)",
  yellow: "var(--dot-needs)",
  red: "var(--dot-offline)",
};

function statusLabel(w: WorkerState): string {
  if (w.status === "stuck") return w.currentAction || "Needs input";
  if (w.status === "working") return w.currentAction || "Working...";
  return w.lastAction || "Idle";
}

function statusWord(w: WorkerState): string {
  if (w.status === "working") return "Active";
  if (w.status === "stuck") return "Waiting";
  return "Idle";
}

function uptime(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function badgeStyle(color: DotColor) {
  const map = {
    green: { background: "rgba(34,197,94,0.12)", color: "#4ade80" },
    yellow: { background: "rgba(234,179,8,0.12)", color: "#fbbf24" },
    red: { background: "rgba(220,38,38,0.12)", color: "#f87171" },
  };
  return map[color];
}

/**
 * Parse quick-reply buttons from the worker state.
 * Priority: parse real options from stuckMessage > infer from currentAction > fallback
 */
function quickButtons(w: WorkerState): { label: string; value: string }[] {
  const msg = w.stuckMessage || "";
  const reason = (w.currentAction || "").toLowerCase();

  // Permission prompts — always y/n
  if (reason.includes("permission")) {
    return [{ label: "Allow", value: "y" }, { label: "Deny", value: "n" }];
  }

  // Parse numbered options from the message: "1. Option A" or "1 for yes" or "(1) Yes"
  const numbered = msg.match(/(?:^|\n)\s*(?:\(?(\d)[.)]\s*|(\d)\s+(?:for|[-:])\s+)(.+)/gim);
  if (numbered && numbered.length >= 2) {
    return numbered.slice(0, 4).map((line) => {
      const m = line.match(/(\d)/);
      const num = m ? m[1] : "1";
      const labelPart = line.replace(/^\s*\(?(\d)[.)]\s*/, "").replace(/^\s*(\d)\s+(?:for|[-:])\s+/i, "").trim();
      const label = labelPart.length > 20 ? `${num}` : labelPart || num;
      return { label, value: num };
    });
  }

  // Parse "yes/no", "y/n" style prompts
  if (msg.match(/\b(y\/n|yes\/no)\b/i) || reason.includes("proceed") || reason.includes("approve") || reason.includes("plan")) {
    return [{ label: "Yes", value: "y" }, { label: "No", value: "n" }];
  }

  // Fallback: numbered buttons 1-4
  return [{ label: "1", value: "1" }, { label: "2", value: "2" }, { label: "3", value: "3" }, { label: "4", value: "4" }];
}

// --- Agent Card ---

function AgentCard({
  worker, num, selected, onClick, onSend,
}: {
  worker: WorkerState; num: number; selected: boolean; onClick: () => void; onSend: (msg: string) => void;
}) {
  const color = dotColor(worker);
  const stuck = color === "yellow";
  const buttons = stuck ? quickButtons(worker) : [];

  const idle = color === "red";

  return (
    <div
      onClick={onClick}
      className={`card relative ${stuck ? "card-stuck" : ""} ${selected ? "card-selected" : ""}`}
      style={{ borderLeftColor: DOT_BG[color] }}
    >
      {/* Row 1: number + status */}
      <div className="flex items-center gap-2.5 mb-1.5">
        <span className="text-lg font-bold tabular-nums text-[var(--text)]">{num}</span>
        <span
          className={`w-2 h-2 rounded-full shrink-0 ${stuck ? "animate-pulse" : ""}`}
          style={{ background: DOT_BG[color] }}
        />
        <span className="text-[10px] font-medium px-1.5 py-px rounded ml-auto" style={badgeStyle(color)}>
          {statusWord(worker)}
        </span>
      </div>

      {/* Row 2: project name */}
      <p className="text-[10px] text-[var(--text-light)] truncate mb-0.5">{worker.projectName}</p>

      {/* Row 3: current action or stuck prompt */}
      <p className={`text-[11px] leading-tight ${stuck ? "text-[#fbbf24] font-medium" : "text-[var(--text-muted)] truncate"}`}>
        {stuck && worker.stuckMessage
          ? <span className="line-clamp-2">{worker.stuckMessage.split("\n")[0].slice(0, 80)}</span>
          : statusLabel(worker)}
      </p>

      {/* Quick reply buttons for stuck agents */}
      {stuck && (worker.managed || !!worker.tty) && buttons.length > 0 && (
        <div className="flex items-center gap-1 mt-2 flex-wrap" onClick={(e) => e.stopPropagation()}>
          {buttons.map((b) => (
            <button
              key={b.value}
              type="button"
              onClick={(e) => { e.stopPropagation(); onSend(b.value); }}
              className="quick-reply-btn"
            >
              {b.label}
            </button>
          ))}
        </div>
      )}

      {/* Idle overlay — "READY" watermark */}
      {idle && (
        <div className="ready-overlay absolute inset-0 flex items-center justify-center pointer-events-none rounded-[10px]">
          <span className="text-4xl font-bold tracking-[0.25em] uppercase text-white opacity-[0.16]">
            READY
          </span>
        </div>
      )}
    </div>
  );
}

// --- Chat Panel ---

function ChatPanel({
  worker, num, entries, draft, onDraftChange, onSend, onClose,
}: {
  worker: WorkerState; num: number; entries: ChatEntry[];
  draft: string; onDraftChange: (v: string) => void;
  onSend: (msg: string) => boolean; onClose: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const color = dotColor(worker);
  const canSend = worker.managed || !!worker.tty;
  const stuck = worker.status === "stuck";
  const buttons = stuck ? quickButtons(worker) : [];

  // Auto-scroll to bottom on mount and on new messages
  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      // requestAnimationFrame ensures DOM has painted (especially on first mount)
      requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
    }
  }, [entries.length]);

  // Auto-resize textarea to fit content
  const autoResize = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    const maxH = window.innerHeight * 0.3; // 30vh max
    ta.style.height = `${Math.min(ta.scrollHeight, maxH)}px`;
    ta.style.overflowY = ta.scrollHeight > maxH ? "auto" : "hidden";
  }, []);

  useEffect(() => { autoResize(); }, [draft, autoResize]);

  // Refocus textarea when returning to the app (visibility change)
  useEffect(() => {
    const handler = () => {
      if (document.visibilityState === "visible" && textareaRef.current) {
        // Small delay lets the browser settle after app switch
        setTimeout(() => textareaRef.current?.focus(), 100);
      }
    };
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  }, []);

  return (
      <div className="chat-panel flex-1 min-h-0 flex flex-col border-t border-[var(--border)] bg-[var(--bg-card)]">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)] shrink-0">
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

        {/* Messages */}
        <div className="relative flex-1 min-h-0">
        <div
          ref={scrollRef}
          className="chat-scroll absolute inset-0 overflow-y-auto p-4 space-y-3 overscroll-contain"
          onTouchMove={() => {
            const el = document.activeElement as HTMLElement | null;
            if (el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT")) el.blur();
          }}
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
                        onClick={() => {
                          navigator.clipboard.writeText(entry.text);
                          const btn = document.getElementById(`copy-${i}`);
                          if (btn) { btn.textContent = "\u2713"; setTimeout(() => { btn.textContent = "\u2398"; }, 1200); }
                        }}
                        id={`copy-${i}`}
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

        {/* Input area */}
        {canSend && (
          <div className="border-t border-[var(--border)] p-3 shrink-0">
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
            <div className="flex gap-2 items-stretch">
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
                rows={3}
                className="chat-input flex-1 min-w-0"
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

// --- Main Page ---

export default function Home() {
  const [daemonUrl, setDaemonUrl] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<"admin" | "viewer">("viewer");
  const [showUnlock, setShowUnlock] = useState(false);
  const [tokenInput, setTokenInput] = useState("");
  const [showSpawn, setShowSpawn] = useState(false);
  // Per-agent draft text — persists in localStorage (survives browser close/refresh).
  // Only cleared when user presses X to close the chat popover.
  const draftsRef = useRef<Map<string, string>>(new Map());
  const [draftKey, setDraftKey] = useState(0); // force re-render on draft changes

  // Load drafts from localStorage on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem("hive_drafts");
      if (saved) {
        const parsed = JSON.parse(saved) as Record<string, string>;
        for (const [k, v] of Object.entries(parsed)) {
          if (v) draftsRef.current.set(k, v);
        }
        setDraftKey((k) => k + 1);
      }
    } catch { /* corrupted storage, start fresh */ }
  }, []);
  const isViewer = mode === "viewer";

  useEffect(() => {
    const stored = localStorage.getItem("hive_daemon_url");
    const url = stored || DEFAULT_URL;
    setDaemonUrl(url);
    setMode(getAuthMode());
    // Restore selected agent from session storage (survives tab close/reopen)
    const savedAgent = sessionStorage.getItem("hive_selected_agent");
    if (savedAgent) setSelectedId(savedAgent);
  }, []);

  const { connected, workers, chatEntries, send, subscribeTo, addOptimisticEntry } = useHive(daemonUrl);

  // Re-subscribe to restored agent once WebSocket connects
  const restoredRef = useRef(false);
  useEffect(() => {
    if (connected && selectedId && !restoredRef.current) {
      restoredRef.current = true;
      subscribeTo(selectedId);
    }
  }, [connected, selectedId, subscribeTo]);

  // Persist selected agent across page reloads
  useEffect(() => {
    if (selectedId) sessionStorage.setItem("hive_selected_agent", selectedId);
    else sessionStorage.removeItem("hive_selected_agent");
  }, [selectedId]);

  const numbered = useStableNumbering(workers);
  const activeCount = numbered.filter(({ worker: w }) => w.status === "working").length;
  const stuckCount = numbered.filter(({ worker: w }) => w.status === "stuck").length;
  const idleCount = numbered.filter(({ worker: w }) => w.status === "idle").length;
  const emptyCount = MAX_SLOTS - numbered.length;
  const selectedEntry = selectedId ? numbered.find(({ worker: w }) => w.id === selectedId) : null;

  const toggleSelect = useCallback((id: string) => {
    const nextId = selectedId === id ? null : id;
    setSelectedId(nextId);
    subscribeTo(nextId);
  }, [selectedId, subscribeTo]);

  return (
    <div className="h-dvh flex flex-col overflow-hidden bg-[var(--bg)]">
      {/* Header — fixed height */}
      <header className="shrink-0 px-4 sm:px-6 pt-4 pb-3">
        <div className="text-center relative">
          <h1 className="text-sm font-bold tracking-[0.18em] uppercase text-[var(--text)]">Hive</h1>
          <div className="flex items-center justify-center gap-1.5 mt-1">
            <span className={`w-1.5 h-1.5 rounded-full ${connected ? "bg-[var(--dot-active)]" : "bg-[var(--dot-offline)]"}`} />
            <span className="text-[10px] text-[var(--text-light)]">
              {connected ? (isViewer ? "Viewing" : "Connected") : "Reconnecting..."}
            </span>
          </div>
          {/* Unlock / Lock button — top right */}
          {isViewer ? (
            <button
              type="button"
              onClick={() => setShowUnlock(true)}
              className="absolute right-0 top-0 text-[10px] text-[var(--text-light)] hover:text-[var(--text)] transition-colors px-2 py-1 cursor-pointer"
              title="Enter admin token"
            >
              &#128274;
            </button>
          ) : (
            <button
              type="button"
              onClick={() => { lockAdmin(); setMode("viewer"); window.location.reload(); }}
              className="absolute right-0 top-0 text-[10px] text-[var(--text-light)] hover:text-[var(--text)] transition-colors px-2 py-1 cursor-pointer"
              title="Lock (return to view-only)"
            >
              &#128275;
            </button>
          )}
        </div>

        {/* Inline unlock prompt */}
        {showUnlock && (
          <div className="flex items-center justify-center gap-2 mt-2">
            <input
              type="password"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && tokenInput.trim()) {
                  unlockAdmin(tokenInput.trim());
                  setShowUnlock(false);
                  setTokenInput("");
                  window.location.reload();
                }
              }}
              placeholder="Paste admin token"
              className="px-3 py-1.5 bg-transparent border border-[var(--border)] rounded text-xs text-[var(--text)] font-mono w-48 outline-none focus:border-[var(--text-light)]"
              autoFocus
            />
            <button
              type="button"
              onClick={() => {
                if (tokenInput.trim()) {
                  unlockAdmin(tokenInput.trim());
                  setShowUnlock(false);
                  setTokenInput("");
                  window.location.reload();
                }
              }}
              className="text-xs text-[var(--text-light)] hover:text-[var(--text)] px-2 py-1 cursor-pointer"
            >
              Unlock
            </button>
            <button
              type="button"
              onClick={() => { setShowUnlock(false); setTokenInput(""); }}
              className="text-xs text-[var(--text-light)] hover:text-[var(--text)] px-1 cursor-pointer"
            >
              &times;
            </button>
          </div>
        )}

        {/* Summary counts */}
        <div className="flex items-center justify-center gap-3 mt-2 text-[10px] text-[var(--text-light)]">
          {activeCount > 0 && <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-[var(--dot-active)]" />{activeCount} active</span>}
          {stuckCount > 0 && <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-[var(--dot-needs)]" />{stuckCount} waiting</span>}
          {idleCount > 0 && <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-[var(--dot-offline)]" />{idleCount} idle</span>}
          {emptyCount > 0 && <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-[var(--border)]" />{emptyCount} offline</span>}
        </div>
      </header>

      {/* Body — 2×2 grid, shrinks when chat is open */}
      <div className={`min-h-0 grid grid-cols-2 grid-rows-2 gap-3 p-4 sm:p-6 transition-all duration-300 ease-[cubic-bezier(0.25,0.46,0.45,0.94)] ${!isViewer && selectedEntry ? "shrink-0 basis-[40%]" : "flex-1"}`}>
        {Array.from({ length: MAX_SLOTS }, (_, i) => i + 1).map((slot) => {
          const entry = numbered.find(({ num }) => num === slot);
          if (!entry) {
            return (
              <div
                key={slot}
                className={`card relative flex items-center justify-center ${isViewer ? "opacity-40" : "opacity-40 hover:opacity-60 cursor-pointer transition-opacity"}`}
                style={{ borderLeftColor: "var(--border)" }}
                onClick={isViewer ? undefined : () => setShowSpawn(true)}
              >
                <div className="flex items-center gap-2.5 absolute top-3 left-3">
                  <span className="text-lg font-bold tabular-nums text-[var(--text-light)]">{slot}</span>
                  <span className="w-2 h-2 rounded-full shrink-0 bg-[var(--border)]" />
                </div>
                <span className="text-4xl font-bold tracking-[0.25em] uppercase text-white opacity-[0.16]">
                  OFFLINE
                </span>
                {!isViewer && (
                  <span className="absolute bottom-3 text-[10px] text-[var(--text-muted)]">Click to spawn</span>
                )}
              </div>
            );
          }
          const { worker: w, num } = entry;
          return (
            <AgentCard
              key={w.id}
              worker={w}
              num={num}
              selected={!isViewer && selectedId === w.id}
              onClick={isViewer ? () => {} : () => toggleSelect(w.id)}
              onSend={isViewer ? () => {} : (msg) => send({ type: "message", workerId: w.id, content: msg })}
            />
          );
        })}
      </div>

      {/* Inline chat panel — admin only */}
      {!isViewer && selectedEntry && (
        <ChatPanel
          key={selectedEntry.worker.id}
          worker={selectedEntry.worker}
          num={selectedEntry.num}
          entries={chatEntries.get(selectedEntry.worker.id) ?? []}
          draft={draftsRef.current.get(selectedEntry.worker.id) || ""}
          onDraftChange={(v) => {
            draftsRef.current.set(selectedEntry.worker.id, v);
            setDraftKey((k) => k + 1);
            try {
              const obj = Object.fromEntries(draftsRef.current);
              localStorage.setItem("hive_drafts", JSON.stringify(obj));
            } catch { /* quota exceeded, non-critical */ }
          }}
          onSend={(msg) => {
            const ok = send({ type: "message", workerId: selectedEntry.worker.id, content: msg });
            if (ok) {
              addOptimisticEntry(selectedEntry.worker.id, msg);
            }
            return ok;
          }}
          onClose={() => {
            // X button: clear draft and close — only action that removes draft
            draftsRef.current.delete(selectedEntry.worker.id);
            try {
              const obj = Object.fromEntries(draftsRef.current);
              localStorage.setItem("hive_drafts", JSON.stringify(obj));
            } catch { /* non-critical */ }
            setSelectedId(null);
            subscribeTo(null);
          }}
        />
      )}

      {/* Spawn dialog — admin only */}
      {showSpawn && (
        <SpawnDialog
          onSpawn={(project, task) => {
            send({ type: "spawn", project, task });
            setShowSpawn(false);
          }}
          onClose={() => setShowSpawn(false)}
        />
      )}
    </div>
  );
}
