"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useHive } from "@/lib/ws";
import { getAuthMode, unlockAdmin, lockAdmin } from "@/components/SitePasswordGate";
import { AgentCard } from "@/components/AgentCard";
import { ChatPanel } from "@/components/ChatPanel";
import { ReviewDrawer } from "@/components/ReviewDrawer";
import { SpawnDialog } from "@/components/SpawnDialog";
import { InviteDialog } from "@/components/InviteDialog";
import type { WorkerState } from "@/lib/types";
import { usePushSubscription } from "@/components/ServiceWorker";
import { useVoiceRecording } from "@/lib/useVoiceRecording";

// Require NEXT_PUBLIC_WS_URL in production; only fall back to localhost in dev.
const DEFAULT_URL = process.env.NEXT_PUBLIC_WS_URL
  || (process.env.NODE_ENV === "development" ? "ws://localhost:3002" : "");
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
    const sorted = Array.from(workers.values()).sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));

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
  const [showInviteDialog, setShowInviteDialog] = useState(false);
  const [presenceMinimized, setPresenceMinimized] = useState(false);
  const contextAttachmentsRef = useRef<Map<string, string[]>>(new Map());

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

  const { connected, workers, chatEntries, send, subscribeTo, addOptimisticEntry, isAdmin, role, reconnect, reviews, markReviewSeen, dismissReview, markAllReviewsSeen, clearAllReviews, models, vapidKey, machines, presence, activity, uploadToWorker } = useHive(daemonUrl);
  const { pushState, requestPush } = usePushSubscription(send, vapidKey);
  const [authError, setAuthError] = useState(false);

  // Voice mode — active when role is "voice"
  const isVoice = role === "voice";
  const isViewer = mode === "viewer" && !isVoice;
  const voice = useVoiceRecording();
  const [voiceTargetId, setVoiceTargetId] = useState<string | null>(null);
  const [voiceUnsupported, setVoiceUnsupported] = useState(false);
  const [voiceSentFlash, setVoiceSentFlash] = useState<string | null>(null);

  const handleVoiceTap = useCallback((workerId: string) => {
    if (voice.recording && voiceTargetId === workerId) {
      // Stop and send
      const text = voice.stop();
      if (text) {
        send({ type: "message", workerId, content: text });
        setVoiceSentFlash(workerId);
        setTimeout(() => setVoiceSentFlash(null), 1200);
      }
      setVoiceTargetId(null);
    } else {
      // Stop any existing recording first
      if (voice.recording) voice.stop();
      // Start recording for this worker
      const ok = voice.start();
      if (ok) {
        setVoiceTargetId(workerId);
      } else {
        setVoiceUnsupported(true);
        setTimeout(() => setVoiceUnsupported(false), 3000);
      }
    }
  }, [voice, voiceTargetId, send]);
  const workerList = useMemo(() => Array.from(workers.values()), [workers]);

  useEffect(() => {
    if (isAdmin === true && mode === "viewer") {
      setMode("admin");
    } else if (isAdmin === false && mode === "admin") {
      // Valid non-admin role (operator/viewer) — downgrade UI mode but keep token
      if (role === "operator" || role === "viewer" || role === "voice") {
        setMode("viewer");
      } else {
        // Truly invalid token — wipe it
        lockAdmin();
        setMode("viewer");
        setAuthError(true);
        setTimeout(() => setAuthError(false), 3000);
      }
    }
  }, [isAdmin, mode, role]);

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

  /** Group agents by machine  --  local first, then each satellite hostname */
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
    // Then satellites sorted by lowest quadrant number (order they were added to network)
    for (const [machine, agents] of [...byMachine.entries()].sort((a, b) => {
      const minA = Math.min(...a[1].map(e => e.num));
      const minB = Math.min(...b[1].map(e => e.num));
      return minA - minB;
    })) {
      groups.push({ machine, agents });
    }
    return groups;
  }, [numbered]);

  const activeCount = numbered.filter(({ worker: w }) => w.status === "working").length;
  const stuckCount = numbered.filter(({ worker: w }) => w.status === "stuck").length;
  const idleCount = numbered.filter(({ worker: w }) => w.status === "idle").length;
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
    <div className="h-dvh flex flex-col overflow-hidden bg-[var(--bg)] relative">
      {/* Header */}
      <header
        className={`shrink-0 px-4 sm:px-6 pt-4 pb-3 transition-[background-color] duration-500 ease-in-out ${chatExpanded ? "bg-[rgba(255,255,255,0.06)] cursor-pointer" : ""}`}
        onClick={() => { if (chatExpanded) { setChatExpanded(false); } }}
      >
        <div className="text-center relative">
          <h1
            className="text-sm font-bold tracking-[0.18em] uppercase text-[var(--text)]"
          >
            Hive
          </h1>
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
          {/* Push notification bell  --  right side, next to review button */}
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
          {/* Review queue button  --  right side */}
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

        {presence.length >= 2 && (
          <div className="presence-bar">
            <div className="presence-header cursor-pointer" onClick={() => setPresenceMinimized((p) => !p)}>
              <span className="presence-label">Connected people</span>
              <span className="presence-count">{presence.length} online {presenceMinimized ? "\u25B8" : "\u25BE"}</span>
            </div>
            {!presenceMinimized && (
              <>
                <div className="presence-list">
                  {presence.map((user) => (
                    <span key={user.id} className={`presence-chip role-${user.role}`}>
                      <span className="presence-dot" />
                      {user.name}
                    </span>
                  ))}
                </div>
                {activity && (
                  <p className="presence-activity">{activity.text} · {new Date(activity.timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</p>
                )}
              </>
            )}
          </div>
        )}

        <div className="flex items-center justify-center gap-3 mt-2 text-[10px] text-[var(--text-light)]">
          <span className="font-medium">{numbered.length}/{MAX_SLOTS} agents</span>
          {activeCount > 0 && <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-[var(--dot-active)]" />{activeCount} active</span>}
          {stuckCount > 0 && <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-[var(--dot-needs)]" />{stuckCount} waiting</span>}
          {idleCount > 0 && <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-[var(--dot-offline)]" />{idleCount} idle</span>}
          {!isViewer && !isVoice && managing ? (
            <button
              type="button"
              onClick={() => setManaging(false)}
              className="px-2 py-0.5 rounded border border-[var(--text-light)] text-[var(--text)] transition-colors cursor-pointer"
            >
              Done
            </button>
          ) : !isViewer && !isVoice && (
            <>
              {numbered.length < MAX_SLOTS && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowSpawnDialog(true);
                  }}
                  className="px-2 py-0.5 rounded border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)] hover:border-[var(--text-light)] transition-colors cursor-pointer"
                >
                  + Agent
                </button>
              )}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setShowInviteDialog(true);
                }}
                className="px-2 py-0.5 rounded border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)] hover:border-[var(--text-light)] transition-colors cursor-pointer"
              >
                Invite
              </button>
              {numbered.length > 0 && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setManaging(true);
                  }}
                  className="px-2 py-0.5 rounded border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)] hover:border-[var(--text-light)] transition-colors cursor-pointer"
                >
                  Manage
                </button>
              )}
            </>
          )}
        </div>
      </header>

      {/* Body  --  vertical tile stack grouped by machine, compresses when chat is open */}
      {numbered.length > 0 ? (
        <div
          className={`min-h-0 flex flex-col overflow-y-auto ${!isViewer && selectedEntry ? "gap-1.5 p-2 sm:p-3 shrink-0" : "gap-3 p-4 sm:p-6 flex-1"} transition-all duration-300 ease-[cubic-bezier(0.25,0.46,0.45,0.94)]`}
          style={!isViewer && selectedEntry ? { maxHeight: chatExpanded ? "0px" : "40vh", overflow: chatExpanded ? "hidden" : "auto", padding: chatExpanded ? "0px" : undefined, gap: chatExpanded ? "0px" : undefined } : undefined}
        >
          {machineGroups.map(({ machine, agents }) => (
            <div key={machine || "__local"} className={`flex flex-col ${!isViewer && selectedEntry ? "shrink-0 gap-1.5" : "flex-1 min-h-0 gap-3"}`}>
              {machine && (
                <div className="flex items-center gap-2 px-1 shrink-0">
                  <span className="text-[9px] font-mono uppercase tracking-wider text-[var(--text-muted)]">{machine}</span>
                  <span className="flex-1 h-px bg-[var(--border)]" />
                </div>
              )}
              {agents.map(({ worker: w, num }) => (
                <div key={w.id} className={!isViewer && selectedEntry ? "shrink-0" : "flex-1 min-h-0"}>
                  <AgentCard
                    worker={w}
                    num={num}
                    selected={!isViewer && !isVoice && selectedId === w.id}
                    flagged={flaggedIds.has(w.id)}
                    managing={managing}
                    fill={isViewer || isVoice || !selectedEntry}
                    onClick={isVoice ? () => handleVoiceTap(w.id) : isViewer ? () => {} : () => toggleSelect(w.id)}
                    onPointerDown={isViewer || isVoice ? undefined : () => { if (selectedId !== w.id) subscribeTo(w.id); }}
                    onSend={isViewer ? () => {} : (msg) => send({ type: "message", workerId: w.id, content: msg })}
                    onSelect={isViewer ? undefined : (index) => send({ type: "selection", workerId: w.id, optionIndex: index })}
                    onFlag={isViewer || isVoice ? undefined : () => toggleFlag(w.id)}
                    onSuggestionApply={isViewer ? undefined : (appliedLabel, shownLabels) => send({ type: "suggestion_feedback", workerId: w.id, appliedLabel, shownLabels })}
                    onApprovePrompt={isViewer || isVoice ? undefined : () => send({ type: "approve_prompt", workerId: w.id })}
                    onContextDrop={isViewer || isVoice ? undefined : (sourceId) => {
                      setSelectedId(w.id);
                      subscribeTo(w.id);
                      const prev = contextAttachmentsRef.current.get(w.id) || [];
                      if (!prev.includes(sourceId)) {
                        contextAttachmentsRef.current.set(w.id, [...prev, sourceId]);
                      }
                      setDraftTick((k) => k + 1);
                    }}
                    onKill={!isViewer && !isVoice && managing ? () => {
                      send({ type: "kill", workerId: w.id });
                      if (selectedId === w.id) { setSelectedId(null); subscribeTo(null); }
                    } : undefined}
                    voiceActive={isVoice && voice.recording && voiceTargetId === w.id}
                    voiceTranscript={isVoice && voice.recording && voiceTargetId === w.id ? voice.transcript : undefined}
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
              <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[var(--accent)]">Dashboard Ready</p>
              <h2 className="mt-3 text-2xl font-semibold text-[var(--text)]">Start your first agent</h2>
              <p className="mt-3 text-sm leading-6 text-[var(--text-muted)]">
                Launch a terminal-backed worker, then manage prompts, approvals, uploads, and chat from the same grid.
              </p>
            </div>
          )}
        </div>
      )}


      {/* Voice mode status bar */}
      {isVoice && (
        <div className="shrink-0 px-4 py-2 text-center">
          {voiceUnsupported ? (
            <p className="text-[11px] text-[#f87171]">Voice not supported on this browser. Use Chrome.</p>
          ) : voiceSentFlash ? (
            <p className="text-[11px] text-[var(--dot-active)]">Sent</p>
          ) : voice.recording ? (
            <p className="text-[11px] text-[#f97316] animate-pulse">Recording — tap tile to send</p>
          ) : (
            <p className="text-[11px] text-[var(--text-muted)]">Tap a tile to talk</p>
          )}
        </div>
      )}

      {/* Inline chat panel  --  admin only, hidden for voice mode */}
      {!isViewer && !isVoice && selectedEntry && (
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
          contextAttachments={contextAttachmentsRef.current.get(selectedEntry.worker.id) || []}
          workers={workers}
          onRemoveContextAttachment={(id) => {
            const prev = contextAttachmentsRef.current.get(selectedEntry.worker.id) || [];
            const next = prev.filter((x) => x !== id);
            if (next.length > 0) contextAttachmentsRef.current.set(selectedEntry.worker.id, next);
            else contextAttachmentsRef.current.delete(selectedEntry.worker.id);
            setDraftTick((k) => k + 1);
          }}
          onSend={(msg) => {
            const ctxIds = contextAttachmentsRef.current.get(selectedEntry.worker.id) || [];
            const ok = send({
              type: "message",
              workerId: selectedEntry.worker.id,
              content: msg,
              ...(ctxIds.length > 0 ? { contextWorkerIds: ctxIds, includeSenderContext: true } : {}),
            } as import("@/lib/types").DaemonMessage);
            if (ok) {
              const normalized = msg.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
              addOptimisticEntry(selectedEntry.worker.id, normalized);
              contextAttachmentsRef.current.delete(selectedEntry.worker.id);
            }
            return ok;
          }}
          onUploadFile={(payload) => uploadToWorker(selectedEntry.worker.id, payload)}
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
        workers={workers}
        chatEntries={chatEntries}
        activity={activity}
        onClose={() => setShowReviews(false)}
        onDismiss={dismissReview}
        onMarkSeen={markReviewSeen}
        onMarkAllSeen={markAllReviewsSeen}
        onClearAll={clearAllReviews}
        isAdmin={isAdmin}
        send={(msg) => send(msg as unknown as import("@/lib/types").DaemonMessage)}
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

      {showInviteDialog && (
        <InviteDialog
          send={(msg) => send(msg as unknown as import("@/lib/types").DaemonMessage)}
          onClose={() => setShowInviteDialog(false)}
        />
      )}

    </div>
  );
}
