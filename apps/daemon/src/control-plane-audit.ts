import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, join } from "path";

export type ControlPlaneAuditType =
  | "exec"
  | "maintenance"
  | "spawn"
  | "kill"
  | "message"
  | "route"
  | "approval"
  | "satellite"
  | "completion";

export interface ControlPlaneAuditEntry {
  ts: number;
  type: ControlPlaneAuditType;
  sourceMachine?: string;
  targetMachine: string;
  command?: string;
  cwd?: string;
  action?: string;
  workerId?: string;
  tty?: string;
  summary?: string;
  detail?: string;
  source?: string;
  contextPath?: string;
  outputPath?: string;
  ok?: boolean;
  exitCode?: number | null;
  timedOut?: boolean;
  durationMs?: number;
  error?: string;
}

const HIVE_ROUTING_RE = /Read (\/Users\/[^ ]+\/\.hive\/context-messages\/msg-[\w-]+\.md) and follow it exactly\./;

function controlPlaneAuditPath(): string {
  const home = process.env.HIVE_HOME || process.env.HOME || "";
  return join(home, ".hive", "control-plane.log");
}

export function getControlPlaneAuditPath(): string {
  return controlPlaneAuditPath();
}

export function extractRoutedContextPath(text: string | null | undefined): string | undefined {
  if (!text) return undefined;
  const match = text.match(HIVE_ROUTING_RE);
  return match?.[1];
}

export function summarizeTimelineText(text: string | null | undefined, max = 180): string | undefined {
  if (!text) return undefined;
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 3)}...`;
}

export function appendControlPlaneAudit(entry: ControlPlaneAuditEntry): void {
  const auditPath = controlPlaneAuditPath();
  try {
    mkdirSync(dirname(auditPath), { recursive: true });
    appendFileSync(auditPath, `${JSON.stringify(entry)}\n`, "utf-8");
  } catch {
    // Audit logging is best-effort. Control-plane actions should still run.
  }
}

export function readControlPlaneAudit(limit = 100): ControlPlaneAuditEntry[] {
  const auditPath = controlPlaneAuditPath();
  try {
    if (!existsSync(auditPath)) return [];
    const raw = readFileSync(auditPath, "utf-8");
    const normalizedLimit = Number.isFinite(limit) ? Math.max(1, Math.min(500, Math.trunc(limit))) : 100;
    return raw
      .trim()
      .split("\n")
      .filter(Boolean)
      .slice(-normalizedLimit)
      .map((line) => JSON.parse(line) as ControlPlaneAuditEntry);
  } catch {
    return [];
  }
}
