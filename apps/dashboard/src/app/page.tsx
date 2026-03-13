"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useHive } from "@/lib/ws";
import { getAuthMode, unlockAdmin, lockAdmin } from "@/components/SitePasswordGate";
import { AgentCard, DOT_BG } from "@/components/AgentCard";
import { ChatPanel } from "@/components/ChatPanel";
import { ReviewDrawer } from "@/components/ReviewDrawer";
import type { WorkerState } from "@/lib/types";

const DEFAULT_URL = process.env.NEXT_PUBLIC_WS_URL || "ws://localhost:3002";
const MAX_SLOTS = 4;

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
  const [lastKnown, setLastKnown] = useState<Record<number, LastKnown>>({});

  useEffect(() => {
    setLastKnown(loadLastKnown());
  }, []);

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

  const { connected, workers, chatEntries, send, subscribeTo, addOptimisticEntry, isAdmin, reconnect, reviews, markReviewSeen, dismissReview, markAllReviewsSeen, clearAllReviews } = useHive(daemonUrl);
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

  // Snapshot active workers to lastKnown so empty tiles can offer quick-respawn
  useEffect(() => {
    if (numbered.length === 0) return;
    setLastKnown((prev) => {
      const next = { ...prev };
      for (const { worker: w, num } of numbered) {
        next[num] = {
          project: w.project,
          projectName: w.projectName,
          model: w.model || "claude",
        };
      }
      saveLastKnown(next);
      return next;
    });
  }, [numbered]);

  const activeCount = numbered.filter(({ worker: w }) => w.status === "working").length;
  const stuckCount = numbered.filter(({ worker: w }) => w.status === "stuck").length;
  const idleCount = numbered.filter(({ worker: w }) => w.status === "idle").length;
  const emptyCount = MAX_SLOTS - numbered.length;
  const selectedEntry = selectedId ? numbered.find(({ worker: w }) => w.id === selectedId) : null;

  const rawEntries = selectedEntry ? chatEntries.get(selectedEntry.worker.id) : undefined;
  const memoEntries = useMemo(() => (rawEntries ?? []).slice(-50), [rawEntries]);

  useEffect(() => {
    if (selectedId && !selectedEntry) {
      setSelectedId(null);
      subscribeTo(null);
    }
  }, [selectedId, selectedEntry, subscribeTo]);

  const toggleSelect = useCallback((id: string) => {
    const nextId = selectedId === id ? null : id;
    setChatExpanded(false);
    setSelectedId(nextId);
    subscribeTo(nextId);
  }, [selectedId, subscribeTo]);

  return (
    <div className="h-dvh flex flex-col overflow-hidden bg-[var(--bg)]">
      {/* Header */}
      <header
        className={`shrink-0 px-4 sm:px-6 pt-4 pb-3 transition-[background-color] duration-500 ease-in-out ${chatExpanded ? "bg-[rgba(255,255,255,0.06)] cursor-pointer" : ""}`}
        onClick={() => { if (chatExpanded) { setChatExpanded(false); } }}
      >
        <div className="text-center relative">
          <h1 className="text-sm font-bold tracking-[0.18em] uppercase text-[var(--text)]">Hive</h1>
          <div className="flex items-center justify-center gap-1.5 mt-1">
            <span className={`w-1.5 h-1.5 rounded-full ${connected ? "bg-[var(--dot-active)]" : "bg-[var(--dot-offline)]"}`} />
            <span className="text-[10px] text-[var(--text-light)]">
              {connected ? (isViewer ? "Viewing" : "Connected") : "Reconnecting..."}
            </span>
          </div>
          {isViewer ? (
            <button
              type="button"
              onClick={() => setShowUnlock(true)}
              className="absolute left-0 top-0 text-[10px] text-[var(--text-light)] hover:text-[var(--text)] transition-colors px-2 py-1 cursor-pointer"
              title="Enter admin token"
            >
              &#128274;
            </button>
          ) : (
            <button
              type="button"
              onClick={() => { if (window.confirm("Log out of admin?")) { lockAdmin(); setMode("viewer"); reconnect(); } }}
              className="absolute left-0 top-0 text-[10px] text-[var(--text-light)] hover:text-[var(--text)] transition-colors px-2 py-1 cursor-pointer"
              title="Lock (return to view-only)"
            >
              &#128275;
            </button>
          )}
          {/* Review queue button — right side */}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setShowReviews(true); }}
            className="absolute right-0 top-0 text-[10px] text-[var(--text-light)] hover:text-[var(--text)] transition-colors px-2 py-1 cursor-pointer"
            title="Recent changes"
          >
            <span className="relative inline-flex items-center">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
                <rect x="1" y="2" width="12" height="1.5" rx="0.75" fill="currentColor" />
                <rect x="1" y="6.25" width="12" height="1.5" rx="0.75" fill="currentColor" />
                <rect x="1" y="10.5" width="12" height="1.5" rx="0.75" fill="currentColor" />
              </svg>
              {reviews.filter(r => !r.seen).length > 0 && (
                <span className="absolute -top-1 -right-1.5 w-2 h-2 rounded-full bg-[var(--accent)]" />
              )}
            </span>
          </button>
        </div>

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
                  reconnect();
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
                  reconnect();
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

        {authError && (
          <p className="text-center text-[10px] text-[#f87171] mt-2">Wrong token</p>
        )}

        <div className="flex items-center justify-center gap-3 mt-2 text-[10px] text-[var(--text-light)]">
          {activeCount > 0 && <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-[var(--dot-active)]" />{activeCount} active</span>}
          {stuckCount > 0 && <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-[var(--dot-needs)]" />{stuckCount} waiting</span>}
          {idleCount > 0 && <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-[var(--dot-offline)]" />{idleCount} idle</span>}
          {emptyCount > 0 && <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-[var(--border)]" />{emptyCount} offline</span>}
        </div>
      </header>

      {/* Body — 2x2 grid */}
      <div
        className={`min-h-0 grid grid-cols-2 grid-rows-2 gap-3 p-4 sm:p-6 transition-all duration-300 ease-[cubic-bezier(0.25,0.46,0.45,0.94)] ${!isViewer && selectedEntry ? "shrink-0" : "flex-1"}`}
        style={!isViewer && selectedEntry ? { flexBasis: chatExpanded ? "0px" : "40%", maxHeight: chatExpanded ? "0px" : "none", overflow: chatExpanded ? "hidden" : "visible", padding: chatExpanded ? "0px" : undefined, gap: chatExpanded ? "0px" : undefined } : undefined}
      >
        {Array.from({ length: MAX_SLOTS }, (_, i) => i + 1).map((slot) => {
          const entry = numbered.find(({ num }) => num === slot);
          if (!entry) {
            return (
              <div
                key={slot}
                className={`card relative flex items-center justify-center ${isViewer ? "opacity-40" : "opacity-40 hover:opacity-60 transition-opacity"}`}
                style={{ borderLeftColor: "var(--border)" }}
              >
                <div className="flex items-center gap-2.5 absolute top-3 left-3">
                  <span className="text-lg font-bold tabular-nums text-[var(--text-light)]">{slot}</span>
                  <span className="w-2 h-2 rounded-full shrink-0 bg-[var(--border)]" />
                </div>
                {!isViewer ? (
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => send({ type: "spawn", project: "~", model: "claude", targetQuadrant: slot })}
                      className="rounded-md border border-[var(--border)] px-4 py-2 text-sm font-medium text-[var(--text-muted)] hover:text-[var(--text)] hover:border-[var(--text-light)] transition-colors cursor-pointer"
                    >
                      Claude
                    </button>
                    <button
                      type="button"
                      onClick={() => send({ type: "spawn", project: "~", model: "codex", targetQuadrant: slot })}
                      className="rounded-md border border-[var(--border)] px-4 py-2 text-sm font-medium text-[var(--text-muted)] hover:text-[var(--text)] hover:border-[var(--text-light)] transition-colors cursor-pointer"
                    >
                      Codex
                    </button>
                  </div>
                ) : (
                  <span className="text-4xl font-bold tracking-[0.25em] uppercase text-white opacity-[0.16]">
                    OFFLINE
                  </span>
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
              flagged={flaggedIds.has(w.id)}
              onClick={isViewer ? () => {} : () => toggleSelect(w.id)}
              onPointerDown={isViewer ? undefined : () => { if (selectedId !== w.id) subscribeTo(w.id); }}
              onSend={isViewer ? () => {} : (msg) => send({ type: "message", workerId: w.id, content: msg })}
              onSelect={isViewer ? undefined : (index) => send({ type: "selection", workerId: w.id, optionIndex: index })}
              onFlag={isViewer ? undefined : () => toggleFlag(w.id)}
              onSuggestionApply={isViewer ? undefined : (appliedLabel, shownLabels) => send({ type: "suggestion_feedback", workerId: w.id, appliedLabel, shownLabels })}
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

    </div>
  );
}
