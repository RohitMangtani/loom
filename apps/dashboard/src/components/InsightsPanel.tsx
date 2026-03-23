"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { buildSummary } from "@/lib/insights-summary";
import type { ReviewItem, WorkerState } from "@/lib/types";

interface InsightsPanelProps {
  workers: Map<string, WorkerState>;
  reviews: ReviewItem[];
  activity: { text: string; timestamp: number } | null;
  onClose: () => void;
}

const reviewTypeLabel = (type: ReviewItem["type"]): string => {
  switch (type) {
    case "deploy": return "Deploy";
    case "push": return "Push";
    case "commit": return "Commit";
    case "pr": return "PR";
    case "review-needed": return "Review";
    default: return "Update";
  }
};

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "Just now";
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

export function InsightsPanel({ workers, reviews, activity, onClose }: InsightsPanelProps) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  const allWorkers = useMemo(() => Array.from(workers.values()), [workers]);
  const summary = useMemo(() => buildSummary(allWorkers, reviews, activity), [allWorkers, reviews, activity]);
  const total = allWorkers.length;
  const working = allWorkers.filter((w) => w.status === "working");
  const idle = allWorkers.filter((w) => w.status === "idle");
  const stuck = allWorkers.filter((w) => w.status === "stuck");
  const todayReviews = useMemo(() => reviews.filter((r) => Date.now() - r.createdAt < 86_400_000), [reviews]);
  const projectStats = useMemo(() => {
    const map = new Map<string, { name: string; count: number; working: number }>();
    for (const worker of allWorkers) {
      const name = worker.projectName || "unknown";
      const entry = map.get(name) ?? { name, count: 0, working: 0 };
      entry.count += 1;
      if (worker.status === "working") entry.working += 1;
      map.set(name, entry);
    }
    return Array.from(map.values()).sort((a, b) => b.working - a.working || b.count - a.count);
  }, [allWorkers]);

  if (!mounted || typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} role="presentation" />

      <div
        className="relative bg-[var(--bg-card)] border border-[var(--border)] rounded-3xl w-full max-w-2xl sm:mx-4 shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-5 space-y-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-[10px] uppercase tracking-[0.4em] text-[var(--text-light)]">Portfolio tab</p>
              <h3 className="text-2xl font-semibold text-[var(--text)]">Hive overview</h3>
              <p className="text-[11px] text-[var(--text-light)] uppercase tracking-[0.3em]">
                {activity?.text ?? "No recent actions captured yet"}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="text-[10px] font-semibold text-[var(--text-light)] hover:text-[var(--text)] transition-colors uppercase tracking-[0.3em]"
            >
              Close
            </button>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <div className="rounded-2xl border border-[var(--border)] bg-gradient-to-br from-[#111827] to-[#1f2937] p-4">
              <p className="text-[9px] uppercase tracking-[0.4em] text-[var(--text-light)]">Active agents</p>
              <p className="text-3xl font-bold text-white">{working.length}/{total}</p>
              <p className="text-[10px] text-[var(--dot-active)]">
                {idle.length} idle{stuck.length ? ` · ${stuck.length} needing attention` : ""}
              </p>
            </div>
            <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-panel)] p-4">
              <p className="text-[9px] uppercase tracking-[0.4em] text-[var(--text-light)]">Projects tracked</p>
              <p className="text-2xl font-bold text-[var(--text)]">{projectStats.length}</p>
              <p className="text-[10px] text-[var(--text-light)]">
                {projectStats.slice(0, 3).map((p) => `${p.name} (${p.working})`).join(", ") || "No active projects"}
              </p>
            </div>
            <div className="rounded-2xl border border-[var(--border)] bg-gradient-to-br from-[#1e1b4b] to-[#111827] p-4">
              <p className="text-[9px] uppercase tracking-[0.4em] text-[var(--text-light)]">Ships today</p>
              <p className="text-3xl font-bold text-white">{todayReviews.length}</p>
              <p className="text-[10px] text-[var(--text-light)]">
                {todayReviews.length ? todayReviews[0].summary : "No deployments yet"}
              </p>
            </div>
          </div>

          <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-panel)] p-4 space-y-2">
            <p className="text-[10px] uppercase tracking-[0.4em] text-[var(--text-light)]">Projects in view</p>
            <div className="flex flex-wrap gap-2">
              {projectStats.length ? projectStats.map((project) => (
                <span
                  key={project.name}
                  className="text-[10px] text-[var(--text)] px-3 py-1 rounded-full border border-[var(--border)] bg-[rgba(59,130,246,0.08)]"
                >
                  {project.name} · {project.working}/{project.count}
                </span>
              )) : (
                <span className="text-[10px] text-[var(--text-light)]">No projects yet</span>
              )}
            </div>
          </div>

          <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-panel)] p-4 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-[10px] uppercase tracking-[0.4em] text-[var(--text-light)]">Recent milestones</p>
              <span className="text-[10px] text-[var(--text-muted)]">{todayReviews.length} today</span>
            </div>
            <div className="space-y-2">
              {todayReviews.length === 0 ? (
                <p className="text-[10px] text-[var(--text-light)]">No recent ships recorded for today.</p>
              ) : (
                todayReviews.slice(0, 3).map((review) => (
                  <div key={review.id} className="flex flex-col gap-0.5">
                    <p className="text-xs text-[var(--text)]">{review.summary}</p>
                    <p className="text-[10px] text-[var(--text-muted)]">
                      {review.projectName} · {reviewTypeLabel(review.type)} · {timeAgo(review.createdAt)}
                    </p>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-alt)] p-4">
            <p className="text-[10px] uppercase tracking-[0.4em] text-[var(--text-light)]">Full snapshot</p>
            <pre className="text-[10px] leading-relaxed text-[var(--text)] whitespace-pre-wrap mt-2 font-[inherit]">
              {summary}
            </pre>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
