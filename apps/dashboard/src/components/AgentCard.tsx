"use client";

import { useEffect, useRef, useState } from "react";
import type { WorkerContextSnapshot, WorkerState } from "@/lib/types";

type DotColor = "green" | "yellow" | "red";

function dotColor(w: WorkerState): DotColor {
  if (w.status === "working") return "green";
  if (w.status === "stuck") return "yellow";
  return "red";
}

const DOT_BG: Record<DotColor, string> = {
  green: "var(--dot-active)",
  yellow: "var(--dot-needs)",
  red: "var(--dot-offline)",
};

function statusLabel(w: WorkerState): string {
  const primary = primarySummary(w);
  if (primary) return primary;
  if (w.status === "stuck") return "Needs input";
  if (w.status === "working") return "Working...";
  return "Idle";
}

function statusWord(w: WorkerState): string {
  if (w.status === "working") return "Active";
  if (w.status === "stuck") return "Waiting";
  return "Idle";
}

function badgeStyle(color: DotColor) {
  const map = {
    green: { background: "rgba(34,197,94,0.12)", color: "#4ade80" },
    yellow: { background: "rgba(234,179,8,0.12)", color: "#fbbf24" },
    red: { background: "rgba(220,38,38,0.12)", color: "#f87171" },
  };
  return map[color];
}

function truncateText(text: string, max = 72): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function stripIdentityPrefix(text: string): string {
  return text.replace(/^\[[^\]]+\]\s*/, "").trim();
}

function normalizeSummary(text: string | null | undefined): string | null {
  if (!text) return null;

  let value = stripIdentityPrefix(text)
    .replace(/\s+/g, " ")
    .trim();

  if (!value) return null;

  if (/^read\s+\/Users\/.*\/\.hive\/context-messages\/msg-[^/\s]+\.md/i.test(value) ||
      /^reading\s+msg-[^/\s]+\.md$/i.test(value)) {
    return "Reviewing routed task";
  }

  if (/^read\s+\/Users\/.*~?\/?\.hive\/workers\.json/i.test(value) ||
      /^cat\s+~\/\.hive\/workers\.json/i.test(value)) {
    return "Checking worker status";
  }

  value = value
    .replace(/\/Users\/[^/\s]+\/\.hive\/context-messages\/msg-[^/\s]+\.md/g, "routed task")
    .replace(/\/Users\/[^/\s]+\/factory\/projects\/([^/\s]+)\/([^\s]+)/g, "$2")
    .replace(/\/Users\/[^/\s]+\/([^/\s]+)/g, "$1");

  if (/^thinking\.\.\.$/i.test(value) || /^working\.\.\.$/i.test(value)) return null;
  if (/^received prompt$/i.test(value)) return null;
  if (/^running command$/i.test(value)) return null;

  return truncateText(value);
}

function primarySummary(w: WorkerState): string | null {
  const action = normalizeSummary(w.status === "working" ? w.currentAction : w.lastAction);
  const direction = normalizeSummary(w.lastDirection);

  if (w.status === "stuck") return action || direction;
  if (w.status === "working") return action || direction;
  return action || direction;
}

function secondarySummary(w: WorkerState): string | null {
  if (w.status === "stuck") return null;

  const primary = primarySummary(w);
  const action = normalizeSummary(w.status === "working" ? w.currentAction : w.lastAction);
  const direction = normalizeSummary(w.lastDirection);

  if (direction && direction !== primary) return direction;
  if (w.status === "working" && action && action !== primary) return action;
  return null;
}

/** Whether this stuck state needs selection keystrokes vs text input */
export function isSelectionStuck(w: WorkerState): boolean {
  const action = (w.currentAction || "").toLowerCase();
  // Match both raw tool names and friendly descriptions from describeAction()
  return action.includes("asking") || action.includes("question") ||
    action === "askuserquestion" || action === "enterplanmode" ||
    action === "exitplanmode" || action.includes("plan mode") ||
    action.includes("approval");
}

/**
 * Parse quick-reply buttons from the worker state.
 * For selection UIs (AskUserQuestion etc.), buttons use `index` to send
 * arrow-key selection via sendSelectionToTty. For text prompts, buttons
 * send text via sendInputToTty.
 */
