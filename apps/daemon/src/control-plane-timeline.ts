import { existsSync, readFileSync } from "fs";
import { basename, join } from "path";
import type { SessionStreamer } from "./session-stream.js";
import type { ControlPlaneTimelineEntry, ControlPlaneTimelineLink, WorkerState } from "./types.js";
import { extractRoutedContextPath, readControlPlaneAudit, summarizeTimelineText, type ControlPlaneAuditEntry } from "./control-plane-audit.js";

interface QuadrantAuditEntry {
  ts: string;
  tty?: string;
  workerId?: string;
  from?: string;
  to?: string;
  reason?: string;
  context?: Record<string, unknown>;
}

interface CollectorEvent {
  ts: number;
  type?: string;
  workerId?: string;
  toolName?: string;
  filePath?: string;
}

interface TimelineOptions {
  limit?: number;
  workers: WorkerState[];
  streamer: Pick<SessionStreamer, "getSessionFile">;
}

function hiveHome(): string {
  const home = process.env.HIVE_HOME || process.env.HOME || "";
  return join(home, ".hive");
}

function readJsonlTail<T>(filePath: string, maxLines: number): T[] {
  try {
    if (!existsSync(filePath)) return [];
    const raw = readFileSync(filePath, "utf-8").trim();
    if (!raw) return [];
    return raw
      .split("\n")
      .filter(Boolean)
      .slice(-Math.max(1, maxLines))
      .map((line) => JSON.parse(line) as T);
  } catch {
    return [];
  }
}

function routeLinks(contextPath?: string, outputPath?: string): ControlPlaneTimelineLink[] | undefined {
  const links: ControlPlaneTimelineLink[] = [];
  if (contextPath) {
    links.push({ kind: "context", label: basename(contextPath), path: contextPath });
  }
  if (outputPath) {
    links.push({ kind: "output", label: basename(outputPath), path: outputPath });
  }
  return links.length > 0 ? links : undefined;
}

function resolveWorkerMeta(
  workerId: string | undefined,
  tty: string | undefined,
  workersById: Map<string, WorkerState>,
  workersByTty: Map<string, WorkerState>,
) {
  const worker = workerId
    ? workersById.get(workerId)
    : (tty ? workersByTty.get(tty) : undefined);
  return {
    worker,
    workerLabel: worker?.quadrant ? `Q${worker.quadrant}` : worker?.tty || workerId || tty,
    machine: worker?.machine,
    machineLabel: worker?.machineLabel,
    quadrant: worker?.quadrant,
  };
}

function resolveOutputPath(
  streamer: Pick<SessionStreamer, "getSessionFile">,
  workerId: string | undefined,
  tty: string | undefined,
  workersById: Map<string, WorkerState>,
  workersByTty: Map<string, WorkerState>,
): string | undefined {
  if (workerId && !workerId.includes(":")) {
    return streamer.getSessionFile(workerId) || undefined;
  }
  const localWorker = tty ? workersByTty.get(tty) : undefined;
  if (localWorker && !localWorker.id.includes(":")) {
    return streamer.getSessionFile(localWorker.id) || undefined;
  }
  const localById = workerId ? workersById.get(workerId) : undefined;
  if (localById && !localById.id.includes(":")) {
    return streamer.getSessionFile(localById.id) || undefined;
  }
  return undefined;
}

function summarizeAuditEntry(entry: ControlPlaneAuditEntry, workerLabel?: string): string {
  switch (entry.type) {
    case "spawn":
      return `Spawned ${entry.action || "agent"}${entry.cwd ? ` in ${basename(entry.cwd)}` : ""}`;
    case "kill":
      return `Stopped ${workerLabel || entry.workerId || "worker"}`;
    case "exec":
      return `Ran control-plane command${entry.targetMachine && entry.targetMachine !== "local" ? ` on ${entry.targetMachine}` : ""}`;
    case "message":
      return `Sent message to ${workerLabel || entry.workerId || "worker"}`;
    case "route":
      return `Routed task to ${workerLabel || entry.workerId || "worker"}`;
    case "approval":
      return entry.action === "selection"
        ? `Approved ${workerLabel || entry.workerId || "worker"} with option ${entry.detail || "1"}`
        : `Approved prompt for ${workerLabel || entry.workerId || "worker"}`;
    case "satellite":
      return entry.action === "reconnected"
        ? `Satellite ${entry.targetMachine} reconnected`
        : entry.action === "disconnected"
          ? `Satellite ${entry.targetMachine} disconnected`
          : `Satellite ${entry.targetMachine} connected`;
    case "completion":
      return `${workerLabel || entry.workerId || "Worker"} returned to idle`;
    case "maintenance":
      return `Satellite maintenance: ${entry.action || "update"}`;
    default:
      return entry.summary || "Control-plane event";
  }
}

function detailForAuditEntry(entry: ControlPlaneAuditEntry): string | undefined {
  if (entry.error) return entry.error;
  if (entry.type === "exec") return summarizeTimelineText(entry.command);
  if (entry.type === "message" || entry.type === "route") return summarizeTimelineText(entry.detail || entry.summary);
  if (entry.type === "completion") return summarizeTimelineText(entry.detail || entry.summary);
  if (entry.type === "approval") return summarizeTimelineText(entry.detail || entry.summary);
  if (entry.type === "spawn") return entry.cwd;
  if (entry.type === "maintenance") return summarizeTimelineText(entry.detail || entry.action);
  if (entry.type === "satellite") return summarizeTimelineText(entry.detail);
  return summarizeTimelineText(entry.detail || entry.summary);
}

