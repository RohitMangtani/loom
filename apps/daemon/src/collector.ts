/**
 * Passive Coordination Intelligence Collector
 *
 * Logs every tool call, detects conflicts between agents, and computes
 * hourly coordination scores. Append-only JSONL output to ~/.hive/collector/.
 * Read-only  --  never blocks or modifies agent behavior.
 */

import { existsSync, mkdirSync, appendFileSync, readFileSync } from "fs";
import { join } from "path";
import type { Request, Response, NextFunction } from "express";
import type express from "express";
import { homedir } from "os";

const HOME = process.env.HOME || process.env.USERPROFILE || homedir();
const COLLECTOR_DIR = join(HOME, ".hive", "collector");

// Time windows
const WRITE_WRITE_WINDOW = 5 * 60 * 1000;   // 5 min  --  write-write conflict
const WRITE_WRITE_CRITICAL = 60 * 1000;      // 60s  --  escalate to critical
const READ_WRITE_WINDOW = 5 * 60 * 1000;     // 5 min  --  read-write staleness
const GIT_CONCURRENT_WINDOW = 2 * 60 * 1000; // 2 min  --  concurrent push
const STALE_EDIT_WINDOW = 10 * 60 * 1000;    // 10 min  --  edit failure correlation
const ANALYSIS_WINDOW = 30 * 60 * 1000;      // 30 min  --  in-memory retention
const HOURLY_INTERVAL = 60 * 60 * 1000;      // 1 hr  --  scoring interval

// ── Event types ──────────────────────────────────────────────────────────

interface CollectorEvent {
  ts: number;
  type: "tool_start" | "tool_end" | "tool_error" | "git_op";
  workerId: string;
  sessionId: string;
  toolName: string;
  filePath?: string;
  command?: string;
  duration?: number;
  error?: string;
  gitOp?: string;
  gitBranch?: string;
  gitRepo?: string;
}

interface ConflictEvent {
  id: string;
  ts: number;
  type: "write_write" | "read_write" | "git_concurrent_push" | "stale_edit";
  severity: "info" | "warning" | "critical";
  fileOrRepo: string;
  agents: Array<{ workerId: string; action: string; ts: number }>;
  description: string;
  wouldHaveBlocked: boolean;
}

interface ComplicationEvent {
  ts: number;
  type: "edit_failed" | "git_conflict" | "tool_error";
  workerId: string;
  filePath?: string;
  error: string;
  relatedConflict?: string;
}

interface HourlyScore {
  ts: number;
  window: string;
  totalToolCalls: number;
  totalFileOps: number;
  conflictsDetected: number;
  complicationsDetected: number;
  coordinationScore: number;
  activeAgents: number;
  filesSharedAcrossAgents: number;
}

// ── In-memory state ──────────────────────────────────────────────────────

interface FileOp {
  workerId: string;
  action: "read" | "write";
  ts: number;
}

interface GitOp {
  workerId: string;
  op: string;
  repo: string;
  ts: number;
}

// ── Collector ────────────────────────────────────────────────────────────

export class Collector {
  private recentEvents: CollectorEvent[] = [];
  private recentConflicts: ConflictEvent[] = [];
  private recentFileOps = new Map<string, FileOp[]>();
  private recentGitOps: GitOp[] = [];
  private inflight = new Map<string, { toolName: string; startTs: number }>();

  private lastHourlyTs = Date.now();
  private hourlyToolCalls = 0;
  private hourlyFileOps = 0;
  private hourlyConflicts = 0;
  private hourlyComplications = 0;

  constructor() {
    try {
      if (!existsSync(COLLECTOR_DIR)) {
        mkdirSync(COLLECTOR_DIR, { recursive: true });
      }
    } catch { /* non-critical */ }
  }

  // ── Public API ───────────────────────────────────────────────────────

  /** Log a hook event. Called from telemetry.processHook(). */
  record(workerId: string, sessionId: string, body: Record<string, unknown>): void {
    try {
      this.recordInner(workerId, sessionId, body);
    } catch { /* never crash the caller */ }
  }

  /** Run conflict detection + cleanup. Called every 3s from tick loop. */
  tick(): void {
    try {
      this.detectConflicts();
      this.cleanup();
      if (Date.now() - this.lastHourlyTs >= HOURLY_INTERVAL) {
        this.writeHourlyScore();
        this.lastHourlyTs = Date.now();
      }
    } catch { /* never crash the tick loop */ }
  }

