"use client";

import { useEffect, useMemo } from "react";
import type { CompletionBrief } from "@/lib/completion-briefs";

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

async function copyBrief(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Clipboard is best-effort.
  }
}

function shortPath(path: string): string {
  const parts = path.split("/");
  return parts.slice(-2).join("/");
}

export function CompletionBriefsDrawer({
  open,
  briefs,
  onClose,
}: {
  open: boolean;
  briefs: CompletionBrief[];
  onClose: () => void;
}) {
  const grouped = useMemo(() => {
    const teams = briefs.filter((brief) => brief.kind === "team");
    const workers = briefs.filter((brief) => brief.kind === "worker");
    return { teams, workers };
  }, [briefs]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <div className={`fixed inset-0 z-50 ${open ? "" : "pointer-events-none"}`} aria-hidden={!open}>
      <div
        className={`absolute inset-0 bg-black/55 transition-opacity duration-200 ${open ? "opacity-100" : "opacity-0"}`}
        onClick={onClose}
        role="presentation"
      />

      <aside
        className={`absolute right-0 top-0 h-full w-full max-w-[520px] border-l border-[var(--border)] bg-[var(--bg-card)] shadow-[0_24px_80px_rgba(0,0,0,0.42)] transition-transform duration-250 ease-out ${open ? "translate-x-0" : "translate-x-full"}`}
      >
        <div className="flex h-full flex-col">
          <div className="border-b border-[var(--border)] px-4 py-4 sm:px-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[var(--accent)]">Completion Briefs</p>
                <h2 className="mt-2 text-lg font-semibold text-[var(--text)]">Value, not just activity</h2>
                <p className="mt-1 text-xs leading-5 text-[var(--text-muted)]">
                  Compact outcome cards for finished workers and Quick Start teams.
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
            <div className="mt-4 flex items-center gap-3 text-[10px] uppercase tracking-[0.16em] text-[var(--text-muted)]">
              <span>{briefs.length} total</span>
              <span>{grouped.teams.length} team</span>
              <span>{grouped.workers.length} worker</span>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-3 py-3 sm:px-4">
            {briefs.length === 0 ? (
              <div className="rounded-2xl border border-[var(--border)] bg-[rgba(255,255,255,0.02)] px-4 py-5 text-sm text-[var(--text-muted)]">
                No completion briefs yet. Finish a task or run a Quick Start team and the result cards will appear here.
              </div>
            ) : (
              <div className="space-y-3">
                {briefs.map((brief) => (
                  <article key={brief.id} className="rounded-2xl border border-[var(--border)] bg-[rgba(255,255,255,0.02)] px-4 py-4">
                    <div className="flex items-start gap-3">
                      <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-[rgba(59,130,246,0.12)] text-[11px] font-semibold text-[var(--text)]">
                        {brief.kind === "team" ? "TEAM" : "DONE"}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start gap-2">
                          <div className="min-w-0">
                            <h3 className="text-sm font-semibold text-[var(--text)]">{brief.title}</h3>
                            <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">{brief.subtitle}</p>
                          </div>
                          <span className="ml-auto shrink-0 text-[10px] text-[var(--text-muted)]">{formatTime(brief.completedAt)}</span>
                        </div>

                        <div className="mt-3 space-y-3">
                          <section>
                            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--text-light)]">Original ask</p>
                            <p className="mt-1 text-[12px] leading-6 text-[var(--text)]">{brief.originalAsk}</p>
                          </section>

                          {brief.highlights.length > 0 && (
                            <section>
                              <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--text-light)]">Key events</p>
                              <ul className="mt-1 space-y-1.5 text-[12px] leading-5 text-[var(--text)]">
                                {brief.highlights.map((item) => (
                                  <li key={item}>- {item}</li>
                                ))}
                              </ul>
                            </section>
                          )}

                          {brief.files.length > 0 && (
                            <section>
                              <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--text-light)]">Files changed</p>
                              <div className="mt-2 flex flex-wrap gap-2">
                                {brief.files.slice(0, 8).map((file) => (
                                  <span key={file} className="rounded-full border border-[rgba(59,130,246,0.2)] bg-[rgba(59,130,246,0.08)] px-3 py-1.5 text-[11px] text-[var(--text)]" title={file}>
                                    {shortPath(file)}
                                  </span>
                                ))}
                              </div>
                            </section>
                          )}

                          <section>
                            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--text-light)]">Main output</p>
                            <p className="mt-1 text-[12px] leading-6 text-[var(--text)]">{brief.outputSummary}</p>
                          </section>

                          {brief.nextActions.length > 0 && (
                            <section>
                              <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--text-light)]">Suggested next actions</p>
                              <ul className="mt-1 space-y-1.5 text-[12px] leading-5 text-[var(--text)]">
                                {brief.nextActions.map((item) => (
                                  <li key={item}>- {item}</li>
                                ))}
                              </ul>
                            </section>
                          )}
                        </div>

                        <div className="mt-4 flex items-center gap-3">
                          <button
                            type="button"
                            onClick={() => void copyBrief(brief.copyText)}
                            className="rounded-full border border-[var(--accent)] bg-[rgba(59,130,246,0.12)] px-3 py-1.5 text-[11px] font-semibold text-[var(--text)] transition-colors hover:bg-[rgba(59,130,246,0.18)]"
                          >
                            Copy brief
                          </button>
                          <span className="text-[10px] uppercase tracking-[0.16em] text-[var(--text-muted)]">{timeAgo(brief.completedAt)}</span>
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
