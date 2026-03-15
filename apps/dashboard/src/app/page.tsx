"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useHive } from "@/lib/ws";
import { getAuthMode, unlockAdmin, lockAdmin } from "@/components/SitePasswordGate";
import { AgentCard } from "@/components/AgentCard";
import { ChatPanel } from "@/components/ChatPanel";
import { ReviewDrawer } from "@/components/ReviewDrawer";
import { SpawnDialog } from "@/components/SpawnDialog";
import type { WorkerState } from "@/lib/types";
import { usePushSubscription } from "@/components/ServiceWorker";

const DEFAULT_URL = process.env.NEXT_PUBLIC_WS_URL || "ws://localhost:3002";
const MAX_SLOTS = 8;

/** Vertical stack: 1 column, agents stacked top-to-bottom matching terminal layout */
const GRID_CLASSES: Record<number, string> = {
  0: "grid-cols-1",
  1: "grid-cols-1",
  2: "grid-cols-1",
  3: "grid-cols-1",
  4: "grid-cols-1",
  5: "grid-cols-1",
  6: "grid-cols-1",
  7: "grid-cols-1",
  8: "grid-cols-1",
};

interface LastKnown {
  project: string;
  projectName: string;
  model: string;
}

function loadLastKnown(): Record<number, LastKnown> {
  try {
    const saved = localStorage.getItem("hive_last_known");
    return saved ? JSON.parse(saved) : {};
  } catch { return {}; }
}

function saveLastKnown(data: Record<number, LastKnown>) {
  try { localStorage.setItem("hive_last_known", JSON.stringify(data)); } catch { /* non-critical */ }
}

/**
 * Use server-provided quadrant assignments (single source of truth from daemon).
 * Falls back to startedAt sorting only if server hasn't assigned quadrants yet.
 */
function useStableNumbering(workers: Map<string, WorkerState>) {
  const fallbackRef = useRef<Map<string, number>>(new Map());

  return useMemo(() => {
    const sorted = Array.from(workers.values()).sort((a, b) => a.startedAt - b.startedAt);

    // If server provides quadrant assignments, use them directly
    const hasServerQuadrants = sorted.some((w) => w.quadrant != null);
    if (hasServerQuadrants) {
      return sorted
        .filter((w) => w.quadrant != null && w.quadrant >= 1 && w.quadrant <= MAX_SLOTS)
        .sort((a, b) => a.quadrant! - b.quadrant!)
        .map((w) => ({ worker: w, num: w.quadrant! }));
    }

    // Fallback: client-side assignment (only before first server broadcast with quadrants)
    const assignments = fallbackRef.current;
    for (const id of assignments.keys()) {
      if (!workers.has(id)) assignments.delete(id);
    }
    const usedSlots = new Set(assignments.values());
    for (const w of sorted) {
      if (assignments.has(w.id)) continue;
      for (let slot = 1; slot <= MAX_SLOTS; slot++) {
        if (!usedSlots.has(slot)) {
          assignments.set(w.id, slot);
          usedSlots.add(slot);
          break;
        }
      }
    }
    return sorted
      .filter((w) => assignments.has(w.id))
      .sort((a, b) => assignments.get(a.id)! - assignments.get(b.id)!)
      .map((w) => ({ worker: w, num: assignments.get(w.id)! }));
  }, [workers]);
}