  /** Mount read-only API routes on the express app. */
  registerRoutes(
    app: ReturnType<typeof express>,
    requireAuth: (req: Request, res: Response, next: NextFunction) => void,
  ): void {
    app.get("/api/collector/events", requireAuth, (req, res) => {
      const since = parseInt(req.query.since as string) || 0;
      const workerId = req.query.workerId as string | undefined;
      const toolName = req.query.toolName as string | undefined;
      let events = this.readJsonl<CollectorEvent>("events.jsonl", since);
      if (workerId) events = events.filter(e => e.workerId === workerId);
      if (toolName) events = events.filter(e => e.toolName === toolName);
      res.json({ count: events.length, events: events.slice(-500) });
    });

    app.get("/api/collector/conflicts", requireAuth, (req, res) => {
      const since = parseInt(req.query.since as string) || 0;
      const severity = req.query.severity as string | undefined;
      let conflicts = this.readJsonl<ConflictEvent>("conflicts.jsonl", since);
      if (severity) conflicts = conflicts.filter(c => c.severity === severity);
      res.json({ count: conflicts.length, conflicts });
    });

    app.get("/api/collector/complications", requireAuth, (req, res) => {
      const since = parseInt(req.query.since as string) || 0;
      const complications = this.readJsonl<ComplicationEvent>("complications.jsonl", since);
      res.json({ count: complications.length, complications });
    });

    app.get("/api/collector/score", requireAuth, (_req, res) => {
      const scores = this.readJsonl<HourlyScore>("hourly.jsonl", 0);
      res.json({ scores: scores.slice(-24) });
    });

    app.get("/api/collector/summary", requireAuth, (_req, res) => {
      const totalEvents = this.countJsonlLines("events.jsonl");
      const conflicts = this.readJsonl<ConflictEvent>("conflicts.jsonl", 0);
      const totalComplications = this.countJsonlLines("complications.jsonl");
      const scores = this.readJsonl<HourlyScore>("hourly.jsonl", 0);

      const criticalConflicts = conflicts.filter(c => c.severity === "critical").length;
      const latestScore = scores.length > 0 ? scores[scores.length - 1] : null;
      const recent3 = scores.slice(-3);
      const trend = recent3.length >= 2
        ? recent3[recent3.length - 1].coordinationScore - recent3[0].coordinationScore
        : 0;

      res.json({
        totalEvents,
        totalConflicts: conflicts.length,
        criticalConflicts,
        totalComplications,
        currentScore: latestScore?.coordinationScore ?? null,
        scoreTrend: trend,
        collectorRunning: true,
        dataDir: COLLECTOR_DIR,
      });
    });

    console.log("  Collector API: /api/collector/{events,conflicts,complications,score,summary}");
  }

  // ── Record logic ─────────────────────────────────────────────────────

  private recordInner(
    workerId: string,
    sessionId: string,
    body: Record<string, unknown>,
  ): void {
    const eventName = body.hook_event_name as string;
    const toolName = body.tool_name as string | undefined;
    const toolInput = body.tool_input as Record<string, unknown> | undefined;
    const cwd = body.cwd as string | undefined;

    if (!eventName || !toolName) return;

    const now = Date.now();

    switch (eventName) {
      case "PreToolUse": {
        const filePath = extractFilePath(toolName, toolInput);
        const command = toolName === "Bash" ? (toolInput?.command as string) : undefined;

        this.inflight.set(workerId, { toolName, startTs: now });

        const event: CollectorEvent = {
          ts: now, type: "tool_start", workerId, sessionId,
          toolName, filePath, command,
        };
        this.pushEvent(event);
        this.hourlyToolCalls++;

        // Track reads for read-write detection
        if (filePath && isReadTool(toolName)) {
          this.trackFileOp(filePath, workerId, "read", now);
        }

        // Detect git ops from Bash commands
        if (command) {
          const gitOp = parseGitOp(command);
          if (gitOp) {
            const gitEvent: CollectorEvent = {
              ts: now, type: "git_op", workerId, sessionId,
              toolName: "Bash", gitOp: gitOp.op, gitBranch: gitOp.branch, gitRepo: cwd,
            };
            this.pushEvent(gitEvent);
            this.recentGitOps.push({ workerId, op: gitOp.op, repo: cwd || "", ts: now });
          }
        }
        break;
      }

      case "PostToolUse": {
        const flight = this.inflight.get(workerId);
        const duration = flight ? now - flight.startTs : undefined;
        const filePath = extractFilePath(toolName, toolInput);

        this.inflight.delete(workerId);

        // Check for tool errors in the output
        const toolOutput = stringifyOutput(body.tool_output ?? body.tool_response ?? body.error);
        const hasError = toolOutput && isErrorOutput(toolName, toolOutput);

        if (hasError) {
          const errorEvent: CollectorEvent = {
            ts: now, type: "tool_error", workerId, sessionId,
            toolName, filePath, error: toolOutput.slice(0, 300),
          };
          this.pushEvent(errorEvent);
          this.recordComplication(workerId, filePath, toolOutput, toolName);
        } else {
          const event: CollectorEvent = {
            ts: now, type: "tool_end", workerId, sessionId,
            toolName, filePath, duration,
          };
          this.pushEvent(event);
        }

        // Track writes
        if (filePath && isWriteTool(toolName)) {
          this.trackFileOp(filePath, workerId, "write", now);
          this.hourlyFileOps++;
        }
        break;
      }
    }
  }

