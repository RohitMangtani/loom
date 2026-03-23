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

function buildSummary(
  allWorkers: WorkerState[],
  reviews: ReviewItem[],
  activity: { text: string; timestamp: number } | null,
): string {
  const working = allWorkers.filter(w => w.status === "working");
  const idle = allWorkers.filter(w => w.status === "idle");
  const stuck = allWorkers.filter(w => w.status === "stuck");
  const total = allWorkers.length;
  const models = [...new Set(allWorkers.map(w => w.model || "claude"))];
  const projects = [...new Set(allWorkers.map(w => w.projectName).filter(p => p && p !== "unknown" && p !== "home"))];

  const lines: string[] = [];

  // Opening line
  if (working.length === 0 && total > 0) {
    lines.push(`All ${total} agents are idle. Nothing is running.`);
  } else if (working.length === total) {
    lines.push(`All ${total} agents are working. Full fleet active.`);
  } else if (total === 0) {
    lines.push("No agents connected.");
  } else {
    lines.push(`${working.length} of ${total} agents working. ${idle.length} idle${stuck.length > 0 ? `, ${stuck.length} stuck` : ""}.`);
  }

  // What is actively happening
  if (working.length > 0) {
    lines.push("");
    for (const w of working) {
      const model = w.model && w.model !== "claude" ? ` (${w.model})` : "";
      const action = w.currentAction || w.lastAction || "working";
      lines.push(`Q${w.quadrant}${model} on ${w.projectName}: ${action}`);
    }
  }

  // What just finished
  const todayReviews = reviews.filter(r => Date.now() - r.createdAt < 86400_000);
  if (todayReviews.length > 0) {
    lines.push("");
    lines.push(`${todayReviews.length} thing${todayReviews.length !== 1 ? "s" : ""} shipped today:`);
    for (const r of todayReviews.slice(0, 3)) {
      lines.push(`  ${r.summary} (${timeAgo(r.createdAt)})`);
    }
    if (todayReviews.length > 3) {
      lines.push(`  ...and ${todayReviews.length - 3} more`);
    }
  }

  // Available agents
  if (idle.length > 0 && working.length > 0) {
    lines.push("");
    const idleNames = idle.map(w => {
      const model = w.model && w.model !== "claude" ? ` ${w.model}` : "";
      return `Q${w.quadrant}${model}`;
    });
    lines.push(`Available: ${idleNames.join(", ")}`);
  }

  // Models and projects
  if (models.length > 1 || projects.length > 1) {
    lines.push("");
    if (models.length > 1) lines.push(`Models: ${models.join(", ")}`);
    if (projects.length > 0) lines.push(`Projects: ${projects.join(", ")}`);
  }

  // Latest human action
  if (activity) {
    lines.push("");
    lines.push(`Last action: ${activity.text} (${timeAgo(activity.timestamp)})`);
  }

  return lines.join("\n");
}

export function InsightsPanel({ workers, reviews, activity, onClose }: InsightsPanelProps) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  const allWorkers = Array.from(workers.values());
  const summary = buildSummary(allWorkers, reviews, activity);

  if (!mounted || typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} role="presentation" />

      <div
        className="relative bg-[var(--bg-card)] border border-[var(--border)] rounded-t-2xl sm:rounded-lg w-full max-w-md sm:mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-5">
          <pre className="text-xs leading-relaxed text-[var(--text)] whitespace-pre-wrap font-[inherit]">{summary}</pre>
        </div>

        <div className="border-t border-[var(--border)] px-6 py-3">
          <button
            type="button"
            onClick={onClose}
            className="w-full text-center text-xs text-[var(--text-muted)] hover:text-[var(--text)] transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