function fromAuditEntries(
  entries: ControlPlaneAuditEntry[],
  workersById: Map<string, WorkerState>,
  workersByTty: Map<string, WorkerState>,
  streamer: Pick<SessionStreamer, "getSessionFile">,
): ControlPlaneTimelineEntry[] {
  return entries.map((entry) => {
    const meta = resolveWorkerMeta(entry.workerId, entry.tty, workersById, workersByTty);
    const contextPath = entry.contextPath || extractRoutedContextPath(entry.detail || entry.summary);
    const outputPath = entry.outputPath || resolveOutputPath(streamer, entry.workerId, entry.tty, workersById, workersByTty);
    return {
      id: `audit:${entry.ts}:${entry.type}:${entry.workerId || entry.tty || entry.targetMachine}:${entry.action || ""}`,
      ts: entry.ts,
      type: entry.type,
      workerId: entry.workerId,
      workerLabel: meta.workerLabel,
      quadrant: meta.quadrant,
      machine: meta.machine || entry.targetMachine || "local",
      machineLabel: meta.machineLabel,
      summary: entry.summary || summarizeAuditEntry(entry, meta.workerLabel),
      detail: detailForAuditEntry(entry),
      ok: entry.ok,
      links: routeLinks(contextPath, outputPath),
    };
  });
}

function fromCollectorRoutes(
  workersById: Map<string, WorkerState>,
  workersByTty: Map<string, WorkerState>,
  streamer: Pick<SessionStreamer, "getSessionFile">,
  limit: number,
): ControlPlaneTimelineEntry[] {
  const collectorPath = join(hiveHome(), "collector", "events.jsonl");
  const events = readJsonlTail<CollectorEvent>(collectorPath, limit * 8);
  return events
    .filter((entry) =>
      entry.type === "tool_start"
      && entry.toolName === "Read"
      && typeof entry.filePath === "string"
      && entry.filePath.includes("/.hive/context-messages/")
    )
    .map((entry) => {
      const worker = entry.workerId ? workersById.get(entry.workerId) : undefined;
      const meta = resolveWorkerMeta(entry.workerId, worker?.tty, workersById, workersByTty);
      const outputPath = resolveOutputPath(streamer, entry.workerId, worker?.tty, workersById, workersByTty);
      return {
        id: `collector-route:${entry.ts}:${entry.workerId}:${entry.filePath}`,
        ts: entry.ts,
        type: "route" as const,
        workerId: entry.workerId,
        workerLabel: meta.workerLabel,
        quadrant: meta.quadrant,
        machine: meta.machine || "local",
        machineLabel: meta.machineLabel,
        summary: `Opened routed context for ${meta.workerLabel || entry.workerId || "worker"}`,
        detail: basename(entry.filePath || ""),
        links: routeLinks(entry.filePath, outputPath),
      };
    });
}

function fromQuadrantAudit(
  workersById: Map<string, WorkerState>,
  workersByTty: Map<string, WorkerState>,
  streamer: Pick<SessionStreamer, "getSessionFile">,
  limit: number,
): ControlPlaneTimelineEntry[] {
  const auditPath = join(hiveHome(), "quadrant-audit.log");
  const entries = readJsonlTail<QuadrantAuditEntry>(auditPath, limit * 8);
  return entries
    .filter((entry) => entry.from === "working" && entry.to === "idle")
    .map((entry) => {
      const tty = entry.tty?.startsWith("/dev/") ? entry.tty.replace("/dev/", "") : entry.tty;
      const meta = resolveWorkerMeta(entry.workerId, tty, workersById, workersByTty);
      const outputPath = resolveOutputPath(streamer, entry.workerId, tty, workersById, workersByTty);
      const detail = typeof entry.context?.tailAction === "string"
        ? String(entry.context?.tailAction)
        : typeof entry.context?.action === "string"
          ? String(entry.context?.action)
          : entry.reason;
      const contextPath = extractRoutedContextPath(meta.worker?.lastDirection);
      return {
        id: `quadrant:${entry.ts}:${entry.workerId || tty || "unknown"}`,
        ts: Date.parse(entry.ts),
        type: "completion" as const,
        workerId: entry.workerId || meta.worker?.id,
        workerLabel: meta.workerLabel,
        quadrant: meta.quadrant,
        machine: "local",
        machineLabel: meta.machineLabel,
        summary: `${meta.workerLabel || tty || "Worker"} returned to idle`,
        detail: summarizeTimelineText(detail),
        links: routeLinks(contextPath, outputPath),
      };
    });
}

export function buildControlPlaneTimeline({
  limit = 80,
  workers,
  streamer,
}: TimelineOptions): ControlPlaneTimelineEntry[] {
  const normalizedLimit = Number.isFinite(limit) ? Math.max(10, Math.min(200, Math.trunc(limit))) : 80;
  const workersById = new Map(workers.map((worker) => [worker.id, worker]));
  const workersByTty = new Map(
    workers
      .filter((worker) => !!worker.tty)
      .map((worker) => [worker.tty!.replace("/dev/", ""), worker]),
  );

  const timeline = [
    ...fromAuditEntries(readControlPlaneAudit(normalizedLimit * 3), workersById, workersByTty, streamer),
    ...fromCollectorRoutes(workersById, workersByTty, streamer, normalizedLimit),
    ...fromQuadrantAudit(workersById, workersByTty, streamer, normalizedLimit),
  ];

  const deduped = new Map<string, ControlPlaneTimelineEntry>();
  for (const entry of timeline) {
    const key = `${entry.type}|${entry.workerId || ""}|${entry.summary}|${Math.round(entry.ts / 1000)}`;
    const existing = deduped.get(key);
    if (!existing || existing.ts < entry.ts) {
      deduped.set(key, entry);
    }
  }

  return [...deduped.values()]
    .sort((a, b) => b.ts - a.ts)
    .slice(0, normalizedLimit);
}