  // ── Conflict detection (runs every 3s) ───────────────────────────────

  private detectConflicts(): void {
    const now = Date.now();

    // 1. WRITE-WRITE: Two agents wrote the same file within 5 min
    for (const [filePath, ops] of this.recentFileOps) {
      const writes = ops.filter(o => o.action === "write");
      for (let i = 0; i < writes.length; i++) {
        for (let j = i + 1; j < writes.length; j++) {
          if (writes[i].workerId === writes[j].workerId) continue;
          const gap = Math.abs(writes[j].ts - writes[i].ts);
          if (gap > WRITE_WRITE_WINDOW) continue;

          const id = conflictId("ww", filePath, writes[i].workerId, writes[j].workerId, writes[i].ts);
          if (this.hasConflict(id)) continue;

          this.pushConflict({
            id, ts: now,
            type: "write_write",
            severity: gap < WRITE_WRITE_CRITICAL ? "critical" : "warning",
            fileOrRepo: filePath,
            agents: [
              { workerId: writes[i].workerId, action: "write", ts: writes[i].ts },
              { workerId: writes[j].workerId, action: "write", ts: writes[j].ts },
            ],
            description: `${writes[i].workerId} and ${writes[j].workerId} both wrote ${tail(filePath)} within ${Math.round(gap / 1000)}s`,
            wouldHaveBlocked: true,
          });
        }
      }
    }

    // 2. READ-WRITE: A read, then B writes the same file (stale data risk)
    for (const [filePath, ops] of this.recentFileOps) {
      const reads = ops.filter(o => o.action === "read");
      const writes = ops.filter(o => o.action === "write");

      for (const read of reads) {
        for (const write of writes) {
          if (read.workerId === write.workerId) continue;
          if (write.ts <= read.ts) continue;
          const gap = write.ts - read.ts;
          if (gap > READ_WRITE_WINDOW) continue;

          const id = conflictId("rw", filePath, read.workerId, write.workerId, read.ts);
          if (this.hasConflict(id)) continue;

          this.pushConflict({
            id, ts: now,
            type: "read_write",
            severity: "warning",
            fileOrRepo: filePath,
            agents: [
              { workerId: read.workerId, action: "read", ts: read.ts },
              { workerId: write.workerId, action: "write", ts: write.ts },
            ],
            description: `${read.workerId} read ${tail(filePath)}, then ${write.workerId} wrote it ${Math.round(gap / 1000)}s later`,
            wouldHaveBlocked: false,
          });
        }
      }
    }

    // 3. GIT CONCURRENT PUSH: Two agents pushed same repo within 2 min
    const pushCutoff = now - GIT_CONCURRENT_WINDOW;
    const pushes = this.recentGitOps.filter(o => o.op === "push" && o.ts > pushCutoff);
    for (let i = 0; i < pushes.length; i++) {
      for (let j = i + 1; j < pushes.length; j++) {
        if (pushes[i].workerId === pushes[j].workerId) continue;
        if (pushes[i].repo !== pushes[j].repo) continue;

        const id = conflictId("gp", pushes[i].repo, pushes[i].workerId, pushes[j].workerId, pushes[i].ts);
        if (this.hasConflict(id)) continue;

        this.pushConflict({
          id, ts: now,
          type: "git_concurrent_push",
          severity: "critical",
          fileOrRepo: pushes[i].repo,
          agents: [
            { workerId: pushes[i].workerId, action: "git push", ts: pushes[i].ts },
            { workerId: pushes[j].workerId, action: "git push", ts: pushes[j].ts },
          ],
          description: `${pushes[i].workerId} and ${pushes[j].workerId} both pushed ${tail(pushes[i].repo)} within ${Math.round(Math.abs(pushes[j].ts - pushes[i].ts) / 1000)}s`,
          wouldHaveBlocked: true,
        });
      }
    }
  }

