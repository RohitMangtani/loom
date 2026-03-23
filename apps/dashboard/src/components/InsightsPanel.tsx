"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { WorkerState, ReviewItem } from "@/lib/types";

interface InsightsPanelProps {
  workers: Map<string, WorkerState>;
  reviews: ReviewItem[];
  activity: { text: string; timestamp: number } | null;
  onClose: () => void;
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.round(diff / 3600_000)}h ago`;
  return `${Math.round(diff / 86400_000)}d ago`;
}

export function InsightsPanel({ workers, reviews, activity, onClose }: InsightsPanelProps) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  const allWorkers = Array.from(workers.values());
  const working = allWorkers.filter(w => w.status === "working");
  const idle = allWorkers.filter(w => w.status === "idle");
  const stuck = allWorkers.filter(w => w.status === "stuck");

  // Recent completions from reviews
  const recentReviews = reviews.slice(0, 5);

  // Active work summaries
  const activeWork = working.map(w => ({
    quadrant: w.quadrant,
    model: w.model || "claude",
    project: w.projectName,
    action: w.currentAction || w.lastAction,
  }));

  // Fleet health score (simple: working agents / total)
  const total = allWorkers.length;
  const utilization = total > 0 ? Math.round((working.length / total) * 100) : 0;

  if (!mounted || typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} role="presentation" />

      <div
        className="relative bg-[var(--bg-card)] border border-[var(--border)] rounded-t-2xl sm:rounded-lg w-full max-w-md sm:mx-4 max-h-[80vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="sticky top-0 bg-[var(--bg-card)] border-b border-[var(--border)] px-6 py-4 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">Fleet Insights</h2>
            <p className="text-[10px] text-[var(--text-muted)] mt-0.5">
              {total} agent{total !== 1 ? "s" : ""} active
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-[var(--text-muted)] hover:text-[var(--text)] text-lg"
          >
            x
          </button>
        </div>

        <div className="px-6 py-4 space-y-6">

          {/* Fleet Status */}
          <div>
            <h3 className="text-xs uppercase tracking-wider text-[var(--text-muted)] mb-3">Status</h3>
            <div className="grid grid-cols-3 gap-3">
              <div className="text-center p-3 rounded-lg bg-[var(--bg)]">
                <span className="text-2xl font-bold text-[#4ade80]">{working.length}</span>
                <p className="text-[10px] text-[var(--text-muted)] mt-1">Working</p>
              </div>
              <div className="text-center p-3 rounded-lg bg-[var(--bg)]">
                <span className="text-2xl font-bold text-[#f87171]">{idle.length}</span>
                <p className="text-[10px] text-[var(--text-muted)] mt-1">Idle</p>
              </div>
              <div className="text-center p-3 rounded-lg bg-[var(--bg)]">
                <span className="text-2xl font-bold text-[#fbbf24]">{stuck.length}</span>
                <p className="text-[10px] text-[var(--text-muted)] mt-1">Stuck</p>
              </div>
            </div>
            <div className="mt-3 h-2 rounded-full bg-[var(--bg)] overflow-hidden">
              <div
                className="h-full rounded-full bg-[#4ade80] transition-all duration-500"
                style={{ width: `${utilization}%` }}
              />
            </div>
            <p className="text-[10px] text-[var(--text-muted)] mt-1 text-right">{utilization}% utilization</p>
          </div>

          {/* Active Work */}
          {activeWork.length > 0 && (
            <div>
              <h3 className="text-xs uppercase tracking-wider text-[var(--text-muted)] mb-3">Working Now</h3>
              <div className="space-y-2">
                {activeWork.map((w, i) => (
                  <div key={i} className="flex items-start gap-2 p-2 rounded-md bg-[var(--bg)]">
                    <span className="w-2 h-2 mt-1.5 rounded-full bg-[#4ade80] shrink-0" />
                    <div className="min-w-0">
                      <p className="text-xs font-medium">
                        Q{w.quadrant} <span className="text-[var(--text-muted)]">{w.model}</span> <span className="text-[var(--text-muted)]">on {w.project}</span>
                      </p>
                      <p className="text-[10px] text-[var(--text-muted)] truncate">{w.action}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Idle Agents */}
          {idle.length > 0 && (
            <div>
              <h3 className="text-xs uppercase tracking-wider text-[var(--text-muted)] mb-3">Available</h3>
              <div className="flex flex-wrap gap-2">
                {idle.map((w) => (
                  <span key={w.id} className="px-2 py-1 text-[10px] rounded-md bg-[var(--bg)] text-[var(--text-muted)]">
                    Q{w.quadrant} {w.model || "claude"} <span className="opacity-50">on {w.projectName}</span>
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Recent Completions */}
          {recentReviews.length > 0 && (
            <div>
              <h3 className="text-xs uppercase tracking-wider text-[var(--text-muted)] mb-3">Recent Completions</h3>
              <div className="space-y-2">
                {recentReviews.map((r) => (
                  <div key={r.id} className="flex items-start justify-between gap-2 p-2 rounded-md bg-[var(--bg)]">
                    <div className="min-w-0">
                      <p className="text-xs truncate">{r.summary}</p>
                      <p className="text-[10px] text-[var(--text-muted)]">{r.type} in {r.projectName}</p>
                    </div>
                    <span className="text-[10px] text-[var(--text-muted)] shrink-0">{timeAgo(r.createdAt)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Latest Activity */}
          {activity && (
            <div>
              <h3 className="text-xs uppercase tracking-wider text-[var(--text-muted)] mb-3">Latest Activity</h3>
              <p className="text-xs text-[var(--text-muted)]">
                {activity.text} <span className="opacity-50">{timeAgo(activity.timestamp)}</span>
              </p>
            </div>
          )}

          {/* Fleet Summary */}
          <div className="border-t border-[var(--border)] pt-4">
            <h3 className="text-xs uppercase tracking-wider text-[var(--text-muted)] mb-2">Fleet</h3>
            <div className="grid grid-cols-2 gap-2 text-[10px] text-[var(--text-muted)]">
              <span>Total agents: {total}</span>
              <span>Models: {[...new Set(allWorkers.map(w => w.model || "claude"))].join(", ")}</span>
              <span>Reviews today: {reviews.filter(r => Date.now() - r.createdAt < 86400_000).length}</span>
              <span>Projects: {[...new Set(allWorkers.map(w => w.projectName))].join(", ")}</span>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
