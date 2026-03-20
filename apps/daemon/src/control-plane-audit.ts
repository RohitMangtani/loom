import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, join } from "path";

export interface ControlPlaneAuditEntry {
  ts: number;
  type: "exec" | "maintenance" | "spawn" | "kill";
  sourceMachine?: string;
  targetMachine: string;
  command?: string;
  cwd?: string;
  action?: string;
  workerId?: string;
  ok?: boolean;
  exitCode?: number | null;
  timedOut?: boolean;
  durationMs?: number;
  error?: string;
}

function controlPlaneAuditPath(): string {
  const home = process.env.HIVE_HOME || process.env.HOME || "";
  return join(home, ".hive", "control-plane.log");
}

export function getControlPlaneAuditPath(): string {
  return controlPlaneAuditPath();
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
