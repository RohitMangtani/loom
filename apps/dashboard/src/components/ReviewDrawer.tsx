"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatEntry, ReviewItem, WorkerState } from "@/lib/types";
import type { RevertHistoryEntry } from "@hive/types";

interface ReviewDrawerProps {
  open: boolean;
  isAdmin: boolean | null;
  reviews: ReviewItem[];
  onClose: () => void;
  onDismiss: (id: string) => void;
  onMarkSeen: (id: string) => void;
  onMarkAllSeen: () => void;
  onClearAll: () => void;
  workers: Map<string, WorkerState>;
  chatEntries: Map<string, ChatEntry[]>;
  activity: { text: string; timestamp: number } | null;
  send: (msg: Record<string, unknown>) => boolean;
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

/** Swipeable review item  --  swipe right to dismiss */
function SwipeableItem({
  review,
  onDismiss,
  highlight = false,
}: {
  review: ReviewItem;
  onDismiss: () => void;
  highlight?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const startX = useRef(0);
  const currentX = useRef(0);
  const swiping = useRef(false);
  const [offset, setOffset] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [showArtifacts, setShowArtifacts] = useState(false);

  const THRESHOLD = 100;

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    startX.current = e.touches[0].clientX;
    currentX.current = 0;
    swiping.current = true;
  }, []);

  const onTouchMove = useCallback((e: React.TouchEvent) => {
    if (!swiping.current) return;
    const delta = e.touches[0].clientX - startX.current;
    currentX.current = Math.max(0, delta);
    setOffset(currentX.current);
  }, []);

  const onTouchEnd = useCallback(() => {
    swiping.current = false;
    if (currentX.current > THRESHOLD) {
      setDismissed(true);
      setOffset(400);
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
      className={`group px-4 py-3 hover:bg-[rgba(255,255,255,0.03)] transition-colors relative ${highlight ? "activity-flash" : ""}`}
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
  isAdmin,
  reviews,
  onClose,
  onDismiss,
  onMarkSeen,
  onMarkAllSeen,
  onClearAll,
  workers,
  chatEntries,
  activity,
  send,
}: ReviewDrawerProps) {
  const drawerRef = useRef<HTMLDivElement>(null);

  const [reverts, setReverts] = useState<RevertHistoryEntry[]>([]);
  const [loadingReverts, setLoadingReverts] = useState(false);
  const [revertingId, setRevertingId] = useState<string | null>(null);
  const [revertStatus, setRevertStatus] = useState<string | null>(null);

  // Listen for WS responses (reverts list + revert results)
  useEffect(() => {
    if (typeof window === "undefined") return;
    (window as unknown as Record<string, EventTarget>).__hiveRevertTarget ||= new EventTarget();
    const handler = (e: Event) => {
      const data = (e as CustomEvent).detail;
      if (data?.type === "reverts" && Array.isArray(data.reverts)) {
        setReverts(data.reverts);
        setLoadingReverts(false);
      } else if (data?.type === "revert_result") {
        setRevertingId(null);
        if (data.ok) {
          setRevertStatus(data.message || "Revert succeeded");
          send({ type: "list_reverts" });
        } else {
          setRevertStatus(data.error || "Revert failed");
        }
      }
    };
    const target = (window as unknown as Record<string, EventTarget>).__hiveRevertTarget;
    if (target) target.addEventListener("msg", handler);
    return () => { if (target) target.removeEventListener("msg", handler); };
  }, [send]);

  const loadReverts = useCallback(() => {
    setLoadingReverts(true);
    setRevertStatus(null);
    send({ type: "list_reverts" });
  }, [send]);

  const handleRevert = useCallback((entry: RevertHistoryEntry) => {
    if (isAdmin !== true) {
      setRevertStatus("Admin token required for reverts.");
      return;
    }
    const confirmation = window.prompt(`Type "${entry.commit}" to confirm reverting ${entry.projectName}`)?.trim();
    if (!confirmation) return;
    setRevertingId(entry.id);
    setRevertStatus(null);
    send({ type: "revert", revertId: entry.id, revertConfirmation: confirmation });
  }, [isAdmin, send]);

  useEffect(() => {
    if (open) loadReverts();
  }, [open, loadReverts]);

  // Mark items as seen when drawer opens
  useEffect(() => {
    if (open) {
      const unseen = reviews.filter(r => !r.seen);
      for (const r of unseen) onMarkSeen(r.id);
    }
  }, [open, reviews, onMarkSeen]);

  // Close on escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  // Swipe drawer closed
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
    if (drawerOffset > 120) onClose();
    setDrawerOffset(0);
  }, [drawerOffset, onClose]);

