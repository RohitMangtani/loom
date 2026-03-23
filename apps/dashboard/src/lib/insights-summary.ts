import type { ReviewItem, WorkerState } from "@/lib/types";

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

export function buildSummary(
  allWorkers: WorkerState[],
  reviews: ReviewItem[],
  activity: { text: string; timestamp: number } | null,
): string {
  const working = allWorkers.filter((w) => w.status === "working");
  const idle = allWorkers.filter((w) => w.status === "idle");
  const stuck = allWorkers.filter((w) => w.status === "stuck");
  const total = allWorkers.length;
  const models = [...new Set(allWorkers.map((w) => w.model || "claude"))];
  const projects = [
    ...new Set(
      allWorkers
        .map((w) => w.projectName)
        .filter((p) => p && p !== "unknown" && p !== "home"),
    ),
  ];

  const lines: string[] = [];

  if (working.length === 0 && total > 0) {
    lines.push(`All ${total} agents are idle. Nothing is running.`);
  } else if (working.length === total) {
    lines.push(`All ${total} agents are working. Full fleet active.`);
  } else if (total === 0) {
    lines.push("No agents connected.");
  } else {
    lines.push(
      `${working.length} of ${total} agents working. ${idle.length} idle${
        stuck.length > 0 ? `, ${stuck.length} stuck` : ""
      }.`,
    );
  }

  if (working.length > 0) {
    lines.push("");
    for (const w of working) {
      const model = w.model && w.model !== "claude" ? ` (${w.model})` : "";
      const action = w.currentAction || w.lastAction || "working";
      lines.push(`Q${w.quadrant}${model} on ${w.projectName}: ${action}`);
    }
  }

  const todayReviews = reviews.filter((r) => Date.now() - r.createdAt < 86_400_000);
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

  if (idle.length > 0 && working.length > 0) {
    lines.push("");
    const idleNames = idle.map((w) => {
      const model = w.model && w.model !== "claude" ? ` ${w.model}` : "";
      return `Q${w.quadrant}${model}`;
    });
    lines.push(`Available: ${idleNames.join(", ")}`);
  }

  if (models.length > 1 || projects.length > 1) {
    lines.push("");
    if (models.length > 1) lines.push(`Models: ${models.join(", ")}`);
    if (projects.length > 0) lines.push(`Projects: ${projects.join(", ")}`);
  }

  if (activity) {
    lines.push("");
    lines.push(`Last action: ${activity.text} (${timeAgo(activity.timestamp)})`);
  }

  return lines.join("\n");
}

export function buildHeadlineSummary(
  allWorkers: WorkerState[],
  reviews: ReviewItem[],
  activity: { text: string; timestamp: number } | null,
): string {
  const total = allWorkers.length;
  if (total === 0) {
    return "No agents connected yet. Start Claude, Codex, or OpenClaw and this panel will become your portfolio snapshot.";
  }

  const working = allWorkers.filter((w) => w.status === "working");
  const idle = allWorkers.filter((w) => w.status === "idle");
  const stuck = allWorkers.filter((w) => w.status === "stuck");
  const todayReviews = reviews.filter((r) => Date.now() - r.createdAt < 86_400_000);
  const parts: string[] = [];

  if (working.length === total) {
    parts.push(`Full fleet: ${total} agents working.`);
  } else if (working.length === 0) {
    parts.push(`Fleet idle: ${idle.length} agent${idle.length === 1 ? " is" : "s are"} waiting.`);
  } else {
    parts.push(
      `Currently ${working.length} of ${total} agents are active, ${idle.length} idle${
        stuck.length > 0 ? `, ${stuck.length} needing attention` : ""
      }.`,
    );
  }

  if (todayReviews.length > 0) {
    parts.push(`${todayReviews.length} update${todayReviews.length === 1 ? "" : "s"} shipped today.`);
  } else {
    parts.push("No ships logged today yet.");
  }

  if (activity) {
    const snippet = activity.text.replace(/\s+/g, " ").trim();
    parts.push(`Last action: ${snippet} (${timeAgo(activity.timestamp)}).`);
  }

  return parts.join(" ");
}
