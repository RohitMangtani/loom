"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import type { ReviewItem } from "@/lib/types";

interface ReviewDrawerProps {
  open: boolean;
  reviews: ReviewItem[];
  onClose: () => void;
  onDismiss: (id: string) => void;
  onMarkSeen: (id: string) => void;
  onMarkAllSeen: () => void;
  onClearAll: () => void;
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
}: ReviewDrawerProps) {
  const drawerRef = useRef<HTMLDivElement>(null);

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
          className="flex-1 overflow-y-auto overscroll-contain"
          style={{ WebkitOverflowScrolling: "touch" }}
        >
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
