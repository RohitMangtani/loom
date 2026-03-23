"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatEntry, ReviewItem, WorkerState } from "@/lib/types";
import type { ActivitySnapshot } from "@/lib/snapshot-store";
import { createSnapshotPayload, loadSnapshots, persistSnapshots } from "@/lib/snapshot-store";

interface ReviewDrawerProps {
  open: boolean;
  reviews: ReviewItem[];
  onClose: () => void;
  onDismiss: (id: string) => void;
  onMarkSeen: (id: string) => void;
  onMarkAllSeen: () => void;
  onClearAll: () => void;
  workers: Map<string, WorkerState>;
  chatEntries: Map<string, ChatEntry[]>;
  activity: { text: string; timestamp: number } | null;
  onRequestSnapshotUndo: (snapshot: ActivitySnapshot) => void;
}

function typeIcon(type: ReviewItem["type"]): string {
  switch (type) {
    case "deploy": return "\u2191"; // ↑
    case "push": return "\u2197";   // ↗
    case "commit": return "\u2713"; // ✓
    case "pr": return "\u2442";     // ⑂ (branch)
    case "review-needed": return "!";
    default: return "\u2022";       // •
  }
}

function typeLabel(type: ReviewItem["type"]): string {
  switch (type) {
    case "deploy": return "Deploy";
    case "push": return "Push";
    case "commit": return "Commit";
    case "pr": return "PR";
    case "review-needed": return "Review";
    default: return "Update";
  }
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

const SNAPSHOT_LIMIT = 6;

function buildAgentSummary(workers: Map<string, WorkerState>): string {
  if (workers.size === 0) return "No agents connected";
  return Array.from(workers.values())
    .slice(0, 3)
    .map((worker) => {
      const quadrant = worker.quadrant ? `Q${worker.quadrant}` : "Q?";
      const model = worker.model || "agent";
      const project = worker.projectName || "unknown project";
      const status = worker.status || "idle";
      return `${quadrant} ${model} on ${project} (${status})`;
    })
    .join(" · ");
}

function chatSnippet(workerId: string | undefined, chatEntries: Map<string, ChatEntry[]>): string {
  if (!workerId) return "";
  const entries = chatEntries.get(workerId);
  if (!entries || entries.length === 0) return "";
  const slice = entries.slice(-2);
  return slice
    .map((entry) => `${entry.role === "user" ? "You" : "Agent"}: ${entry.text}`)
    .join(" · ");
}

/** Swipeable review item  --  swipe right to dismiss */
function SwipeableItem({
  review,
  onDismiss,
}: {
  review: ReviewItem;
  onDismiss: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const startX = useRef(0);
  const currentX = useRef(0);
  const swiping = useRef(false);
  const [offset, setOffset] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [showArtifacts, setShowArtifacts] = useState(false);

  const THRESHOLD = 100; // px to trigger dismiss

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    startX.current = e.touches[0].clientX;
    currentX.current = 0;
    swiping.current = true;
  }, []);

  const onTouchMove = useCallback((e: React.TouchEvent) => {
    if (!swiping.current) return;
    const delta = e.touches[0].clientX - startX.current;
    // Only allow swiping right (positive direction)
    currentX.current = Math.max(0, delta);
    setOffset(currentX.current);
  }, []);

  const onTouchEnd = useCallback(() => {
    swiping.current = false;
    if (currentX.current > THRESHOLD) {
      setDismissed(true);
      setOffset(400); // slide out
      setTimeout(onDismiss, 250);
    } else {
      setOffset(0);
    }
    currentX.current = 0;
  }, [onDismiss]);

  if (dismissed) {
    return (
      <div
        className="overflow-hidden transition-all duration-250 ease-out"
        style={{ maxHeight: 0, opacity: 0, padding: 0 }}
      />
    );
  }

  return (
    <div
      ref={ref}
      className="group px-4 py-3 hover:bg-[rgba(255,255,255,0.03)] transition-colors relative"
      style={{
        opacity: review.seen ? 0.6 : 1,
        borderLeft: review.seen ? "2px solid transparent" : "2px solid var(--accent)",
        transform: `translateX(${offset}px)`,
        transition: swiping.current ? "none" : "transform 0.25s ease-out, opacity 0.25s ease-out",
      }}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
    >
      <div className="flex items-start gap-3">
        {/* Type badge */}
        <div
          className="shrink-0 w-7 h-7 rounded-lg flex items-center justify-center text-xs font-bold mt-0.5"
          style={{
            background: review.type === "review-needed"
              ? "rgba(234, 179, 8, 0.12)"
              : "rgba(59, 130, 246, 0.1)",
            color: review.type === "review-needed"
              ? "var(--dot-needs)"
              : "var(--accent)",
          }}
        >
          {typeIcon(review.type)}
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            {review.quadrant ? (
              <span
                className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded"
                style={{ background: "rgba(59, 130, 246, 0.12)", color: "var(--accent)" }}
              >
                Q{review.quadrant}
              </span>
            ) : (
              <span className="text-[10px] font-semibold text-[var(--text-light)] uppercase tracking-wider">
                {review.projectName}
              </span>
            )}
            <span className="text-[10px] text-[var(--text-muted)]">
              {typeLabel(review.type)}
            </span>
            {review.quadrant && (
              <span className="text-[10px] text-[var(--text-muted)]">
                {review.projectName}
              </span>
            )}
            <span className="text-[10px] text-[var(--text-muted)] ml-auto shrink-0">
              {formatTime(review.createdAt)}
            </span>
          </div>

          <p className="text-xs text-[var(--text)] leading-relaxed">
            {review.summary}
          </p>

          {/* Artifacts (expandable) */}
          {review.artifacts && review.artifacts.length > 0 && (
            <div className="mt-1">
              <button
                type="button"
                onClick={() => setShowArtifacts(!showArtifacts)}
                className="text-[10px] text-[var(--text-muted)] hover:text-[var(--text-light)] transition-colors cursor-pointer"
              >
                {showArtifacts ? "\u25BE" : "\u25B8"} {review.artifacts.length} file{review.artifacts.length !== 1 ? "s" : ""}
              </button>
              {showArtifacts && (
                <div className="mt-1 pl-2 border-l border-[var(--border)]">
                  {review.artifacts.map((art, i) => (
                    <div key={i} className="text-[10px] text-[var(--text-muted)] leading-relaxed">
                      <span className="text-[var(--text-light)]">{art.path}</span>
                      <span className="ml-1 opacity-60">({art.action})</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Action row */}
          <div className="flex items-center gap-2 mt-1.5">
            {review.url && (
              <a
                href={review.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[10px] text-[var(--accent)] hover:underline"
              >
                View &rarr;
              </a>
            )}
            <span className="text-[10px] text-[var(--text-muted)]">
              {timeAgo(review.createdAt)}
            </span>
            <button
              type="button"
              onClick={() => onDismiss()}
              className="ml-auto text-[10px] text-[var(--text-muted)] hover:text-[var(--dot-offline)] opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
            >
              Dismiss
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function ReviewDrawer({
  open,
  reviews,
  onClose,
  onDismiss,
  onMarkSeen,
  onMarkAllSeen,
  onClearAll,
  workers,
  chatEntries,
  activity,
  onRequestSnapshotUndo,
}: ReviewDrawerProps) {
  const drawerRef = useRef<HTMLDivElement>(null);
  const [snapshots, setSnapshots] = useState<ActivitySnapshot[]>([]);
  const [snapshotLabel, setSnapshotLabel] = useState("");
  const [snapshotNotes, setSnapshotNotes] = useState("");
  const [snapshotStatus, setSnapshotStatus] = useState<string | null>(null);
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleStatusClear = useCallback(() => {
    if (statusTimerRef.current) {
      clearTimeout(statusTimerRef.current);
    }
    statusTimerRef.current = setTimeout(() => {
      setSnapshotStatus(null);
      statusTimerRef.current = null;
    }, 2500);
  }, []);

  useEffect(() => () => {
    if (statusTimerRef.current) {
      clearTimeout(statusTimerRef.current);
    }
  }, []);

  const agentSummary = useMemo(() => buildAgentSummary(workers), [workers]);
  const primaryWorkerId = useMemo(() => {
    if (reviews.length > 0 && reviews[0].workerId) return reviews[0].workerId;
    const firstWorker = workers.values().next();
    return firstWorker.done ? undefined : firstWorker.value.id;
  }, [reviews, workers]);
  const reviewSummaryText = useMemo(() => {
    if (reviews.length === 0) return "Manual snapshot";
    const first = reviews[0];
    return `${typeLabel(first.type)} — ${first.summary}`;
  }, [reviews]);
  const reviewIds = useMemo(() => reviews.slice(0, 4).map((r) => r.id), [reviews]);
  const contextSummary = useMemo(() => {
    const pieces: string[] = [];
    if (activity?.text) pieces.push(activity.text);
    const snippet = chatSnippet(primaryWorkerId, chatEntries);
    if (snippet) pieces.push(snippet);
    return pieces.join(" · ") || "No context yet.";
  }, [activity, chatEntries, primaryWorkerId]);

  useEffect(() => {
    setSnapshots(loadSnapshots());
  }, []);

  const handleSaveSnapshot = useCallback(() => {
    const payload = createSnapshotPayload(
      snapshotLabel,
      snapshotNotes,
      agentSummary,
      contextSummary,
      reviewSummaryText,
      reviewIds,
      primaryWorkerId,
    );
    setSnapshots((prev) => {
      const next = [payload, ...prev].slice(0, SNAPSHOT_LIMIT);
      persistSnapshots(next);
      return next;
    });
    setSnapshotLabel("");
    setSnapshotNotes("");
    setSnapshotStatus(`Saved snapshot “${payload.label}”`);
    scheduleStatusClear();
  }, [
    snapshotLabel,
    snapshotNotes,
    agentSummary,
    contextSummary,
    reviewSummaryText,
    reviewIds,
    primaryWorkerId,
    scheduleStatusClear,
  ]);

  const handleCopyContext = useCallback((message: string) => {
    const text = message.trim();
    if (navigator?.clipboard?.writeText) {
      navigator.clipboard.writeText(text);
      setSnapshotStatus("Context copied to clipboard");
    } else {
      setSnapshotStatus("Clipboard not available");
    }
    scheduleStatusClear();
  }, []);

  // Mark items as seen when drawer opens
  useEffect(() => {
    if (open) {
      const unseen = reviews.filter(r => !r.seen);
      for (const r of unseen) {
        onMarkSeen(r.id);
      }
    }
  }, [open, reviews, onMarkSeen]);

  // Close on escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  // Swipe drawer closed (touch right edge and swipe right)
  const drawerStartX = useRef(0);
  const drawerSwiping = useRef(false);
  const [drawerOffset, setDrawerOffset] = useState(0);

  const onDrawerTouchStart = useCallback((e: React.TouchEvent) => {
    drawerStartX.current = e.touches[0].clientX;
    drawerSwiping.current = true;
  }, []);

  const onDrawerTouchMove = useCallback((e: React.TouchEvent) => {
    if (!drawerSwiping.current) return;
    const delta = e.touches[0].clientX - drawerStartX.current;
    if (delta > 0) setDrawerOffset(delta);
  }, []);

  const onDrawerTouchEnd = useCallback(() => {
    drawerSwiping.current = false;
    if (drawerOffset > 120) {
      onClose();
    }
    setDrawerOffset(0);
  }, [drawerOffset, onClose]);

  // Reset drawer offset when closing
  useEffect(() => {
    if (!open) setDrawerOffset(0);
  }, [open]);

  return (
    <>
      {/* Backdrop */}
      {open && (
        <div
          className="fixed inset-0 bg-black/40 z-40 transition-opacity"
          onClick={onClose}
        />
      )}

      {/* Drawer */}
      <div
        ref={drawerRef}
        className="fixed top-0 right-0 h-full z-50 flex flex-col transition-transform duration-300 ease-[cubic-bezier(0.25,0.46,0.45,0.94)]"
        style={{
          width: "min(360px, 85vw)",
          transform: open ? `translateX(${drawerOffset}px)` : "translateX(100%)",
          background: "var(--bg-card)",
          borderLeft: "1px solid var(--border)",
          transition: drawerSwiping.current ? "none" : undefined,
        }}
        onTouchStart={onDrawerTouchStart}
        onTouchMove={onDrawerTouchMove}
        onTouchEnd={onDrawerTouchEnd}
      >
        {/* Header */}
        <div className="shrink-0 flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-[var(--text)]">Activity</span>
            <span className="text-[10px] text-[var(--text-muted)]">
              {reviews.length > 0 ? `${reviews.length}` : ""}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {reviews.length > 0 && (
              <button
                type="button"
                onClick={onClearAll}
                className="text-[10px] text-[var(--text-light)] hover:text-[var(--dot-offline)] transition-colors cursor-pointer"
              >
                Clear list
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="text-lg text-[var(--text-light)] hover:text-[var(--text)] transition-colors px-1 cursor-pointer"
            >
              &times;
            </button>
          </div>
        </div>

        {/* Items  --  scrollable */}
        <div
          className="flex-1 overflow-y-auto overscroll-contain space-y-2"
          style={{ WebkitOverflowScrolling: "touch" }}
        >
          <div className="px-4 py-3 border-b border-[var(--border)] space-y-2">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs font-semibold text-[var(--text)]">Snapshots</p>
                <p className="text-[10px] text-[var(--text-light)]">{contextSummary}</p>
              </div>
              <button
                type="button"
                onClick={handleSaveSnapshot}
                className="text-[10px] font-semibold text-[var(--text-light)] hover:text-[var(--text)] transition-colors cursor-pointer border border-[var(--border)] rounded-full px-3 py-1"
              >
                Save snapshot
              </button>
            </div>
            <input
              type="text"
              value={snapshotLabel}
              onChange={(e) => setSnapshotLabel(e.target.value)}
              placeholder="Snapshot label (e.g., commit name)"
              className="w-full rounded border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-[10px] text-[var(--text)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
            />
            <textarea
              rows={2}
              value={snapshotNotes}
              onChange={(e) => setSnapshotNotes(e.target.value)}
              placeholder="Describe why this snapshot matters (auto-filled notes will show recent reviews)"
              className="w-full resize-none rounded border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-[10px] text-[var(--text)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
            />
            {snapshotStatus && (
              <p className="text-[10px] text-[var(--accent)]">{snapshotStatus}</p>
            )}
          </div>

          {snapshots.length > 0 && (
            <div className="px-4 space-y-2">
              {snapshots.map((snapshot) => (
                <article
                  key={snapshot.id}
                  className="space-y-1 rounded-lg border border-[var(--border)] bg-[var(--bg-alt)] px-3 py-2"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-[11px] font-semibold text-[var(--text)]">{snapshot.label}</p>
                      <p className="text-[9px] text-[var(--text-light)]">
                        {new Date(snapshot.timestamp).toLocaleDateString([], {
                          month: "short",
                          day: "numeric",
                        })}{" "}
                        {formatTime(snapshot.timestamp)}
                      </p>
                    </div>
                    <div className="flex gap-1">
                      <button
                        type="button"
                        onClick={() => onRequestSnapshotUndo(snapshot)}
                        className="text-[10px] font-semibold text-[var(--text)] hover:text-[var(--accent)] transition-colors"
                        disabled={!snapshot.workerId}
                        title={snapshot.workerId ? "Request rewind" : "No worker context yet"}
                      >
                        Rewind
                      </button>
                      <button
                        type="button"
                        onClick={() => handleCopyContext(`${snapshot.context} · ${snapshot.notes}`)}
                        className="text-[10px] text-[var(--text-light)] hover:text-[var(--text)] transition-colors"
                      >
                        Copy context
                      </button>
                    </div>
                  </div>
                  <p className="text-xs text-[var(--text-light)]">{snapshot.reviewSummary}</p>
                  <p className="text-[10px] text-[var(--text-muted)]">{snapshot.agentSummary}</p>
                  {snapshot.notes && (
                    <p className="text-[10px] text-[var(--text-light)]">Notes: {snapshot.notes}</p>
                  )}
                </article>
              ))}
            </div>
          )}

          {reviews.length === 0 ? (
            <div className="flex items-center justify-center h-full text-[var(--text-light)] text-xs">
              No recent activity
            </div>
          ) : (
            <div className="py-2">
              {reviews.map((review) => (
                <SwipeableItem
                  key={review.id}
                  review={review}
                  onDismiss={() => onDismiss(review.id)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
