"use client";

import type { WorkerContextSnapshot, WorkerState } from "@/lib/types";
import { modelLabel } from "./AgentCard";

function latestByRole(context: WorkerContextSnapshot | null | undefined, role: "user" | "agent") {
  if (!context) return null;
  for (let i = context.recentMessages.length - 1; i >= 0; i--) {
    if (context.recentMessages[i]?.role === role) return context.recentMessages[i];
  }
  return null;
}

function likelyRoutedContext(text: string): boolean {
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length >= 3) return true;
  return /(^- |\bTarget:|\bCreated:|\bFollow it exactly\b)/im.test(text);
}

export function OutputViewerDialog({
  worker,
  context,
  onClose,
}: {
  worker: WorkerState;
  context: WorkerContextSnapshot | null;
  onClose: () => void;
}) {
  const latestInstruction = latestByRole(context, "user");
  const latestOutput = latestByRole(context, "agent");
  const showRoutedSection = !!latestInstruction && likelyRoutedContext(latestInstruction.text);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
      <div className="absolute inset-0 bg-black/70" onClick={onClose} role="presentation" />

      <div className="relative flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-[24px] border border-[var(--border)] bg-[var(--bg-card)] shadow-[0_30px_120px_rgba(0,0,0,0.5)]">
        <div className="border-b border-[var(--border)] px-5 py-4 sm:px-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[var(--accent)]">Last output</p>
              <h2 className="mt-2 text-xl font-semibold text-[var(--text)]">
                {modelLabel(worker)} {worker.quadrant ? `Q${worker.quadrant}` : worker.id}
              </h2>
              <p className="mt-1 text-sm text-[var(--text-muted)]">
                {worker.machineLabel || worker.projectName} · {worker.projectName}
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
        </div>

        <div className="overflow-y-auto px-5 py-5 sm:px-6">
          {!context ? (
            <div className="rounded-2xl border border-[var(--border)] bg-[rgba(255,255,255,0.02)] px-4 py-5 text-sm text-[var(--text-muted)]">
              Loading full context...
            </div>
          ) : (
            <div className="space-y-5">
              {showRoutedSection && latestInstruction && (
                <section className="rounded-2xl border border-[rgba(59,130,246,0.18)] bg-[rgba(59,130,246,0.06)]">
                  <div className="border-b border-[rgba(59,130,246,0.14)] px-4 py-3">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--accent)]">Routed context</p>
                  </div>
                  <div className="px-4 py-4">
                    <pre className="whitespace-pre-wrap break-words text-[13px] leading-6 text-[var(--text)] font-sans">
                      {latestInstruction.text}
                    </pre>
                  </div>
                </section>
              )}

              <section className="rounded-2xl border border-[var(--border)] bg-[rgba(255,255,255,0.02)]">
                <div className="border-b border-[var(--border)] px-4 py-3">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--text-light)]">Latest output</p>
                </div>
                <div className="px-4 py-4">
                  <pre className="whitespace-pre-wrap break-words text-[13px] leading-6 text-[var(--text)] font-sans">
                    {latestOutput?.text || context.contextSummary}
                  </pre>
                </div>
              </section>

              {context.recentArtifacts.length > 0 && (
                <section className="rounded-2xl border border-[var(--border)] bg-[rgba(255,255,255,0.02)]">
                  <div className="border-b border-[var(--border)] px-4 py-3">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--text-light)]">Recent files</p>
                  </div>
                  <div className="flex flex-wrap gap-2 px-4 py-4">
                    {context.recentArtifacts.map((artifact) => (
                      <span key={`${artifact.path}:${artifact.ts}`} className="rounded-full border border-[rgba(59,130,246,0.2)] bg-[rgba(59,130,246,0.08)] px-3 py-1.5 text-xs text-[var(--text)]">
                        {artifact.path}
                      </span>
                    ))}
                  </div>
                </section>
              )}

              {!showRoutedSection && latestInstruction && (
                <section className="rounded-2xl border border-[var(--border)] bg-[rgba(255,255,255,0.02)]">
                  <div className="border-b border-[var(--border)] px-4 py-3">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--text-light)]">Latest instruction</p>
                  </div>
                  <div className="px-4 py-4">
                    <pre className="whitespace-pre-wrap break-words text-[13px] leading-6 text-[var(--text)] font-sans">
                      {latestInstruction.text}
                    </pre>
                  </div>
                </section>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
