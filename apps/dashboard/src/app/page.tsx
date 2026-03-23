"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useHive } from "@/lib/ws";
import { getAuthMode, unlockAdmin, lockAdmin } from "@/components/SitePasswordGate";
import { AgentCard } from "@/components/AgentCard";
import { ChatPanel } from "@/components/ChatPanel";
import { ReviewDrawer } from "@/components/ReviewDrawer";
import { SpawnDialog } from "@/components/SpawnDialog";
import { QuickStartDialog } from "@/components/QuickStartDialog";
import { OutputViewerDialog } from "@/components/OutputViewerDialog";
import { TimelineDrawer } from "@/components/TimelineDrawer";
import { CompletionBriefsDrawer } from "@/components/CompletionBriefsDrawer";
import type { WorkerState } from "@/lib/types";
import { attachBriefToRun, buildTeamCompletionBrief, buildWorkerCompletionBrief, createQuickStartRun, type CompletionBrief, type QuickStartRun } from "@/lib/completion-briefs";
import { usePushSubscription } from "@/components/ServiceWorker";

const DEFAULT_URL = process.env.NEXT_PUBLIC_WS_URL || "ws://localhost:3002";
const MAX_SLOTS = 8;


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
  const [completionBriefs, setCompletionBriefs] = useState<CompletionBrief[]>([]);
  const [quickStartRuns, setQuickStartRuns] = useState<QuickStartRun[]>([]);
  const [resultsSeenAt, setResultsSeenAt] = useState(0);
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
  const [showTimeline, setShowTimeline] = useState(false);
  const [showBriefs, setShowBriefs] = useState(false);
  const [managing, setManaging] = useState(false);
  const [showSpawnDialog, setShowSpawnDialog] = useState(false);
  const [showQuickStartDialog, setShowQuickStartDialog] = useState(false);
  const [viewerWorkerId, setViewerWorkerId] = useState<string | null>(null);
  const [pendingBriefKeys, setPendingBriefKeys] = useState<Array<{ workerId: string; key: string }>>([]);
  const processedBriefKeysRef = useRef<Set<string>>(new Set());
  const previousStatusesRef = useRef<Map<string, WorkerState["status"]>>(new Map());

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
    try {
      const savedBriefs = localStorage.getItem("hive_completion_briefs");
      if (savedBriefs) {
        const parsed = JSON.parse(savedBriefs) as CompletionBrief[];
        setCompletionBriefs(parsed);
        processedBriefKeysRef.current = new Set(parsed.filter((brief) => brief.kind === "worker").map((brief) => brief.id));
      }
    } catch { /* start fresh */ }
    try {
      const savedRuns = localStorage.getItem("hive_quick_start_runs");
      if (savedRuns) {
        setQuickStartRuns(JSON.parse(savedRuns) as QuickStartRun[]);
      }
    } catch { /* start fresh */ }
    try {
      const savedSeenAt = localStorage.getItem("hive_completion_seen_at");
      if (savedSeenAt) setResultsSeenAt(Number(savedSeenAt) || 0);
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

  const { connected, workers, chatEntries, workerContexts, send, subscribeTo, addOptimisticEntry, isAdmin, reconnect, requestWorkerContext, requestControlPlaneTimeline, reviews, markReviewSeen, dismissReview, markAllReviewsSeen, clearAllReviews, timelineEntries, models, vapidKey, machines } = useHive(daemonUrl);
  const { pushState, requestPush } = usePushSubscription(send, vapidKey);
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
    if (connected) requestControlPlaneTimeline(120);
  }, [connected, requestControlPlaneTimeline]);

  useEffect(() => {
    if (showTimeline) requestControlPlaneTimeline(120);
  }, [showTimeline, requestControlPlaneTimeline]);

  useEffect(() => {
    try {
      localStorage.setItem("hive_completion_briefs", JSON.stringify(completionBriefs));
    } catch { /* non-critical */ }
  }, [completionBriefs]);

  useEffect(() => {
    try {
      localStorage.setItem("hive_quick_start_runs", JSON.stringify(quickStartRuns));
    } catch { /* non-critical */ }
  }, [quickStartRuns]);

  useEffect(() => {
    try {
      localStorage.setItem("hive_completion_seen_at", String(resultsSeenAt));
    } catch { /* non-critical */ }
  }, [resultsSeenAt]);

  useEffect(() => {
    if (!showBriefs) return;
    const now = Date.now();
    setResultsSeenAt(now);
  }, [showBriefs]);

  useEffect(() => {
    if (selectedId) sessionStorage.setItem("hive_selected_agent", selectedId);
    else sessionStorage.removeItem("hive_selected_agent");
  }, [selectedId]);

  const numbered = useStableNumbering(workers);

  /** Group agents by machine — local first, then each satellite hostname */
  const machineGroups = useMemo(() => {
    const groups: { machine: string | undefined; agents: typeof numbered }[] = [];
    const byMachine = new Map<string | undefined, typeof numbered>();
    for (const entry of numbered) {
      const key = entry.worker.machine || undefined;
      if (!byMachine.has(key)) byMachine.set(key, []);
      byMachine.get(key)!.push(entry);
    }
    // Local first
    if (byMachine.has(undefined)) {
      groups.push({ machine: undefined, agents: byMachine.get(undefined)! });
      byMachine.delete(undefined);
    }
    // Then satellites sorted by hostname
    for (const [machine, agents] of [...byMachine.entries()].sort((a, b) => (a[0] || "").localeCompare(b[0] || ""))) {
      groups.push({ machine, agents });
    }
    return groups;
  }, [numbered]);

  const activeCount = numbered.filter(({ worker: w }) => w.status === "working").length;
  const stuckCount = numbered.filter(({ worker: w }) => w.status === "stuck").length;
  const idleCount = numbered.filter(({ worker: w }) => w.status === "idle").length;
  const emptyCount = MAX_SLOTS - numbered.length;
  const selectedEntry = selectedId ? numbered.find(({ worker: w }) => w.id === selectedId) : null;
  const viewerEntry = viewerWorkerId ? numbered.find(({ worker: w }) => w.id === viewerWorkerId) : null;
  const unseenBriefCount = completionBriefs.filter((brief) => brief.createdAt > resultsSeenAt).length;

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

  useEffect(() => {
    const next = new Map<string, WorkerState["status"]>();
    const triggered: Array<{ workerId: string; key: string }> = [];

    for (const { worker } of numbered) {
      const prevStatus = previousStatusesRef.current.get(worker.id);
      const completionKey = `${worker.id}:${worker.lastActionAt}`;
      if (prevStatus === "working" && worker.status === "idle" && !processedBriefKeysRef.current.has(completionKey)) {
        triggered.push({ workerId: worker.id, key: completionKey });
        requestWorkerContext(worker.id, { includeHistory: true, historyLimit: 12 });
        requestControlPlaneTimeline(120);
      }
      next.set(worker.id, worker.status);
    }

    previousStatusesRef.current = next;

    if (triggered.length > 0) {
      setPendingBriefKeys((prev) => {
        const seen = new Set(prev.map((item) => item.key));
        const merged = [...prev];
        for (const item of triggered) {
          if (!seen.has(item.key)) merged.push(item);
        }
        return merged;
      });
    }
  }, [numbered, requestControlPlaneTimeline, requestWorkerContext]);

  useEffect(() => {
    if (pendingBriefKeys.length === 0) return;

    const completedKeys = new Set<string>();
    const newWorkerBriefs: CompletionBrief[] = [];

    for (const pending of pendingBriefKeys) {
      const worker = workers.get(pending.workerId);
      const context = workerContexts.get(pending.workerId);
      if (!worker || !context) continue;
      if (processedBriefKeysRef.current.has(pending.key)) {
        completedKeys.add(pending.key);
        continue;
      }
      const brief = buildWorkerCompletionBrief(worker, context, timelineEntries);
      if (!brief) {
        completedKeys.add(pending.key);
        continue;
      }
      newWorkerBriefs.push({ ...brief, id: pending.key });
      processedBriefKeysRef.current.add(pending.key);
      completedKeys.add(pending.key);
    }

    if (completedKeys.size > 0) {
      setPendingBriefKeys((prev) => prev.filter((item) => !completedKeys.has(item.key)));
    }

    if (newWorkerBriefs.length === 0) return;

    setCompletionBriefs((prev) => {
      const merged = [...newWorkerBriefs, ...prev.filter((brief) => !newWorkerBriefs.some((next) => next.id === brief.id))];
      return merged.sort((a, b) => b.completedAt - a.completedAt).slice(0, 40);
    });

    setQuickStartRuns((prevRuns) => {
      let changed = false;
      let nextRuns = prevRuns.map((run) => {
        let updated = run;
        for (const brief of newWorkerBriefs) {
          const attached = attachBriefToRun(updated, brief);
          if (attached !== updated) {
            changed = true;
            updated = attached;
          }
        }
        return updated;
      });

      const teamBriefs: CompletionBrief[] = [];
      nextRuns = nextRuns.map((run) => {
        if (run.teamBriefId || run.matchedTasks.length < run.tasks.length) return run;
        const memberBriefs = [...newWorkerBriefs, ...completionBriefs]
          .filter((brief) => brief.kind === "worker" && run.briefIds.includes(brief.id));
        if (memberBriefs.length < run.tasks.length) return run;
        const teamBrief = buildTeamCompletionBrief(run, memberBriefs);
        teamBriefs.push(teamBrief);
        changed = true;
        return { ...run, teamBriefId: teamBrief.id };
      });

      if (teamBriefs.length > 0) {
        setCompletionBriefs((prev) => {
          const merged = [...teamBriefs, ...prev.filter((brief) => !teamBriefs.some((team) => team.id === brief.id))];
          return merged.sort((a, b) => b.completedAt - a.completedAt).slice(0, 40);
        });
        setShowBriefs(true);
      }

      return changed ? nextRuns : prevRuns;
    });
  }, [completionBriefs, pendingBriefKeys, timelineEntries, workerContexts, workers]);

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
    <div className="h-dvh flex flex-col overflow-hidden bg-[var(--bg)] relative">
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
          {/* Push notification bell — right side, next to review button */}
          {pushState !== "unsupported" && pushState !== "subscribed" && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); requestPush(); }}
              className="absolute right-8 top-0 text-[10px] text-[var(--text-light)] hover:text-[var(--text)] transition-colors px-2 py-1 cursor-pointer"
              title={pushState === "denied" ? "Notifications blocked" : "Enable notifications"}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                <path d="M13.73 21a2 2 0 0 1-3.46 0" />
              </svg>
            </button>
          )}
          {pushState === "subscribed" && (
            <span
              className="absolute right-8 top-0 text-[10px] text-[var(--dot-active)] px-2 py-1"
              title="Notifications enabled"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="1">
                <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                <path d="M13.73 21a2 2 0 0 1-3.46 0" />
              </svg>
            </span>
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
          <span className="font-medium">{numbered.length}/{MAX_SLOTS} agents</span>
          {activeCount > 0 && <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-[var(--dot-active)]" />{activeCount} active</span>}
          {stuckCount > 0 && <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-[var(--dot-needs)]" />{stuckCount} waiting</span>}
          {idleCount > 0 && <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-[var(--dot-offline)]" />{idleCount} idle</span>}
          <button
            type="button"
            onClick={() => setShowBriefs(true)}
            className="px-2 py-0.5 rounded border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)] hover:border-[var(--text-light)] transition-colors cursor-pointer relative"
          >
            Results
            {unseenBriefCount > 0 && (
              <span className="ml-1 inline-flex min-w-[16px] items-center justify-center rounded-full bg-[var(--accent)] px-1.5 text-[9px] font-semibold text-white">
                {unseenBriefCount}
              </span>
            )}
          </button>
          <button
            type="button"
            onClick={() => setShowTimeline(true)}
            className="px-2 py-0.5 rounded border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)] hover:border-[var(--text-light)] transition-colors cursor-pointer"
          >
            Timeline
          </button>
          {!isViewer && managing ? (
            <button
              type="button"
              onClick={() => setManaging(false)}
              className="px-2 py-0.5 rounded border border-[var(--text-light)] text-[var(--text)] transition-colors cursor-pointer"
            >
              Done
            </button>
          ) : !isViewer && (
            <>
              {numbered.length < MAX_SLOTS && (
                <>
                  {emptyCount >= 3 && (
                    <button
                      type="button"
                      onClick={() => setShowQuickStartDialog(true)}
                      className="px-2 py-0.5 rounded border border-[rgba(59,130,246,0.3)] text-[var(--text)] bg-[rgba(59,130,246,0.08)] hover:border-[var(--accent)] hover:bg-[rgba(59,130,246,0.14)] transition-colors cursor-pointer"
                    >
                      Quick Start
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setShowSpawnDialog(true)}
                    className="px-2 py-0.5 rounded border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)] hover:border-[var(--text-light)] transition-colors cursor-pointer"
                  >
                    + Agent
                  </button>
                </>
              )}
              {numbered.length > 0 && (
                <button
                  type="button"
                  onClick={() => setManaging(true)}
                  className="px-2 py-0.5 rounded border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)] hover:border-[var(--text-light)] transition-colors cursor-pointer"
                >
                  Manage
                </button>
              )}
            </>
          )}
        </div>
      </header>

      {/* Body — vertical tile stack grouped by machine, compresses when chat is open */}
      {numbered.length > 0 ? (
        <div
          className={`min-h-0 flex flex-col ${!isViewer && selectedEntry ? "gap-1.5 p-2 sm:p-3" : "gap-3 p-4 sm:p-6"} transition-all duration-300 ease-[cubic-bezier(0.25,0.46,0.45,0.94)] ${!isViewer && selectedEntry ? "shrink-0" : "flex-1"}`}
          style={!isViewer && selectedEntry ? { maxHeight: chatExpanded ? "0px" : "40vh", overflow: chatExpanded ? "hidden" : "auto", padding: chatExpanded ? "0px" : undefined, gap: chatExpanded ? "0px" : undefined } : undefined}
        >
          {machineGroups.map(({ machine, agents }) => (
            <div key={machine || "__local"} className={`flex flex-col ${!isViewer && selectedEntry ? "gap-1.5" : "gap-3"}`} style={{ flex: agents.length }}>
              {machine && (
                <div className="flex items-center gap-2 px-1 shrink-0">
                  <span className="text-[9px] font-mono uppercase tracking-wider text-[var(--text-muted)]">{machine}</span>
                  <span className="flex-1 h-px bg-[var(--border)]" />
                </div>
              )}
              {agents.map(({ worker: w, num }) => (
                <div key={w.id} className="flex-1 flex flex-col min-h-0">
                  <AgentCard
                    worker={w}
                    num={num}
                    selected={!isViewer && selectedId === w.id}
                    flagged={flaggedIds.has(w.id)}
                    managing={managing}
                    context={workerContexts.get(w.id) || null}
                    onClick={isViewer ? () => {} : () => toggleSelect(w.id)}
                    onPointerDown={isViewer ? undefined : () => { if (selectedId !== w.id) subscribeTo(w.id); }}
                    onSend={isViewer ? () => {} : (msg) => send({ type: "message", workerId: w.id, content: msg })}
                    onSelect={isViewer ? undefined : (index) => send({ type: "selection", workerId: w.id, optionIndex: index })}
                    onFlag={isViewer ? undefined : () => toggleFlag(w.id)}
                    onSuggestionApply={isViewer ? undefined : (appliedLabel, shownLabels) => send({ type: "suggestion_feedback", workerId: w.id, appliedLabel, shownLabels })}
                    onApprovePrompt={isViewer ? undefined : () => send({ type: "approve_prompt", workerId: w.id })}
                    onRequestContext={() => requestWorkerContext(w.id, { includeHistory: true, historyLimit: 10 })}
                    onOpenOutput={() => {
                      requestWorkerContext(w.id, { includeHistory: true, historyLimit: 10 });
                      setViewerWorkerId(w.id);
                    }}
                    onKill={!isViewer && managing ? () => {
                      send({ type: "kill", workerId: w.id });
                      if (selectedId === w.id) { setSelectedId(null); subscribeTo(null); }
                    } : undefined}
                  />
                </div>
              ))}
            </div>
          ))}
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center">
          {isViewer ? (
            <span className="text-sm text-[var(--text-muted)]">No agents running</span>
          ) : (
            <div className="mx-6 w-full max-w-xl rounded-[28px] border border-[var(--border)] bg-[linear-gradient(180deg,rgba(59,130,246,0.08),rgba(20,20,22,0.98))] p-6 text-center shadow-[0_24px_90px_rgba(0,0,0,0.4)]">
              <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[var(--accent)]">Quick Start</p>
              <h2 className="mt-3 text-2xl font-semibold text-[var(--text)]">Start with a ready-made team</h2>
              <p className="mt-3 text-sm leading-6 text-[var(--text-muted)]">
                Skip the setup overhead. Launch a pre-configured team for competitor research, weekly reporting, or alert coverage, then manage them normally from the same grid.
              </p>
              <div className="mt-5 flex flex-col justify-center gap-3 sm:flex-row">
                {emptyCount >= 3 && (
                  <button
                    type="button"
                    onClick={() => setShowQuickStartDialog(true)}
                    className="rounded-2xl bg-[var(--accent)] px-5 py-3 text-sm font-semibold text-white hover:opacity-95 transition-opacity"
                  >
                    Open Quick Start
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setShowSpawnDialog(true)}
                  className="rounded-2xl border border-[var(--border)] px-5 py-3 text-sm font-semibold text-[var(--text)] hover:border-[var(--text-light)] transition-colors"
                >
                  Spawn One Manually
                </button>
              </div>
            </div>
          )}
        </div>
      )}


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

      <TimelineDrawer
        open={showTimeline}
        events={timelineEntries}
        onClose={() => setShowTimeline(false)}
      />

      {showSpawnDialog && (
        <SpawnDialog
          models={models}
          machines={machines}
          onSpawn={(project, task, model, machine) => {
            send({ type: "spawn", project, model, task: task || undefined, machine });
            setShowSpawnDialog(false);
          }}
          onClose={() => setShowSpawnDialog(false)}
        />
      )}

      {showQuickStartDialog && (
        <QuickStartDialog
          models={models}
          machines={machines}
          availableSlots={emptyCount}
          pushState={pushState}
          onEnablePush={requestPush}
          onLaunch={(launch) => {
            setQuickStartRuns((prev) => [createQuickStartRun(launch), ...prev].slice(0, 12));
            const machine = launch.machine;
            launch.tasks.forEach((task, index) => {
              window.setTimeout(() => {
                send({ type: "spawn", project: "~", model: launch.model, task, machine });
              }, index * 150);
            });
            setShowQuickStartDialog(false);
          }}
          onClose={() => setShowQuickStartDialog(false)}
        />
      )}

      {viewerEntry && (
        <OutputViewerDialog
          worker={viewerEntry.worker}
          context={workerContexts.get(viewerEntry.worker.id) || null}
          onClose={() => setViewerWorkerId(null)}
        />
      )}

      <CompletionBriefsDrawer
        open={showBriefs}
        briefs={completionBriefs}
        onClose={() => setShowBriefs(false)}
      />

    </div>
  );
}