export function quickButtons(w: WorkerState): { label: string; value: string; index?: number }[] {
  const msg = w.stuckMessage || "";
  const reason = (w.currentAction || "").toLowerCase();
  const isSelection = isSelectionStuck(w);

  if (reason.includes("permission")) {
    return [{ label: "Allow", value: "y" }, { label: "Deny", value: "n" }];
  }

  // Parse numbered options from stuckMessage: "1. Green\n2. Blue\n3. Red"
  const numbered = msg.match(/(?:^|\n)\s*(?:\(?(\d)[.)]\s*|(\d)\s+(?:for|[-:])\s+)(.+)/gim);
  if (numbered && numbered.length >= 2) {
    return numbered.slice(0, 4).map((line, i) => {
      const m = line.match(/(\d)/);
      const num = m ? m[1] : "1";
      const labelPart = line.replace(/^\s*\(?(\d)[.)]\s*/, "").replace(/^\s*(\d)\s+(?:for|[-:])\s+/i, "").trim();
      const label = labelPart.length > 20 ? `${num}` : labelPart || num;
      // Selection UIs need arrow-key index, text UIs need the number string
      return isSelection
        ? { label, value: num, index: i }
        : { label, value: num };
    });
  }

  // EnterPlanMode / ExitPlanMode — just approve
  if (isSelection) {
    return [{ label: "Approve", value: "0", index: 0 }];
  }

  if (msg.match(/\b(y\/n|yes\/no)\b/i) || reason.includes("proceed") || reason.includes("approve") || reason.includes("plan")) {
    return [{ label: "Yes", value: "y" }, { label: "No", value: "n" }];
  }

  return [{ label: "1", value: "1" }, { label: "2", value: "2" }, { label: "3", value: "3" }, { label: "4", value: "4" }];
}

/**
 * Suggest next-step actions for idle agents based on their last action.
 * Pattern-matches on lastAction (set by daemon describeAction).
 * No AI call — pure string matching.
 */
function idleSuggestions(w: WorkerState): { label: string; message: string }[] {
  const last = (w.lastAction || "").toLowerCase();

  // After file edits
  if (last.includes("edit") || last.includes("creat") || last.includes("writ")) {
    return [
      { label: "Run tests", message: "Run the test suite and fix any failures" },
      { label: "Commit", message: "Commit your recent changes with a descriptive message" },
      { label: "Review diff", message: "Show me a git diff of your recent changes" },
    ];
  }

  // After committing / pushing
  if (last.includes("commit") || last.includes("push")) {
    return [
      { label: "Push", message: "Push your commits to the remote" },
      { label: "Next task", message: "What should be done next in this project?" },
    ];
  }

  // After reading / exploring
  if (last.includes("read") || last.includes("search") || last.includes("glob") || last.includes("grep") || last.includes("exploring")) {
    return [
      { label: "Implement", message: "Based on what you explored, implement the necessary changes" },
      { label: "Summarize", message: "Summarize what you found" },
    ];
  }

  // After running commands (tests, builds, scripts)
  if (last.includes("running") || last.includes("command") || last.includes("bash") || last.includes("test")) {
    return [
      { label: "Fix issues", message: "Fix any issues from the last command run" },
      { label: "Continue", message: "Continue with the next step" },
    ];
  }

  // After receiving a message / finishing dispatched task
  if (last.includes("received") || last.includes("message") || last.includes("finished")) {
    return [
      { label: "Continue", message: "Continue working on the task you were given" },
    ];
  }

  // Default — no specific context
  return [
    { label: "Status", message: "What's the current state of this project? What needs to be done?" },
    { label: "Continue", message: "Continue where you left off" },
  ];
}

/** Display name for the worker's model (e.g. "Claude", "Codex", "OpenClaw"). */
function modelLabel(w: WorkerState): string {
  const m = (w.model || "claude").toLowerCase();
  if (m === "openclaw") return "OpenClaw";
  return m.charAt(0).toUpperCase() + m.slice(1);
}

function summarizeMessage(text: string | undefined, max = 96): string | null {
  if (!text) return null;
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  return cleaned.length > max ? `${cleaned.slice(0, max - 3)}...` : cleaned;
}

function latestByRole(context: WorkerContextSnapshot | null | undefined, role: "user" | "agent") {
  if (!context) return null;
  for (let i = context.recentMessages.length - 1; i >= 0; i--) {
    if (context.recentMessages[i]?.role === role) return context.recentMessages[i];
  }
  return null;
}

export { dotColor, DOT_BG, statusLabel, statusWord, badgeStyle, idleSuggestions, modelLabel };
export type { DotColor };

const FLAG_COLOR = "#f97316";