export default function Home() {
  const [daemonUrl, setDaemonUrl] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<"admin" | "viewer">("viewer");
  const [showUnlock, setShowUnlock] = useState(false);
  const [tokenInput, setTokenInput] = useState("");
  const [chatExpanded, setChatExpanded] = useState(false);
  const draftsRef = useRef<Map<string, string>>(new Map());
  const [, setDraftTick] = useState(0);
  const [flaggedIds, setFlaggedIds] = useState<Set<string>>(new Set());
  const previewUrlsRef = useRef<Map<string, string>>(new Map());
  const [showReviews, setShowReviews] = useState(false);
  const [managing, setManaging] = useState(false);
  const [showSpawnDialog, setShowSpawnDialog] = useState(false);

  useEffect(() => {
    try {
      const saved = localStorage.getItem("hive_drafts");
      if (saved) {
        const parsed = JSON.parse(saved) as Record<string, string>;
        for (const [k, v] of Object.entries(parsed)) {
          if (v) draftsRef.current.set(k, v);
        }
        setDraftTick((k) => k + 1);
      }
    } catch { /* corrupted storage, start fresh */ }
    try {
      const savedFlags = localStorage.getItem("hive_flags");
      if (savedFlags) setFlaggedIds(new Set(JSON.parse(savedFlags)));
    } catch { /* start fresh */ }
    try {
      const savedPreviews = localStorage.getItem("hive_preview_urls");
      if (savedPreviews) {
        const parsed = JSON.parse(savedPreviews) as Record<string, string>;
        for (const [k, v] of Object.entries(parsed)) {
          if (v) previewUrlsRef.current.set(k, v);
        }
      }
    } catch { /* start fresh */ }
  }, []);
  const isViewer = mode === "viewer";

  const toggleFlag = useCallback((id: string) => {
    setFlaggedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      try { localStorage.setItem("hive_flags", JSON.stringify([...next])); } catch { /* non-critical */ }
      return next;
    });
  }, []);

  useEffect(() => {
    const stored = localStorage.getItem("hive_daemon_url");
    const url = stored || DEFAULT_URL;
    setDaemonUrl(url);
    setMode(getAuthMode());
    const savedAgent = sessionStorage.getItem("hive_selected_agent");
    if (savedAgent) setSelectedId(savedAgent);
  }, []);

  const { connected, workers, chatEntries, send, subscribeTo, addOptimisticEntry, isAdmin, reconnect, reviews, markReviewSeen, dismissReview, markAllReviewsSeen, clearAllReviews, models, vapidKey } = useHive(daemonUrl);
  usePushSubscription(send, vapidKey);
  const [authError, setAuthError] = useState(false);

  useEffect(() => {
    if (isAdmin === true && mode === "viewer") {
      setMode("admin");
    } else if (isAdmin === false && mode === "admin") {
      lockAdmin();
      setMode("viewer");
      setAuthError(true);
      setTimeout(() => setAuthError(false), 3000);
    } else if (isAdmin === false && localStorage.getItem("hive_token")) {
      lockAdmin();
      setAuthError(true);
      setTimeout(() => setAuthError(false), 3000);
    }
  }, [isAdmin, mode]);

  const restoredRef = useRef(false);
  useEffect(() => {
    if (connected && selectedId && !restoredRef.current) {
      restoredRef.current = true;
      subscribeTo(selectedId);
    }
  }, [connected, selectedId, subscribeTo]);

  useEffect(() => {
    if (selectedId) sessionStorage.setItem("hive_selected_agent", selectedId);
    else sessionStorage.removeItem("hive_selected_agent");
  }, [selectedId]);

  const numbered = useStableNumbering(workers);


  const activeCount = numbered.filter(({ worker: w }) => w.status === "working").length;
  const stuckCount = numbered.filter(({ worker: w }) => w.status === "stuck").length;
  const idleCount = numbered.filter(({ worker: w }) => w.status === "idle").length;
  const emptyCount = MAX_SLOTS - numbered.length;
  const unseenReviewCount = reviews.filter((r) => !r.seen).length;
  const selectedEntry = selectedId ? numbered.find(({ worker: w }) => w.id === selectedId) : null;

  const rawEntries = selectedEntry ? chatEntries.get(selectedEntry.worker.id) : undefined;
  const memoEntries = useMemo(() => (rawEntries ?? []).slice(-200), [rawEntries]);

  // When selected worker disappears (placeholder→discovered transition),
  // find the replacement by matching TTY or quadrant and auto-reselect.
  const prevSelectedRef = useRef<WorkerState | null>(null);
  useEffect(() => {
    if (selectedId && !selectedEntry) {
      const prev = prevSelectedRef.current;
      if (prev) {
        // Find a new worker on the same TTY or same quadrant
        const replacement = numbered.find(({ worker: w }) =>
          w.id !== selectedId && (
            (prev.tty && w.tty === prev.tty) ||
            (prev.quadrant && w.quadrant === prev.quadrant)
          )
        );
        if (replacement) {
          setSelectedId(replacement.worker.id);
          subscribeTo(replacement.worker.id);
          return;
        }
      }
      setSelectedId(null);
      subscribeTo(null);
    }
  }, [selectedId, selectedEntry, numbered, subscribeTo]);

  // Track the last selected worker for transition matching
  useEffect(() => {
    if (selectedEntry) {
      prevSelectedRef.current = selectedEntry.worker;
    }
  }, [selectedEntry]);

  // Auto-exit manage mode when no agents remain
  useEffect(() => {
    if (managing && numbered.length === 0) setManaging(false);
  }, [managing, numbered.length]);

  const toggleSelect = useCallback((id: string) => {
    const nextId = selectedId === id ? null : id;
    setChatExpanded(false);
    setSelectedId(nextId);
    subscribeTo(nextId);
  }, [selectedId, subscribeTo]);

  return (
    <div className="loom-root h-dvh flex flex-col overflow-hidden relative">
      <header
        className={`shrink-0 px-4 sm:px-6 pt-4 pb-3 transition-[background-color] duration-500 ease-in-out ${chatExpanded ? "bg-[rgba(255,255,255,0.06)] cursor-pointer" : ""}`}
        onClick={() => { if (chatExpanded) { setChatExpanded(false); } }}
      >
        <div className={`loom-header-shell ${chatExpanded ? "loom-header-shell-active" : ""}`}>
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              {isViewer ? (
                <button
                  type="button"
                  onClick={() => setShowUnlock(true)}
                  className="loom-icon-btn"
                  title="Enter admin token"
                >
                  &#128274;
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => { if (window.confirm("Log out of admin?")) { lockAdmin(); setMode("viewer"); reconnect(); } }}
                  className="loom-icon-btn"
                  title="Lock (return to view-only)"
                >
                  &#128275;
                </button>
              )}
              <span className="loom-mini-pill">{isViewer ? "Viewer" : "Admin"}</span>
              <span className="loom-mini-pill">{numbered.length}/{MAX_SLOTS} live</span>
            </div>

            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setShowReviews(true); }}
              className="loom-icon-btn relative"
              title="Recent changes"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
                <rect x="1" y="2" width="12" height="1.5" rx="0.75" fill="currentColor" />
                <rect x="1" y="6.25" width="12" height="1.5" rx="0.75" fill="currentColor" />
                <rect x="1" y="10.5" width="12" height="1.5" rx="0.75" fill="currentColor" />
              </svg>
              {unseenReviewCount > 0 && (
                <span className="absolute -top-1 -right-1 h-2.5 w-2.5 rounded-full bg-[var(--accent-green)] ring-2 ring-[var(--bg)]" />
              )}
            </button>
          </div>

          <div className="mt-5 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div className="min-w-0">
              <div className="loom-eyebrow">LOOM COMMAND DECK</div>
              <h1 className="loom-title">One stack. Live state. Human steering.</h1>
              <p className="loom-subtitle">
                Mirror terminal order, spot blockers instantly, and route work without rereading a wall of logs.
              </p>
            </div>

            <div className="loom-connection-pill">
              <span className={`h-2.5 w-2.5 rounded-full ${connected ? "bg-[var(--dot-active)]" : "bg-[var(--dot-offline)]"}`} />
              <div className="min-w-0">
                <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--text-light)]">
                  {connected ? (isViewer ? "Viewing" : "Connected") : "Reconnecting"}
                </p>
                <p className="text-sm font-medium text-[var(--text)]">
                  {selectedEntry ? `Q${selectedEntry.num} ready to steer` : "Stack mirrored 1:1"}
                </p>
              </div>
            </div>
          </div>

          {showUnlock && (
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <input
                type="password"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && tokenInput.trim()) {
                    unlockAdmin(tokenInput.trim());
                    setShowUnlock(false);
                    setTokenInput("");
                    reconnect();
                  }
                }}
                placeholder="Paste admin token"
                className="loom-token-input"
                autoFocus
              />
              <button
                type="button"
                onClick={() => {
                  if (tokenInput.trim()) {
                    unlockAdmin(tokenInput.trim());
                    setShowUnlock(false);
                    setTokenInput("");
                    reconnect();
                  }
                }}
                className="loom-inline-action"
              >
                Unlock
              </button>
              <button
                type="button"
                onClick={() => { setShowUnlock(false); setTokenInput(""); }}
                className="loom-inline-action loom-inline-action-muted"
              >
                Cancel
              </button>
            </div>
          )}

          {authError && (
            <p className="mt-3 text-[11px] text-[#fda4af]">Wrong token</p>
          )}

          <div className="mt-5 flex flex-wrap items-center gap-2.5">
            <span className="loom-stat-pill">
              <span className="loom-stat-label">Agents</span>
              <span className="loom-stat-value">{numbered.length}/{MAX_SLOTS}</span>
            </span>
            {activeCount > 0 && (
              <span className="loom-stat-pill">
                <span className="h-2 w-2 rounded-full bg-[var(--dot-active)]" />
                <span>{activeCount} active</span>
              </span>
            )}
            {stuckCount > 0 && (
              <span className="loom-stat-pill">
                <span className="h-2 w-2 rounded-full bg-[var(--dot-needs)]" />
                <span>{stuckCount} waiting</span>
              </span>
            )}
            {idleCount > 0 && (
              <span className="loom-stat-pill">
                <span className="h-2 w-2 rounded-full bg-[var(--dot-offline)]" />
                <span>{idleCount} idle</span>
              </span>
            )}
            {emptyCount > 0 && (
              <span className="loom-stat-pill">
                <span className="h-2 w-2 rounded-full bg-[var(--text-light)]" />
                <span>{emptyCount} open slot{emptyCount === 1 ? "" : "s"}</span>
              </span>
            )}

            <div className="ml-auto flex flex-wrap items-center gap-2">
              {!isViewer && managing ? (
                <button
                  type="button"
                  onClick={() => setManaging(false)}
                  className="loom-inline-action"
                >
                  Done managing
                </button>
              ) : !isViewer && (
                <>
                  {numbered.length < MAX_SLOTS && (
                    <button
                      type="button"
                      onClick={() => setShowSpawnDialog(true)}
                      className="loom-inline-action"
                    >
                      + Spawn agent
                    </button>
                  )}
                  {numbered.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setManaging(true)}
                      className="loom-inline-action loom-inline-action-muted"
                    >
                      Manage stack
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      </header>

      <main className="flex-1 min-h-0 px-4 pb-4 sm:px-6 sm:pb-6">
        {numbered.length > 0 ? (
          <section className={`loom-stack-shell flex min-h-0 flex-col ${!isViewer && selectedEntry ? "shrink-0" : "h-full"}`}>
            <div className="loom-section-header shrink-0">
              <div className="min-w-0">
                <p className="loom-section-kicker">LIVE STACK</p>
                <h2 className="loom-section-title">Terminal order mirrored 1:1</h2>
                <p className="loom-section-copy">
                  The same worker stays in the same position everywhere, so routing decisions stay spatial and fast.
                </p>
              </div>
              <div className="loom-selection-pill">
                {selectedEntry ? `Q${selectedEntry.num} selected` : "All workers visible"}
              </div>
            </div>

            <div
              className={`min-h-0 grid ${GRID_CLASSES[numbered.length] || GRID_CLASSES[4]} loom-stack-grid ${!isViewer && selectedEntry ? "gap-2 p-2 sm:p-3" : "gap-3 p-3 sm:p-4"} transition-all duration-300 ease-[cubic-bezier(0.25,0.46,0.45,0.94)] ${!isViewer && selectedEntry ? "shrink-0" : "flex-1"}`}
              style={!isViewer && selectedEntry ? { maxHeight: chatExpanded ? "0px" : "40vh", overflow: chatExpanded ? "hidden" : "auto", padding: chatExpanded ? "0px" : undefined, gap: chatExpanded ? "0px" : undefined } : undefined}
            >
              {numbered.map(({ worker: w, num }) => (
                <AgentCard
                  key={w.id}
                  worker={w}
                  num={num}
                  selected={!isViewer && selectedId === w.id}
                  flagged={flaggedIds.has(w.id)}
                  managing={managing}
                  onClick={isViewer ? () => {} : () => toggleSelect(w.id)}
                  onPointerDown={isViewer ? undefined : () => { if (selectedId !== w.id) subscribeTo(w.id); }}
                  onSend={isViewer ? () => {} : (msg) => send({ type: "message", workerId: w.id, content: msg })}
                  onSelect={isViewer ? undefined : (index) => send({ type: "selection", workerId: w.id, optionIndex: index })}
                  onFlag={isViewer ? undefined : () => toggleFlag(w.id)}
                  onSuggestionApply={isViewer ? undefined : (appliedLabel, shownLabels) => send({ type: "suggestion_feedback", workerId: w.id, appliedLabel, shownLabels })}
                  onApprovePrompt={isViewer ? undefined : () => send({ type: "approve_prompt", workerId: w.id })}
                  onKill={!isViewer && managing ? () => {
                    send({ type: "kill", workerId: w.id });
                    if (selectedId === w.id) { setSelectedId(null); subscribeTo(null); }
                  } : undefined}
                />
              ))}
            </div>
          </section>
        ) : (
          <section className="loom-stack-shell flex h-full items-center justify-center">
            <div className="loom-empty-state">
              <p className="loom-section-kicker">NO LIVE STACK</p>
              <h2 className="loom-section-title">No agents running</h2>
              <p className="loom-section-copy">Spawn a worker and Loom will mirror the stack the moment the daemon sees it.</p>
            </div>
          </section>
        )}
      </main>

      {!isViewer && selectedEntry && (
        <div className="shrink-0 px-4 pb-4 sm:px-6 sm:pb-6">
          <ChatPanel
            key={selectedEntry.worker.id}
            worker={selectedEntry.worker}
            num={selectedEntry.num}
            entries={memoEntries}
            draft={draftsRef.current.get(selectedEntry.worker.id) || ""}
            expanded={chatExpanded}
            onExpand={setChatExpanded}
            previewUrl={previewUrlsRef.current.get(selectedEntry.worker.project) || ""}
            onPreviewUrlChange={(url) => {
              if (url) {
                previewUrlsRef.current.set(selectedEntry.worker.project, url);
              } else {
                previewUrlsRef.current.delete(selectedEntry.worker.project);
              }
              try {
                localStorage.setItem("hive_preview_urls", JSON.stringify(Object.fromEntries(previewUrlsRef.current)));
              } catch { /* non-critical */ }
            }}
            onDraftChange={(v) => {
              draftsRef.current.set(selectedEntry.worker.id, v);
              setDraftTick((k) => k + 1);
              try {
                const obj = Object.fromEntries(draftsRef.current);
                localStorage.setItem("hive_drafts", JSON.stringify(obj));
              } catch { /* quota exceeded, non-critical */ }
            }}
            onSend={(msg) => {
              const ok = send({ type: "message", workerId: selectedEntry.worker.id, content: msg });
              if (ok) {
                const normalized = msg.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
                addOptimisticEntry(selectedEntry.worker.id, normalized);
              }
              return ok;
            }}
            onDismiss={() => {
              setChatExpanded(false);
              setSelectedId(null);
              subscribeTo(null);
            }}
            onClose={() => {
              setChatExpanded(false);
              draftsRef.current.delete(selectedEntry.worker.id);
              try {
                const obj = Object.fromEntries(draftsRef.current);
                localStorage.setItem("hive_drafts", JSON.stringify(obj));
              } catch { /* non-critical */ }
              setSelectedId(null);
              subscribeTo(null);
            }}
          />
        </div>
      )}


      <ReviewDrawer
        open={showReviews}
        reviews={reviews}
        onClose={() => setShowReviews(false)}
        onDismiss={dismissReview}
        onMarkSeen={markReviewSeen}
        onMarkAllSeen={markAllReviewsSeen}
        onClearAll={clearAllReviews}
      />

      {showSpawnDialog && (
        <SpawnDialog
          models={models}
          onSpawn={(project, task, model) => {
            send({ type: "spawn", project, model, task: task || undefined });
            setShowSpawnDialog(false);
          }}
          onClose={() => setShowSpawnDialog(false)}
        />
      )}

    </div>
  );
}
