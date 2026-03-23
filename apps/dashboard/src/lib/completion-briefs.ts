"use client";

import type { ControlPlaneTimelineEntry, WorkerContextSnapshot, WorkerState } from "@/lib/types";

export interface CompletionBrief {
  id: string;
  kind: "worker" | "team";
  createdAt: number;
  completedAt: number;
  title: string;
  subtitle: string;
  originalAsk: string;
  highlights: string[];
  files: string[];
  outputSummary: string;
  nextActions: string[];
  workerId?: string;
  workerIds?: string[];
  model?: string;
  machineLabel?: string;
  teamRunId?: string;
  copyText: string;
}

export interface QuickStartRun {
  id: string;
  templateId: string;
  title: string;
  tasks: string[];
  model: string;
  machine?: string;
  machineLabel: string;
  createdAt: number;
  briefIds: string[];
  matchedTasks: string[];
  workerIds: string[];
  teamBriefId?: string;
}

function stripRoutingMetadata(text: string): string {
  return text
    .replace(/^# Hive Routed Message\s*/im, "")
    .replace(/^Target:.*$/gim, "")
    .replace(/^Model:.*$/gim, "")
    .replace(/^Created:.*$/gim, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function compactText(text: string | null | undefined, max = 220): string {
  if (!text) return "";
  const cleaned = stripRoutingMetadata(text).replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  return cleaned.length <= max ? cleaned : `${cleaned.slice(0, max - 3)}...`;
}

function latestByRole(context: WorkerContextSnapshot | null | undefined, role: "user" | "agent"): string {
  if (!context) return "";
  for (let i = context.recentMessages.length - 1; i >= 0; i--) {
    if (context.recentMessages[i]?.role === role) {
      return context.recentMessages[i]?.text || "";
    }
  }
  return "";
}

function normalizeModel(model?: string): string {
  if (!model) return "Agent";
  const lower = model.toLowerCase();
  if (lower === "openclaw") return "OpenClaw";
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function defaultNextActions(worker: WorkerState, files: string[], outputSummary: string): string[] {
  if (worker.suggestions && worker.suggestions.length > 0) {
    return worker.suggestions.slice(0, 3).map((item) => item.label);
  }
  if (files.length > 0) {
    return ["Review changed files", "Run verification or tests", "Decide whether to commit or hand off"];
  }
  if (outputSummary) {
    return ["Review the output", "Send the next prompt", "Delegate the follow-up task"];
  }
  return ["Open the latest result", "Decide the next step", "Send a follow-up prompt"];
}

export function buildWorkerCompletionBrief(
  worker: WorkerState,
  context: WorkerContextSnapshot | null | undefined,
  timelineEntries: ControlPlaneTimelineEntry[],
): CompletionBrief | null {
  const originalAsk = compactText(latestByRole(context, "user") || worker.lastDirection || worker.task || worker.lastAction, 240);
  const outputSummary = compactText(latestByRole(context, "agent") || context?.contextSummary || worker.lastAction, 320);
  const files = [...new Set((context?.recentArtifacts || []).map((artifact) => artifact.path))];

  if (!originalAsk && !outputSummary && files.length === 0) {
    return null;
  }

  const keyEvents = timelineEntries
    .filter((entry) => entry.workerId === worker.id && entry.type !== "completion")
    .slice(0, 4)
    .map((entry) => compactText(entry.summary, 120))
    .filter(Boolean);

  const highlights = keyEvents.length > 0
    ? keyEvents
    : [
        compactText(worker.lastAction, 120) || "Returned to idle",
        files.length > 0 ? `${files.length} file${files.length === 1 ? "" : "s"} changed` : "",
      ].filter(Boolean);

  const nextActions = defaultNextActions(worker, files, outputSummary);
  const title = `${worker.quadrant ? `Q${worker.quadrant}` : normalizeModel(worker.model)} finished`;
  const subtitle = `${worker.machineLabel || "This Mac"} · ${worker.projectName} · ${normalizeModel(worker.model)}`;
  const lines = [
    `Title: ${title}`,
    `Ask: ${originalAsk || "No prompt captured"}`,
    `Highlights: ${highlights.join(" | ") || "No key events captured"}`,
    `Files: ${files.join(", ") || "None"}`,
    `Output: ${outputSummary || "No output summary available"}`,
    `Next: ${nextActions.join(" | ")}`,
  ];

  return {
    id: `${worker.id}:${worker.lastActionAt}`,
    kind: "worker",
    createdAt: Date.now(),
    completedAt: worker.lastActionAt,
    title,
    subtitle,
    originalAsk: originalAsk || "No prompt captured",
    highlights,
    files,
    outputSummary: outputSummary || "No output summary available.",
    nextActions,
    workerId: worker.id,
    workerIds: [worker.id],
    model: worker.model,
    machineLabel: worker.machineLabel,
    copyText: lines.join("\n"),
  };
}

export function createQuickStartRun(input: {
  templateId: string;
  title: string;
  tasks: string[];
  model: string;
  machine?: string;
  machineLabel: string;
}): QuickStartRun {
  return {
    id: `quickstart:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    templateId: input.templateId,
    title: input.title,
    tasks: input.tasks,
    model: input.model,
    machine: input.machine,
    machineLabel: input.machineLabel,
    createdAt: Date.now(),
    briefIds: [],
    matchedTasks: [],
    workerIds: [],
  };
}

function normalizeMatch(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

export function matchesQuickStartTask(brief: CompletionBrief, task: string): boolean {
  const a = normalizeMatch(brief.originalAsk);
  const b = normalizeMatch(task);
  return a === b || a.includes(b) || b.includes(a);
}

export function attachBriefToRun(run: QuickStartRun, brief: CompletionBrief): QuickStartRun {
  if (brief.kind !== "worker" || run.briefIds.includes(brief.id)) return run;
  const matchedTask = run.tasks.find((task) => !run.matchedTasks.includes(task) && matchesQuickStartTask(brief, task));
  if (!matchedTask) return run;
  return {
    ...run,
    briefIds: [...run.briefIds, brief.id],
    matchedTasks: [...run.matchedTasks, matchedTask],
    workerIds: brief.workerId ? [...run.workerIds, brief.workerId] : run.workerIds,
  };
}

export function buildTeamCompletionBrief(run: QuickStartRun, memberBriefs: CompletionBrief[]): CompletionBrief {
  const files = [...new Set(memberBriefs.flatMap((brief) => brief.files))];
  const highlights = [
    `${memberBriefs.length} agents completed on ${run.machineLabel}`,
    ...memberBriefs.map((brief) => compactText(brief.outputSummary, 110)).filter(Boolean).slice(0, 3),
  ].slice(0, 4);
  const nextActions = [...new Set(memberBriefs.flatMap((brief) => brief.nextActions))].slice(0, 3);
  const outputSummary = compactText(memberBriefs.map((brief) => brief.outputSummary).join(" "), 360);
  const title = `${run.title} completed`;
  const subtitle = `${run.machineLabel} · ${normalizeModel(run.model)} · ${memberBriefs.length} agents`;
  const lines = [
    `Title: ${title}`,
    `Run: ${run.title}`,
    `Highlights: ${highlights.join(" | ")}`,
    `Files: ${files.join(", ") || "None"}`,
    `Output: ${outputSummary || "No output summary available"}`,
    `Next: ${nextActions.join(" | ") || "Review the briefs and choose the next step"}`,
  ];

  return {
    id: `team:${run.id}`,
    kind: "team",
    createdAt: Date.now(),
    completedAt: Math.max(...memberBriefs.map((brief) => brief.completedAt)),
    title,
    subtitle,
    originalAsk: run.title,
    highlights,
    files,
    outputSummary: outputSummary || "No output summary available.",
    nextActions: nextActions.length > 0 ? nextActions : ["Review the briefs", "Pick the next action", "Delegate the follow-up"],
    workerIds: run.workerIds,
    model: run.model,
    machineLabel: run.machineLabel,
    teamRunId: run.id,
    copyText: lines.join("\n"),
  };
}
