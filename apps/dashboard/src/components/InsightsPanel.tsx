"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { buildSummary } from "@/lib/insights-summary";
import type { ReviewItem, WorkerState } from "@/lib/types";

interface InsightsPanelProps {
  workers: Map<string, WorkerState>;
  reviews: ReviewItem[];
  activity: { text: string; timestamp: number } | null;
  onClose: () => void;
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