  // ── Complications ────────────────────────────────────────────────────

  private recordComplication(
    workerId: string,
    filePath: string | undefined,
    error: string,
    toolName: string,
  ): void {
    const type: ComplicationEvent["type"] =
      toolName === "Edit" && /not found|not unique/i.test(error)
        ? "edit_failed"
        : /merge conflict|CONFLICT/i.test(error)
          ? "git_conflict"
          : "tool_error";

    // Correlate with recent conflicts on the same file
    let relatedConflict: string | undefined;
    if (filePath) {
      const match = this.recentConflicts.find(
        c => c.fileOrRepo === filePath && Date.now() - c.ts < STALE_EDIT_WINDOW,
      );
      relatedConflict = match?.id;

      // If edit failed and another agent wrote recently, log stale_edit conflict
      if (type === "edit_failed") {
        const ops = this.recentFileOps.get(filePath);
        const otherWrite = ops?.find(
          o => o.workerId !== workerId && o.action === "write" && Date.now() - o.ts < STALE_EDIT_WINDOW,
        );
        if (otherWrite) {
          const id = `se:${tail(filePath)}:${workerId}:${Date.now()}`;
          this.pushConflict({
            id, ts: Date.now(),
            type: "stale_edit",
            severity: "critical",
            fileOrRepo: filePath,
            agents: [
              { workerId, action: "edit_failed", ts: Date.now() },
              { workerId: otherWrite.workerId, action: "write", ts: otherWrite.ts },
            ],
            description: `${workerId}'s edit to ${tail(filePath)} failed  --  ${otherWrite.workerId} modified it ${Math.round((Date.now() - otherWrite.ts) / 1000)}s ago`,
            wouldHaveBlocked: true,
          });
          relatedConflict = id;
        }
      }
    }

    const complication: ComplicationEvent = {
      ts: Date.now(), type, workerId,
      filePath, error: error.slice(0, 500), relatedConflict,
    };
    this.appendJsonl("complications.jsonl", complication);
    this.hourlyComplications++;
  }

  // ── Hourly scoring ───────────────────────────────────────────────────