export function AgentCard({
  worker, num, selected, flagged, managing, context, onClick, onPointerDown, onSend, onSelect, onFlag, onSuggestionApply, onApprovePrompt, onKill, onRequestContext, onOpenOutput,
}: {
  worker: WorkerState; num: number; selected: boolean; flagged?: boolean; managing?: boolean; context?: WorkerContextSnapshot | null; onClick: () => void; onPointerDown?: () => void; onSend: (msg: string) => void; onSelect?: (index: number) => void; onFlag?: () => void; onSuggestionApply?: (appliedLabel: string, shownLabels: string[]) => void; onApprovePrompt?: () => void; onKill?: () => void; onRequestContext?: () => void; onOpenOutput?: () => void;
}) {
  const [logsOpen, setLogsOpen] = useState(false);
  const [finishedPulse, setFinishedPulse] = useState(false);
  const prevStatusRef = useRef(worker.status);
  const color = dotColor(worker);
  const stuck = color === "yellow";
  const buttons = stuck && !worker.promptType ? quickButtons(worker) : [];
  const idle = color === "red";
  const hasPrompt = !!worker.promptType;
  const secondary = secondarySummary(worker);
  const latestInstruction = latestByRole(context, "user");
  const latestOutput = latestByRole(context, "agent");
  const artifactPreview = context?.recentArtifacts.slice(0, 3) || [];

  useEffect(() => {
    if (logsOpen) onRequestContext?.();
  }, [logsOpen, onRequestContext, worker.lastActionAt]);

  useEffect(() => {
    const prev = prevStatusRef.current;
    if (prev === "working" && worker.status === "idle") {
      setFinishedPulse(true);
      const timer = window.setTimeout(() => setFinishedPulse(false), 1600);
      prevStatusRef.current = worker.status;
      return () => window.clearTimeout(timer);
    }
    prevStatusRef.current = worker.status;
  }, [worker.status]);

  return (
    <div
      onClick={managing ? undefined : onClick}
      onPointerDown={managing ? undefined : onPointerDown}
      className={`card relative ${stuck ? "card-stuck" : ""} ${selected && !managing ? "card-selected" : ""} ${hasPrompt ? "card-stuck" : ""} ${finishedPulse ? "card-finished" : ""}`}
      style={{ borderLeftColor: hasPrompt ? "#60a5fa" : flagged ? FLAG_COLOR : DOT_BG[color] }}
    >
      {finishedPulse && (
        <>
          <span className="completion-flash" aria-hidden="true" />
          <span className="completion-chip">Done</span>
        </>
      )}
      {managing && onKill && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onKill(); }}
          className="absolute top-1.5 right-1.5 w-6 h-6 flex items-center justify-center rounded-full transition-all duration-200 cursor-pointer hover:scale-110 z-20"
          style={{
            background: "rgba(239,68,68,0.15)",
            border: "1px solid rgba(239,68,68,0.3)",
            color: "#f87171",
          }}
          title={`Close Q${num}`}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M1 1L9 9M9 1L1 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      )}
      {!managing && onFlag && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onFlag(); }}
          className="absolute top-2 right-2 w-4 h-4 rounded-full border transition-all duration-200 cursor-pointer hover:scale-110 z-10"
          style={{
            borderColor: flagged ? FLAG_COLOR : "var(--border)",
            background: flagged ? FLAG_COLOR : "transparent",
          }}
          title={flagged ? "Unflag" : "Flag for later"}
        />
      )}
      <div className={`flex items-center gap-2.5 mb-1.5 ${onFlag ? "pr-5" : ""}`}>
        <span className="text-lg font-bold tabular-nums text-[var(--text)]">{num}</span>
        <span className="text-[9px] font-mono text-[var(--text-muted)] uppercase tracking-wider">{modelLabel(worker)}</span>
        {worker.machine && (
          <span className="text-[8px] font-mono px-1 py-px rounded" style={{ background: "rgba(96,165,250,0.12)", color: "#93bbfd" }}>
            {worker.machine}
          </span>
        )}
        <span
          className={`w-2 h-2 rounded-full shrink-0 ${hasPrompt ? "animate-pulse" : stuck ? "animate-pulse" : ""}`}
          style={{ background: hasPrompt ? "#60a5fa" : flagged ? FLAG_COLOR : DOT_BG[color] }}
        />
        {color === "green" && !hasPrompt && (
          <span className="shrink-0 opacity-60" title="Active chat">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M2 3a1 1 0 011-1h10a1 1 0 011 1v7a1 1 0 01-1 1H6l-3 3V11H3a1 1 0 01-1-1V3z" fill="var(--dot-active)" fillOpacity="0.5" stroke="var(--dot-active)" strokeWidth="1" />
            </svg>
          </span>
        )}
        {(hasPrompt || flagged) && (
          <span className="text-[10px] font-medium px-1.5 py-px rounded ml-auto" style={hasPrompt ? { background: "rgba(96,165,250,0.12)", color: "#60a5fa" } : { background: "rgba(249,115,22,0.12)", color: FLAG_COLOR }}>
            {hasPrompt ? "Approval needed" : "Flagged"}
          </span>
        )}
      </div>

      {/* Project name omitted — tiles show only agent + description */}

      {hasPrompt ? (
        <>
          {onApprovePrompt && (
            <div className="flex items-center gap-1 mt-1.5" onClick={(e) => e.stopPropagation()}>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onApprovePrompt();
                }}
                className="quick-reply-btn"
                style={{ background: "rgba(96,165,250,0.15)", borderColor: "rgba(96,165,250,0.3)", color: "#93bbfd" }}
              >
                {worker.promptType === "trust" ? "Trust folder" : "Allow"}
              </button>
            </div>
          )}
        </>
      ) : (
        <>
          <p className={`text-[11px] leading-tight ${stuck ? "text-[#fbbf24] font-medium" : "text-[var(--text-muted)] truncate"}`}>
            {stuck && worker.stuckMessage
              ? <span className="line-clamp-2">{worker.stuckMessage.split("\n")[0].slice(0, 80)}</span>
              : statusLabel(worker)}
          </p>

          {!stuck && secondary && (
            <p className="text-[10px] leading-tight text-[var(--text-muted)] line-clamp-2 opacity-50 mt-0.5">
              {secondary}
            </p>
          )}

          {stuck && (worker.managed || !!worker.tty) && buttons.length > 0 && (
            <div className="flex items-center gap-1 mt-2 flex-wrap" onClick={(e) => e.stopPropagation()}>
              {buttons.map((b) => (
                <button
                  key={b.value}
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (b.index !== undefined && onSelect) {
                      onSelect(b.index);
                    } else {
                      onSend(b.value);
                    }
                  }}
                  className="quick-reply-btn"
                >
                  {b.label}
                </button>
              ))}
            </div>
          )}

          {(onRequestContext || onOpenOutput) && (
            <div className="mt-3 border-t border-[rgba(255,255,255,0.06)] pt-2.5" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setLogsOpen((open) => !open)}
                  className="tile-inline-btn"
                >
                  {logsOpen ? "Hide logs" : "Show logs"}
                </button>
                {onOpenOutput && (
                  <button
                    type="button"
                    onClick={() => {
                      onRequestContext?.();
                      onOpenOutput();
                    }}
                    className="tile-inline-btn tile-inline-btn-accent"
                  >
                    Jump to last output
                  </button>
                )}
              </div>

              {logsOpen && (
                <div className="mt-2.5 rounded-xl border border-[rgba(255,255,255,0.06)] bg-[rgba(255,255,255,0.03)] px-3 py-3">
                  {!context ? (
                    <p className="text-[10px] leading-5 text-[var(--text-light)]">Loading latest context...</p>
                  ) : (
                    <div className="space-y-2.5">
                      {latestInstruction && (
                        <div>
                          <p className="text-[9px] font-semibold uppercase tracking-[0.16em] text-[var(--text-light)]">Latest instruction</p>
                          <p className="mt-1 text-[11px] leading-5 text-[var(--text-muted)]">{summarizeMessage(latestInstruction.text, 140)}</p>
                        </div>
                      )}
                      {latestOutput && (
                        <div>
                          <p className="text-[9px] font-semibold uppercase tracking-[0.16em] text-[var(--text-light)]">Latest output</p>
                          <p className="mt-1 text-[11px] leading-5 text-[var(--text-muted)]">{summarizeMessage(latestOutput.text, 140)}</p>
                        </div>
                      )}
                      {artifactPreview.length > 0 && (
                        <div>
                          <p className="text-[9px] font-semibold uppercase tracking-[0.16em] text-[var(--text-light)]">Recent files</p>
                          <div className="mt-1 flex flex-wrap gap-1.5">
                            {artifactPreview.map((artifact) => (
                              <span key={`${artifact.path}:${artifact.ts}`} className="rounded-full border border-[rgba(59,130,246,0.2)] bg-[rgba(59,130,246,0.08)] px-2 py-1 text-[10px] text-[var(--text)]">
                                {artifact.path.split("/").slice(-2).join("/")}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                      {!latestInstruction && !latestOutput && artifactPreview.length === 0 && (
                        <p className="text-[10px] leading-5 text-[var(--text-light)]">{summarizeMessage(context.contextSummary, 200)}</p>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