  useEffect(() => { if (!open) setDrawerOffset(0); }, [open]);

  const now = Date.now();
  const RECENT_WINDOW = 4000;

  return (
    <>
      {open && (
        <div
          className="fixed inset-0 bg-black/40 z-40 transition-opacity"
          onClick={onClose}
        />
      )}

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

        {/* Content  --  scrollable */}
        <div
          className="flex-1 overflow-y-auto overscroll-contain"
          style={{ WebkitOverflowScrolling: "touch" }}
        >
          {/* Revert history */}
          <div className="px-4 py-3 border-b border-[var(--border)] space-y-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-semibold text-[var(--text)]">Revert history</p>
              {revertStatus && (
                <p className="text-[10px] text-[var(--accent)]">{revertStatus}</p>
              )}
            </div>
            {loadingReverts && (
              <p className="text-[10px] text-[var(--text-muted)]">Loading...</p>
            )}
            {!loadingReverts && reverts.length === 0 && (
              <p className="text-[10px] text-[var(--text-muted)]">
                Revert entries appear after agents push commits.
              </p>
            )}
            {reverts.length > 0 && (
              <div className="space-y-2">
                {reverts.map((entry) => {
                  const isFresh = now - entry.timestamp < RECENT_WINDOW;
                  return (
                    <article
                      key={entry.id}
                      className={`rounded-lg border border-[var(--border)] px-3 py-2.5 ${isFresh ? "activity-flash" : ""}`}
                      style={{ background: "rgba(255,255,255,0.02)" }}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-[11px] font-semibold text-[var(--text)] truncate">{entry.label}</p>
                          <div className="flex items-center gap-1.5 mt-0.5">
                            <span className="text-[9px] font-mono text-[var(--accent)]">{entry.commit}</span>
                            <span className="text-[9px] text-[var(--text-muted)]">{entry.projectName}</span>
                            {entry.quadrant && (
                              <span className="text-[9px] text-[var(--text-muted)]">Q{entry.quadrant}</span>
                            )}
                            <span className="text-[9px] text-[var(--text-muted)]">{timeAgo(entry.timestamp)}</span>
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => handleRevert(entry)}
                          disabled={isAdmin !== true || revertingId === entry.id}
                          className="shrink-0 text-[10px] font-semibold px-2.5 py-1 rounded border border-[rgba(239,68,68,0.25)] text-[#f87171] hover:bg-[rgba(239,68,68,0.1)] transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-default"
                          title={isAdmin === true ? `Revert to ${entry.commit}` : "Admin token required"}
                        >
                          {revertingId === entry.id ? "Reverting..." : "Revert"}
                        </button>
                      </div>
                      {entry.description && (
                        <p className="text-[10px] text-[var(--text-light)] mt-1 leading-relaxed">{entry.description}</p>
                      )}
                    </article>
                  );
                })}
              </div>
            )}
          </div>

          {/* Review items */}
          {reviews.length === 0 ? (
            <div className="flex items-center justify-center py-12 text-[var(--text-light)] text-xs">
              No recent activity
            </div>
          ) : (
            <div className="py-2">
              {reviews.map((review) => {
                const isRecent = now - review.createdAt < RECENT_WINDOW;
                return (
                  <SwipeableItem
                    key={review.id}
                    review={review}
                    onDismiss={() => onDismiss(review.id)}
                    highlight={isRecent}
                  />
                );
              })}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
