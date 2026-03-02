"use client";

import type { WorkerState } from "@/lib/types";

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
  if (w.status === "stuck") return w.currentAction || "Needs input";
  if (w.status === "working") return w.currentAction || "Working...";
  return w.lastAction || "Idle";
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

/**
 * Parse quick-reply buttons from the worker state.
 * Priority: parse real options from stuckMessage > infer from currentAction > fallback
 */
export function quickButtons(w: WorkerState): { label: string; value: string }[] {
  const msg = w.stuckMessage || "";
  const reason = (w.currentAction || "").toLowerCase();

  if (reason.includes("permission")) {
    return [{ label: "Allow", value: "y" }, { label: "Deny", value: "n" }];
  }

  const numbered = msg.match(/(?:^|\n)\s*(?:\(?(\d)[.)]\s*|(\d)\s+(?:for|[-:])\s+)(.+)/gim);
  if (numbered && numbered.length >= 2) {
    return numbered.slice(0, 4).map((line) => {
      const m = line.match(/(\d)/);
      const num = m ? m[1] : "1";
      const labelPart = line.replace(/^\s*\(?(\d)[.)]\s*/, "").replace(/^\s*(\d)\s+(?:for|[-:])\s+/i, "").trim();
      const label = labelPart.length > 20 ? `${num}` : labelPart || num;
      return { label, value: num };
    });
  }

  if (msg.match(/\b(y\/n|yes\/no)\b/i) || reason.includes("proceed") || reason.includes("approve") || reason.includes("plan")) {
    return [{ label: "Yes", value: "y" }, { label: "No", value: "n" }];
  }

  return [{ label: "1", value: "1" }, { label: "2", value: "2" }, { label: "3", value: "3" }, { label: "4", value: "4" }];
}

export { dotColor, DOT_BG, statusLabel, statusWord, badgeStyle };
export type { DotColor };

export function AgentCard({
  worker, num, selected, onClick, onSend,
}: {
  worker: WorkerState; num: number; selected: boolean; onClick: () => void; onSend: (msg: string) => void;
}) {
  const color = dotColor(worker);
  const stuck = color === "yellow";
  const buttons = stuck ? quickButtons(worker) : [];
  const idle = color === "red";

  return (
    <div
      onClick={onClick}
      className={`card relative ${stuck ? "card-stuck" : ""} ${selected ? "card-selected" : ""}`}
      style={{ borderLeftColor: DOT_BG[color] }}
    >
      <div className="flex items-center gap-2.5 mb-1.5">
        <span className="text-lg font-bold tabular-nums text-[var(--text)]">{num}</span>
        <span
          className={`w-2 h-2 rounded-full shrink-0 ${stuck ? "animate-pulse" : ""}`}
          style={{ background: DOT_BG[color] }}
        />
        <span className="text-[10px] font-medium px-1.5 py-px rounded ml-auto" style={badgeStyle(color)}>
          {statusWord(worker)}
        </span>
      </div>

      <p className="text-[10px] text-[var(--text-light)] truncate mb-0.5">{worker.projectName}</p>

      <p className={`text-[11px] leading-tight ${stuck ? "text-[#fbbf24] font-medium" : "text-[var(--text-muted)] truncate"}`}>
        {stuck && worker.stuckMessage
          ? <span className="line-clamp-2">{worker.stuckMessage.split("\n")[0].slice(0, 80)}</span>
          : statusLabel(worker)}
      </p>

      {!stuck && worker.lastDirection && (
        <p className="text-[10px] text-[var(--text-muted)] truncate opacity-50 mt-0.5">
          {worker.lastDirection}
        </p>
      )}

      {stuck && (worker.managed || !!worker.tty) && buttons.length > 0 && (
        <div className="flex items-center gap-1 mt-2 flex-wrap" onClick={(e) => e.stopPropagation()}>
          {buttons.map((b) => (
            <button
              key={b.value}
              type="button"
              onClick={(e) => { e.stopPropagation(); onSend(b.value); }}
              className="quick-reply-btn"
            >
              {b.label}
            </button>
          ))}
        </div>
      )}

      {idle && (
        <div className="ready-overlay absolute inset-0 flex items-center justify-center pointer-events-none rounded-[10px]">
          <span className="text-4xl font-bold tracking-[0.25em] uppercase text-white opacity-[0.16]">
            READY
          </span>
        </div>
      )}
    </div>
  );
}
