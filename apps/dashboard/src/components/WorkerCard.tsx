"use client";

import type { WorkerState } from "@/lib/types";

interface WorkerCardProps {
  worker: WorkerState;
  selected: boolean;
  onClick: () => void;
  onKill: () => void;
}

const STATUS_COLORS: Record<WorkerState["status"], string> = {
  working: "bg-[var(--success)]",
  waiting: "bg-[var(--warning)]",
  stuck: "bg-[var(--error)]",
  idle: "bg-zinc-500",
};

const STATUS_TEXT_COLORS: Record<WorkerState["status"], string> = {
  working: "text-green-400",
  waiting: "text-amber-400",
  stuck: "text-red-400",
  idle: "text-zinc-400",
};

function timeAgo(ts: number): string {
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function WorkerCard({
  worker,
  selected,
  onClick,
  onKill,
}: WorkerCardProps) {
  const shouldPulse = worker.status === "working" || worker.status === "stuck";

  return (
    <button
      type="button"
      onClick={onClick}
      className={`
        w-full text-left rounded-lg border p-4 transition-colors cursor-pointer
        bg-[var(--bg-card)] hover:border-zinc-600
        ${selected ? "border-[var(--accent)]" : "border-[var(--border)]"}
      `}
    >
      <div className="flex items-center justify-between mb-2">
        <span className="font-medium text-sm truncate">
          {worker.projectName}
        </span>
        <div className="flex items-center gap-2">
          <span className="flex items-center gap-1.5">
            <span
              className={`
                inline-block w-2 h-2 rounded-full ${STATUS_COLORS[worker.status]}
                ${shouldPulse ? "animate-pulse" : ""}
              `}
            />
            <span
              className={`text-xs font-medium ${STATUS_TEXT_COLORS[worker.status]}`}
            >
              {worker.status}
            </span>
          </span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onKill();
            }}
            className="text-xs text-zinc-500 hover:text-red-400 transition-colors px-1.5 py-0.5 rounded hover:bg-red-400/10"
            title="Kill worker"
          >
            kill
          </button>
        </div>
      </div>

      {worker.task && (
        <p className="text-xs text-[var(--text-muted)] mb-2 line-clamp-2">
          {worker.task}
        </p>
      )}

      <div className="text-xs text-[var(--text-muted)] space-y-0.5">
        {worker.currentAction && (
          <p className="truncate">
            <span className="text-zinc-500">now:</span> {worker.currentAction}
          </p>
        )}
        <p className="truncate">
          <span className="text-zinc-500">last:</span> {worker.lastAction}
        </p>
        <div className="flex justify-between mt-1.5">
          <span className="text-zinc-600">
            pid {worker.pid}
          </span>
          <span className="text-zinc-600">
            {timeAgo(worker.startedAt)} active
          </span>
        </div>
      </div>

      {worker.errorCount > 0 && (
        <div className="mt-2 text-xs text-red-400">
          {worker.errorCount} error{worker.errorCount > 1 ? "s" : ""}
        </div>
      )}
    </button>
  );
}