  private writeHourlyScore(): void {
    const now = Date.now();
    const hourAgo = now - HOURLY_INTERVAL;
    const windowStart = new Date(hourAgo).toISOString().slice(0, 16);
    const windowEnd = new Date(now).toISOString().slice(0, 16);

    const agentSet = new Set<string>();
    for (const ev of this.recentEvents) {
      if (ev.ts >= hourAgo) agentSet.add(ev.workerId);
    }

    let sharedFiles = 0;
    for (const [, ops] of this.recentFileOps) {
      const agents = new Set(ops.filter(o => o.ts >= hourAgo).map(o => o.workerId));
      if (agents.size >= 2) sharedFiles++;
    }

    const score = this.hourlyFileOps > 0
      ? Math.max(0, Math.round(100 - (this.hourlyConflicts / this.hourlyFileOps) * 100))
      : 100;

    const hourly: HourlyScore = {
      ts: now,
      window: `${windowStart}  --  ${windowEnd}`,
      totalToolCalls: this.hourlyToolCalls,
      totalFileOps: this.hourlyFileOps,
      conflictsDetected: this.hourlyConflicts,
      complicationsDetected: this.hourlyComplications,
      coordinationScore: score,
      activeAgents: agentSet.size,
      filesSharedAcrossAgents: sharedFiles,
    };
    this.appendJsonl("hourly.jsonl", hourly);

    // Reset counters
    this.hourlyToolCalls = 0;
    this.hourlyFileOps = 0;
    this.hourlyConflicts = 0;
    this.hourlyComplications = 0;

    console.log(`[collector] Hourly: score=${score}/100 conflicts=${hourly.conflictsDetected} fileOps=${hourly.totalFileOps} agents=${hourly.activeAgents}`);
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  private trackFileOp(filePath: string, workerId: string, action: "read" | "write", ts: number): void {
    if (!this.recentFileOps.has(filePath)) {
      this.recentFileOps.set(filePath, []);
    }
    this.recentFileOps.get(filePath)!.push({ workerId, action, ts });
  }

  private hasConflict(id: string): boolean {
    return this.recentConflicts.some(c => c.id === id);
  }

  private pushEvent(event: CollectorEvent): void {
    this.recentEvents.push(event);
    this.appendJsonl("events.jsonl", event);
  }

  private pushConflict(conflict: ConflictEvent): void {
    this.recentConflicts.push(conflict);
    this.appendJsonl("conflicts.jsonl", conflict);
    this.hourlyConflicts++;
    console.log(`[collector] ${conflict.severity.toUpperCase()} ${conflict.type}: ${conflict.description}`);
  }

  private appendJsonl(filename: string, data: unknown): void {
    try {
      appendFileSync(join(COLLECTOR_DIR, filename), JSON.stringify(data) + "\n");
    } catch { /* non-critical */ }
  }

  private readJsonl<T>(filename: string, since: number): T[] {
    try {
      const content = readFileSync(join(COLLECTOR_DIR, filename), "utf-8");
      const results: T[] = [];
      for (const line of content.split("\n")) {
        if (!line) continue;
        try {
          const parsed = JSON.parse(line) as T & { ts?: number };
          if (!since || (parsed.ts && parsed.ts >= since)) results.push(parsed);
        } catch { /* skip malformed */ }
      }
      return results;
    } catch {
      return [];
    }
  }

  private countJsonlLines(filename: string): number {
    try {
      const content = readFileSync(join(COLLECTOR_DIR, filename), "utf-8");
      return content.split("\n").filter(Boolean).length;
    } catch {
      return 0;
    }
  }

  private cleanup(): void {
    const cutoff = Date.now() - ANALYSIS_WINDOW;
    while (this.recentEvents.length > 0 && this.recentEvents[0].ts < cutoff) this.recentEvents.shift();
    while (this.recentConflicts.length > 0 && this.recentConflicts[0].ts < cutoff) this.recentConflicts.shift();
    for (const [path, ops] of this.recentFileOps) {
      while (ops.length > 0 && ops[0].ts < cutoff) ops.shift();
      if (ops.length === 0) this.recentFileOps.delete(path);
    }
    while (this.recentGitOps.length > 0 && this.recentGitOps[0].ts < cutoff) this.recentGitOps.shift();
  }
}

// ── Pure helpers (module-level) ──────────────────────────────────────────

function extractFilePath(toolName: string, toolInput?: Record<string, unknown>): string | undefined {
  if (!toolInput) return undefined;
  const fp = toolInput.file_path ?? toolInput.notebook_path ?? toolInput.path;
  return typeof fp === "string" ? fp : undefined;
}

function isReadTool(name: string): boolean {
  return name === "Read" || name === "Grep" || name === "Glob";
}

function isWriteTool(name: string): boolean {
  return name === "Edit" || name === "Write" || name === "NotebookEdit";
}

function parseGitOp(command: string): { op: string; branch?: string } | null {
  if (/\bgit\s+push\s+--force\b|\bgit\s+push\s+-f\b/.test(command)) return { op: "force_push" };
  if (/\bgit\s+push\b/.test(command)) {
    const m = command.match(/git\s+push\s+\S+\s+(\S+)/);
    return { op: "push", branch: m?.[1] };
  }
  if (/\bgit\s+commit\b/.test(command)) return { op: "commit" };
  if (/\bgit\s+pull\b/.test(command)) return { op: "pull" };
  if (/\bgit\s+checkout\b/.test(command)) {
    const m = command.match(/git\s+checkout\s+(?:-b\s+)?(\S+)/);
    return { op: "checkout", branch: m?.[1] };
  }
  if (/\bgit\s+rebase\b/.test(command)) return { op: "rebase" };
  if (/\bgit\s+reset\b/.test(command)) return { op: "reset" };
  if (/\bgit\s+merge\b/.test(command)) return { op: "merge" };
  return null;
}

function stringifyOutput(val: unknown): string {
  if (val === undefined || val === null) return "";
  if (typeof val === "string") return val;
  try { return JSON.stringify(val); } catch { return ""; }
}

function isErrorOutput(toolName: string, output: string): boolean {
  if (toolName === "Edit") {
    return /not found in file|not unique in the file|old_string.*not found/i.test(output);
  }
  if (toolName === "Bash") {
    return /CONFLICT|merge conflict|fatal:|error:/i.test(output) && output.length < 2000;
  }
  return false;
}

function tail(path: string): string {
  return path.split("/").pop() || path;
}

function conflictId(prefix: string, path: string, a: string, b: string, ts: number): string {
  return `${prefix}:${tail(path)}:${a}:${b}:${Math.floor(ts / 60000)}`;
}
