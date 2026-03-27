"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useDiagnostics } from "@/lib/useDiagnostics";
import type { Signal } from "@/lib/useDiagnostics";
import type { WorkerState } from "@/lib/types";

interface DiagnosticsPanelProps {
  /** WebSocket URL the dashboard connects to (ws:// or wss://) */
  wsUrl: string;
  /** Auth token for REST API calls */
  token: string;
  /** Live worker map from useHive — used for stuck worker details */
  workers: Map<string, WorkerState>;
  /** Whether the panel is open */
  open: boolean;
  /** Close callback */
  onClose: () => void;
}

// ---- Helpers ----

function deriveHttpBase(wsUrl: string): string {
  // ws://host:3002 -> http://host:3001
  // wss://host/path -> https://host/path (keep port)
  try {
    const url = new URL(wsUrl);
    const proto = url.protocol === "wss:" ? "https:" : "http:";
    // Dashboard WS typically runs on 3002, daemon REST on 3001
    const port = url.port === "3002" ? "3001" : url.port;
    return `${proto}//${url.hostname}${port ? `:${port}` : ""}`;
  } catch {
    return "http://localhost:3001";
  }
}

function timeAgo(ts: number): string {
  if (!ts) return "never";
  const diff = Date.now() - ts;
  if (diff < 0) return "just now";
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ago`;
}

function truncateId(id: string, len = 12): string {
  return id.length > len ? id.slice(0, len) + "..." : id;
}

// ---- Collapsible Section ----

function Section({
  title,
  defaultOpen = false,
  badge,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  badge?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-b border-[var(--border)] last:border-b-0">
      <button
        type="button"
        className="w-full flex items-center justify-between px-4 py-2.5 text-left cursor-pointer hover:bg-[rgba(255,255,255,0.03)] transition-colors"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="text-[11px] font-semibold uppercase tracking-[0.15em] text-[var(--text-muted)]">
          {title}
        </span>
        <span className="flex items-center gap-2">
          {badge && (
            <span className="text-[10px] font-mono text-[var(--text-light)]">
              {badge}
            </span>
          )}
          <span className="text-[10px] text-[var(--text-light)]">
            {open ? "\u25BE" : "\u25B8"}
          </span>
        </span>
      </button>
      {open && <div className="px-4 pb-3">{children}</div>}
    </div>
  );
}

// ---- Status Dot ----

function StatusDot({ pass }: { pass: boolean }) {
  return (
    <span
      className="inline-block w-2 h-2 rounded-full shrink-0"
      style={{
        background: pass ? "var(--dot-active)" : "var(--dot-offline)",
      }}
    />
  );
}

// ---- Main Component ----

export function DiagnosticsPanel({
  wsUrl,
  token,
  workers,
  open,
  onClose,
}: DiagnosticsPanelProps) {
  const baseUrl = useMemo(() => deriveHttpBase(wsUrl), [wsUrl]);
  const { check, debug, signals, loading, error, runCheck, getDebug, getSignals } =
    useDiagnostics(baseUrl, token);

  const [selectedWorkerId, setSelectedWorkerId] = useState<string | null>(null);

  // Fetch check + debug on open
  useEffect(() => {
    if (open) {
      runCheck();
      getDebug();
    }
  }, [open, runCheck, getDebug]);

  // Fetch signals when a worker is selected
  useEffect(() => {
    if (open && selectedWorkerId) {
      getSignals(selectedWorkerId);
    }
  }, [open, selectedWorkerId, getSignals]);

  const handleRefresh = useCallback(() => {
    runCheck();
    getDebug();
    if (selectedWorkerId) getSignals(selectedWorkerId);
  }, [runCheck, getDebug, getSignals, selectedWorkerId]);

  // Stuck workers from live data
  const stuckWorkers = useMemo(() => {
    const stuck: WorkerState[] = [];
    for (const w of workers.values()) {
      if (w.status === "stuck" && w.stuckMessage) {
        stuck.push(w);
      }
    }
    return stuck;
  }, [workers]);

  // Worker list for signal picker
  const workerList = useMemo(() => Array.from(workers.values()), [workers]);

  // Signal entries for the selected worker
  const signalEntries = useMemo((): Signal[] => {
    if (!signals || !selectedWorkerId) return [];
    const entries = signals[selectedWorkerId] || [];
    // Return last 10, newest first
    return entries.slice(-10).reverse();
  }, [signals, selectedWorkerId]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Overlay */}
      <div
        className="absolute inset-0 bg-black/60"
        onClick={onClose}
        role="presentation"
      />

      {/* Panel */}
      <div
        className="relative bg-[var(--bg-card)] border border-[var(--border)] rounded-lg w-full max-w-lg mx-4 max-h-[85vh] flex flex-col overflow-hidden animate-expand-in"
        style={{ fontFamily: "var(--font-mono, monospace)" }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)] shrink-0">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-[var(--text)]">
              Diagnostics
            </h2>
            {check && (
              <span
                className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded"
                style={{
                  color:
                    check.overall === "pass"
                      ? "var(--dot-active)"
                      : check.overall === "warn"
                        ? "var(--dot-needs)"
                        : "var(--dot-offline)",
                  background:
                    check.overall === "pass"
                      ? "rgba(34,197,94,0.12)"
                      : check.overall === "warn"
                        ? "rgba(234,179,8,0.12)"
                        : "rgba(220,38,38,0.12)",
                }}
              >
                {check.overall}
              </span>
            )}
            {loading && (
              <span className="text-[10px] text-[var(--text-light)] animate-pulse">
                loading...
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleRefresh}
              className="text-[10px] text-[var(--text-light)] hover:text-[var(--text)] px-2 py-1 cursor-pointer transition-colors"
              title="Refresh all"
            >
              Refresh
            </button>
            <button
              type="button"
              onClick={onClose}
              className="text-[var(--text-light)] hover:text-[var(--text)] px-1 cursor-pointer transition-colors text-sm"
            >
              &times;
            </button>
          </div>
        </div>

        {/* Error bar */}
        {error && (
          <div className="px-4 py-2 bg-[rgba(220,38,38,0.08)] text-[11px] text-[var(--dot-offline)] shrink-0">
            {error}
          </div>
        )}

        {/* Scrollable content */}
        <div className="overflow-y-auto flex-1">
          {/* Pipeline Checks */}
          <Section
            title="Pipeline Checks"
            defaultOpen
            badge={
              check
                ? `${check.checks.filter((c) => c.pass).length}/${check.checks.length}`
                : undefined
            }
          >
            {check ? (
              <div className="space-y-1.5">
                {check.checks.map((c) => (
                  <div
                    key={c.name}
                    className="flex items-start gap-2 text-[11px]"
                  >
                    <StatusDot pass={c.pass} />
                    <span className="text-[var(--text)] font-medium min-w-[130px]">
                      {c.name}
                    </span>
                    <span className="text-[var(--text-muted)] break-all">
                      {c.detail}
                    </span>
                  </div>
                ))}
                {check.version && (
                  <div className="mt-2 text-[10px] text-[var(--text-light)]">
                    Version: {check.version}
                  </div>
                )}
              </div>
            ) : (
              <p className="text-[11px] text-[var(--text-light)]">
                No data yet
              </p>
            )}
          </Section>

          {/* Satellites */}
          {check && check.satellites.length > 0 && (
            <Section
              title="Satellites"
              badge={`${check.satellites.length}`}
            >
              <div className="space-y-2">
                {check.satellites.map((s) => (
                  <div
                    key={s.machine}
                    className="flex items-center gap-2 text-[11px]"
                  >
                    <StatusDot pass={s.connected && s.versionMatch} />
                    <span className="text-[var(--text)] font-medium">
                      {s.machine}
                    </span>
                    <span className="text-[var(--text-muted)]">
                      v{s.version}
                    </span>
                    <span className="text-[var(--text-light)]">
                      {s.workers} worker{s.workers !== 1 ? "s" : ""}
                    </span>
                    {!s.versionMatch && (
                      <span className="text-[var(--dot-needs)] text-[10px]">
                        version mismatch
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </Section>
          )}

          {/* Stuck Workers */}
          {stuckWorkers.length > 0 && (
            <Section
              title="Stuck Workers"
              defaultOpen
              badge={`${stuckWorkers.length}`}
            >
              <div className="space-y-2">
                {stuckWorkers.map((w) => (
                  <div
                    key={w.id}
                    className="rounded-md border border-[rgba(234,179,8,0.3)] bg-[rgba(234,179,8,0.04)] p-2.5"
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <span className="w-2 h-2 rounded-full bg-[var(--dot-needs)]" />
                      <span className="text-[11px] font-semibold text-[var(--text)]">
                        {w.projectName}
                      </span>
                      {w.tty && (
                        <span className="text-[10px] text-[var(--text-light)]">
                          {w.tty}
                        </span>
                      )}
                      {w.quadrant && (
                        <span className="text-[10px] text-[var(--text-light)]">
                          Q{w.quadrant}
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-[var(--dot-needs)] leading-relaxed whitespace-pre-wrap break-words">
                      {w.stuckMessage}
                    </p>
                  </div>
                ))}
              </div>
            </Section>
          )}

          {/* Debug: Session Routing */}
          <Section title="Session Routing" badge={debug ? `${Object.keys(debug.sessionToWorker).length} sessions` : undefined}>
            {debug ? (
              <div className="space-y-1">
                {Object.entries(debug.sessionToWorker).length === 0 ? (
                  <p className="text-[11px] text-[var(--text-light)]">
                    No active sessions
                  </p>
                ) : (
                  Object.entries(debug.sessionToWorker).map(([sid, wid]) => (
                    <div
                      key={sid}
                      className="flex items-center gap-2 text-[11px]"
                    >
                      <span className="text-[var(--text-light)] font-mono">
                        {truncateId(sid)}
                      </span>
                      <span className="text-[var(--text-muted)]">&rarr;</span>
                      <span className="text-[var(--text)]">
                        {truncateId(wid)}
                      </span>
                    </div>
                  ))
                )}
                {Object.keys(debug.pendingHookQueue).length > 0 && (
                  <div className="mt-2 pt-2 border-t border-[var(--border)]">
                    <p className="text-[10px] text-[var(--text-light)] mb-1">
                      Pending hook queues:
                    </p>
                    {Object.entries(debug.pendingHookQueue).map(
                      ([sid, count]) => (
                        <div
                          key={sid}
                          className="flex items-center gap-2 text-[11px]"
                        >
                          <span className="text-[var(--text-light)]">
                            {sid}
                          </span>
                          <span className="text-[var(--dot-needs)]">
                            {count} queued
                          </span>
                        </div>
                      ),
                    )}
                  </div>
                )}
              </div>
            ) : (
              <p className="text-[11px] text-[var(--text-light)]">
                No data yet
              </p>
            )}
          </Section>

          {/* Debug: Hook Times */}
          <Section title="Hook Times" badge={debug ? `${Object.keys(debug.lastHookTime).length} workers` : undefined}>
            {debug ? (
              <div className="space-y-1">
                {Object.entries(debug.lastHookTime).length === 0 ? (
                  <p className="text-[11px] text-[var(--text-light)]">
                    No hook data
                  </p>
                ) : (
                  Object.entries(debug.lastHookTime).map(([wid, ts]) => (
                    <div
                      key={wid}
                      className="flex items-center gap-2 text-[11px]"
                    >
                      <span className="text-[var(--text)] font-medium">
                        {truncateId(wid)}
                      </span>
                      <span className="text-[var(--text-muted)]">
                        {timeAgo(ts)}
                      </span>
                    </div>
                  ))
                )}
              </div>
            ) : (
              <p className="text-[11px] text-[var(--text-light)]">
                No data yet
              </p>
            )}
          </Section>

          {/* Signals */}
          <Section title="Signals" badge={selectedWorkerId ? truncateId(selectedWorkerId) : "select worker"}>
            <div className="space-y-2">
              {/* Worker picker */}
              {workerList.length > 0 ? (
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {workerList.map((w) => (
                    <button
                      key={w.id}
                      type="button"
                      onClick={() => setSelectedWorkerId(w.id)}
                      className={`text-[10px] px-2 py-0.5 rounded border transition-colors cursor-pointer ${
                        selectedWorkerId === w.id
                          ? "border-[var(--accent)] bg-[rgba(59,130,246,0.1)] text-[var(--text)]"
                          : "border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--text-light)]"
                      }`}
                    >
                      {w.projectName}
                      {w.quadrant ? ` Q${w.quadrant}` : ""}
                    </button>
                  ))}
                </div>
              ) : (
                <p className="text-[11px] text-[var(--text-light)]">
                  No workers available
                </p>
              )}

              {/* Signal list */}
              {selectedWorkerId && signalEntries.length > 0 ? (
                <div className="space-y-1">
                  {signalEntries.map((s, i) => (
                    <div
                      key={`${s.ts}-${i}`}
                      className="flex items-start gap-2 text-[11px]"
                    >
                      <span className="text-[var(--text-light)] shrink-0 min-w-[52px]">
                        {new Date(s.ts).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                          second: "2-digit",
                        })}
                      </span>
                      <span className="text-[var(--accent)] font-medium shrink-0">
                        {s.signal}
                      </span>
                      <span className="text-[var(--text-muted)] break-all">
                        {s.detail}
                      </span>
                    </div>
                  ))}
                </div>
              ) : selectedWorkerId ? (
                <p className="text-[11px] text-[var(--text-light)]">
                  No signals recorded
                </p>
              ) : null}
            </div>
          </Section>
        </div>
      </div>
    </div>
  );
}
