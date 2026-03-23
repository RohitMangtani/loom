"use client";

import { useEffect, useMemo, useState } from "react";
import type { ControlPlaneTimelineEntry } from "@/lib/types";

function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
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

function iconForType(type: ControlPlaneTimelineEntry["type"]): string {
  switch (type) {
    case "spawn": return "+";
    case "message": return "->";
    case "route": return ">>";
    case "approval": return "ok";
    case "kill": return "x";
    case "exec": return ">";
    case "maintenance": return "rs";
    case "satellite": return "sat";
    case "completion": return "id";
    default: return ".";
  }
}

function accentForType(type: ControlPlaneTimelineEntry["type"]): string {
  switch (type) {
    case "spawn": return "rgba(59,130,246,0.14)";
    case "message": return "rgba(59,130,246,0.12)";
    case "route": return "rgba(99,102,241,0.14)";
    case "approval": return "rgba(16,185,129,0.14)";
    case "kill": return "rgba(248,113,113,0.14)";
    case "exec": return "rgba(234,179,8,0.14)";
    case "maintenance": return "rgba(45,212,191,0.14)";
    case "satellite": return "rgba(45,212,191,0.14)";
    case "completion": return "rgba(34,197,94,0.12)";
    default: return "rgba(255,255,255,0.08)";
  }
}

export function TimelineDrawer({
  open,
  events,
  onClose,
}: {
  open: boolean;
  events: ControlPlaneTimelineEntry[];
  onClose: () => void;
}) {
  const [workerFilter, setWorkerFilter] = useState<string>("all");

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const filterOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const event of events) {
      if (!event.workerId) continue;
      seen.set(event.workerId, event.workerLabel || event.workerId);
    }
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [events]);

  const filtered = useMemo(
    () => events.filter((event) => workerFilter === "all" || event.workerId === workerFilter),
    [events, workerFilter]
  );

  return (
    <div className={`fixed inset-0 z-50 ${open ? "" : "pointer-events-none"}`} aria-hidden={!open}>
      <div
        className={`absolute inset-0 bg-black/50 transition-opacity duration-200 ${open ? "opacity-100" : "opacity-0"}`}
        onClick={onClose}
        role="presentation"
      />

      <aside
        className={`absolute left-0 top-0 h-full w-full max-w-[420px] border-r border-[var(--border)] bg-[var(--bg-card)] shadow-[0_24px_80px_rgba(0,0,0,0.42)] transition-transform duration-250 ease-out ${open ? "translate-x-0" : "-translate-x-full"}`}
      >
        <div className="flex h-full flex-col">
          <div className="border-b border-[var(--border)] px-4 py-4 sm:px-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[var(--accent)]">Control Timeline</p>
                <h2 className="mt-2 text-lg font-semibold text-[var(--text)]">Replay the control plane</h2>
                <p className="mt-1 text-xs leading-5 text-[var(--text-muted)]">
                  Spawn, route, approval, execution, satellite, and completion history in one stream.
                </p>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="rounded-full border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--text-muted)] transition-colors hover:border-[var(--border-light)] hover:text-[var(--text)]"
              >
                Close
              </button>
            </div>

            <div className="mt-4 flex items-center gap-2">
              <label htmlFor="timeline-worker-filter" className="text-[10px] uppercase tracking-[0.16em] text-[var(--text-muted)]">
                Filter
              </label>
              <select
                id="timeline-worker-filter"
                value={workerFilter}
                onChange={(event) => setWorkerFilter(event.target.value)}
                className="rounded-xl border border-[var(--border)] bg-[rgba(255,255,255,0.02)] px-3 py-2 text-xs text-[var(--text)] outline-none"
              >
                <option value="all">All agents</option>
                {filterOptions.map(([workerId, label]) => (
                  <option key={workerId} value={workerId}>{label}</option>
                ))}
              </select>
              <span className="ml-auto text-[10px] uppercase tracking-[0.16em] text-[var(--text-muted)]">
                {filtered.length} events
              </span>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-3 py-3 sm:px-4">
            {filtered.length === 0 ? (
              <div className="rounded-2xl border border-[var(--border)] bg-[rgba(255,255,255,0.02)] px-4 py-5 text-sm text-[var(--text-muted)]">
                No timeline events yet for this filter.
              </div>
            ) : (
              <div className="space-y-3">
                {filtered.map((event) => (
                  <article
                    key={event.id}
                    className="rounded-2xl border border-[var(--border)] bg-[rgba(255,255,255,0.02)] px-4 py-3"
                  >
                    <div className="flex items-start gap-3">
                      <div
                        className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-xs font-bold text-[var(--text)]"
                        style={{ background: accentForType(event.type) }}
                      >
                        {iconForType(event.type)}
                      </div>

                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          {event.workerLabel && (
                            <span className="rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[var(--accent)] bg-[rgba(59,130,246,0.12)]">
                              {event.workerLabel}
                            </span>
                          )}
                          {event.machineLabel && (
                            <span className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
                              {event.machineLabel}
                            </span>
                          )}
                          <span className="ml-auto text-[10px] text-[var(--text-muted)]">
                            {formatClock(event.ts)}
                          </span>
                        </div>

                        <p className="mt-1 text-sm leading-6 text-[var(--text)]">{event.summary}</p>
                        {event.detail && (
                          <p className="mt-1 text-xs leading-5 text-[var(--text-muted)]">{event.detail}</p>
                        )}

                        {event.links && event.links.length > 0 && (
                          <div className="mt-3 flex flex-wrap gap-2">
                            {event.links.map((link) => (
                              <a
                                key={`${event.id}:${link.kind}:${link.path}`}
                                href={`file://${link.path}`}
                                target="_blank"
                                rel="noreferrer"
                                className="rounded-full border border-[rgba(59,130,246,0.2)] bg-[rgba(59,130,246,0.08)] px-3 py-1.5 text-[11px] text-[var(--text)] transition-colors hover:border-[var(--accent)]"
                                title={link.path}
                              >
                                {link.kind === "context" ? "Context" : "Output"} · {link.label}
                              </a>
                            ))}
                          </div>
                        )}

                        <div className="mt-2 text-[10px] uppercase tracking-[0.16em] text-[var(--text-muted)]">
                          {timeAgo(event.ts)}
                        </div>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </div>
        </div>
      </aside>
    </div>
  );
}
