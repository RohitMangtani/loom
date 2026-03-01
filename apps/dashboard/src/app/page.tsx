"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useHive } from "@/lib/ws";
import { getAuthMode, getStoredToken, unlockAdmin, lockAdmin } from "@/components/SitePasswordGate";
import type { ChatEntry, WorkerState } from "@/lib/types";

const DEFAULT_URL = process.env.NEXT_PUBLIC_WS_URL || "ws://localhost:3002";

/**
 * Stable sequential numbering: once an agent gets a number, it keeps it.
 * Numbers are assigned in order of first appearance (startedAt).
 * Ordering never changes even if statuses change.
 */
function useStableNumbering(workers: Map<string, WorkerState>) {
  const assignmentRef = useRef<Map<string, number>>(new Map());
  const nextNumRef = useRef(1);

  return useMemo(() => {
    const assignments = assignmentRef.current;

    // Sort new workers by startedAt so numbering is deterministic
    const sorted = Array.from(workers.values()).sort((a, b) => a.startedAt - b.startedAt);

    // Assign numbers to any new workers
    for (const w of sorted) {
      if (!assignments.has(w.id)) {
        assignments.set(w.id, nextNumRef.current++);
      }
    }

    // Remove workers that no longer exist
    for (const id of assignments.keys()) {
      if (!workers.has(id)) assignments.delete(id);
    }

    // Return workers in stable number order
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

  return (
    <div
      onClick={onClick}
      className={`card ${stuck ? "card-stuck" : ""} ${selected ? "card-selected" : ""}`}
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

      {/* Row 2: current action or stuck prompt */}
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
    </div>
  );
}

// --- Chat Popover ---

function ChatPopover({
  worker, num, entries, draft, onDraftChange, onSend, onDismiss, onClose,
}: {
  worker: WorkerState; num: number; entries: ChatEntry[];
  draft: string; onDraftChange: (v: string) => void;
  onSend: (msg: string) => void; onDismiss: () => void; onClose: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [kbOffset, setKbOffset] = useState(0);
  const color = dotColor(worker);
  const canSend = worker.managed || !!worker.tty;
  const stuck = worker.status === "stuck";
  const buttons = stuck ? quickButtons(worker) : [];

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [entries.length]);

  // Push popover above iOS virtual keyboard
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      const offset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      setKbOffset(offset);
      if (offset > 0 && scrollRef.current) {
        requestAnimationFrame(() => {
          if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        });
      }
    };
    vv.addEventListener("resize", update);
    return () => vv.removeEventListener("resize", update);
  }, []);

  return (
    <>
      {/* Mobile backdrop — soft dismiss (keeps draft) */}
      <div className="fixed inset-0 bg-black/40 z-40 sm:hidden" onClick={onDismiss} />

      {/* Popover card */}
      <div
        className="chat-popover fixed z-50 flex flex-col bg-[var(--bg-card)] border border-[var(--border)] shadow-2xl bottom-0 left-0 right-0 h-[60vh] rounded-t-2xl sm:bottom-4 sm:right-4 sm:left-auto sm:w-[360px] sm:h-[480px] sm:rounded-2xl"
        style={kbOffset > 0 ? { bottom: `${kbOffset}px`, height: `calc(100dvh - ${kbOffset}px - 40px)` } : undefined}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)] shrink-0">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full shrink-0" style={{ background: DOT_BG[color] }} />
              <span className="font-semibold text-sm">Agent {num}</span>
            </div>
            <p className="text-[10px] text-[var(--text-light)] mt-0.5">
              {statusLabel(worker)}
            </p>
          </div>
          <button onClick={onClose} className="text-[var(--text-light)] hover:text-[var(--text)] text-lg p-1 leading-none">&times;</button>
        </div>

        {/* Messages */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-1.5 min-h-0">
          {entries.length === 0 && (
            <p className="text-center text-[var(--text-light)] text-xs mt-6">No messages yet</p>
          )}
          {entries.map((entry, i) => {
            if (entry.role === "user") {
              return (
                <div key={i} className="flex justify-end">
                  <div className="max-w-[80%] bg-blue-600/80 text-white rounded-lg px-2.5 py-1.5 text-[11px]">
                    <pre className="whitespace-pre-wrap break-words font-sans">{entry.text}</pre>
                  </div>
                </div>
              );
            }
            if (entry.role === "tool") {
              return (
                <div key={i} className="flex justify-start">
                  <div className="max-w-[80%] bg-[var(--bg-panel)] rounded px-2.5 py-1 text-[10px] text-[var(--text-light)] font-mono truncate">
                    {entry.text}
                  </div>
                </div>
              );
            }
            return (
              <div key={i} className="flex justify-start">
                <div className="max-w-[80%] bg-[var(--bg-panel)] border border-[var(--border)] rounded-lg px-2.5 py-1.5 text-[11px]">
                  <pre className="whitespace-pre-wrap break-words font-sans text-[var(--text)]">{entry.text}</pre>
                </div>
              </div>
            );
          })}
          {/* Show stuck prompt at bottom of chat so user sees what's being asked */}
          {stuck && (worker.stuckMessage || worker.currentAction) && (
            <div className="flex justify-start">
              <div className="max-w-[90%] bg-[rgba(234,179,8,0.1)] border border-[rgba(234,179,8,0.3)] rounded-lg px-3 py-2 text-[11px]">
                <pre className="whitespace-pre-wrap break-words font-sans text-[#fbbf24]">{worker.stuckMessage || worker.currentAction}</pre>
              </div>
            </div>
          )}
        </div>

        {/* Input area */}
        {canSend && (
          <div className="border-t border-[var(--border)] p-3 shrink-0">
            {stuck && buttons.length > 0 && (
              <div className="flex items-center gap-1.5 mb-2">
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
                value={draft}
                onChange={(e) => onDraftChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    if (draft.trim()) { onSend(draft.trim()); onDraftChange(""); }
                  }
                }}
                onFocus={() => setTimeout(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }, 350)}
                placeholder="Type a response..."
                rows={2}
                className="flex-1 min-w-0 bg-[var(--bg-panel)] border border-[var(--border)] rounded-lg px-3 py-2 text-base sm:text-xs outline-none focus:border-[var(--text-light)] resize-none leading-relaxed"
              />
              <button
                type="button"
                onClick={() => { if (draft.trim()) { onSend(draft.trim()); onDraftChange(""); } }}
                className="px-3 py-2 rounded-lg bg-[var(--text-light)] text-[var(--bg)] text-xs font-medium hover:bg-[var(--text-muted)] transition-colors shrink-0"
              >
                Send
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

// --- Main Page ---

export default function Home() {
  const [daemonUrl, setDaemonUrl] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<"admin" | "viewer">("viewer");
  const [showUnlock, setShowUnlock] = useState(false);
  const [tokenInput, setTokenInput] = useState("");
  // Per-agent draft text — persists when collapsing the popover, cleared on X
  const draftsRef = useRef<Map<string, string>>(new Map());
  const [draftKey, setDraftKey] = useState(0); // force re-render on draft changes
  const isViewer = mode === "viewer";

  useEffect(() => {
    const stored = localStorage.getItem("hive_daemon_url");
    const url = stored || DEFAULT_URL;
    setDaemonUrl(url);
    setMode(getAuthMode());
  }, []);

  const { connected, workers, chatEntries, send, subscribeTo } = useHive(daemonUrl);

  const numbered = useStableNumbering(workers);
  const activeCount = numbered.filter(({ worker: w }) => w.status === "working").length;
  const stuckCount = numbered.filter(({ worker: w }) => w.status === "stuck").length;
  const idleCount = numbered.length - activeCount - stuckCount;
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
          <h1 className="text-sm font-bold tracking-[0.18em] uppercase text-[var(--text)]">Find My Agents</h1>
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
          {numbered.length === 0 ? (
            <span>No agents</span>
          ) : (
            <>
              {activeCount > 0 && <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-[var(--dot-active)]" />{activeCount} active</span>}
              {stuckCount > 0 && <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-[var(--dot-needs)]" />{stuckCount} waiting</span>}
              {idleCount > 0 && <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-[var(--dot-offline)]" />{idleCount} idle</span>}
            </>
          )}
        </div>
      </header>

      {/* Body — fixed 2×2 quadrant grid filling available space */}
      <div className="flex-1 min-h-0 grid grid-cols-2 grid-rows-2 gap-3 p-4 sm:p-6">
        {[1, 2, 3, 4].map((slot) => {
          const entry = numbered.find(({ num }) => num === slot);
          if (!entry) {
            return (
              <div key={slot} className="card flex items-center justify-center opacity-30" style={{ borderLeftColor: "var(--border)" }}>
                <span className="text-2xl font-bold tabular-nums text-[var(--text-light)]">{slot}</span>
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

      {/* Floating chat popover — admin only */}
      {!isViewer && selectedEntry && (
        <ChatPopover
          worker={selectedEntry.worker}
          num={selectedEntry.num}
          entries={chatEntries.get(selectedEntry.worker.id) ?? []}
          draft={draftsRef.current.get(selectedEntry.worker.id) || ""}
          onDraftChange={(v) => { draftsRef.current.set(selectedEntry.worker.id, v); setDraftKey((k) => k + 1); }}
          onSend={(msg) => send({ type: "message", workerId: selectedEntry.worker.id, content: msg })}
          onDismiss={() => {
            // Tap away: keep draft, just collapse
            setSelectedId(null);
            subscribeTo(null);
          }}
          onClose={() => {
            // X button: clear draft and close
            draftsRef.current.delete(selectedEntry.worker.id);
            setSelectedId(null);
            subscribeTo(null);
          }}
        />
      )}
    </div>
  );
}
