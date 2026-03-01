import { execFileSync } from "child_process";
import { readFileSync, readdirSync, statSync } from "fs";
import { basename, join } from "path";
import type { TelemetryReceiver } from "./telemetry.js";
import type { WorkerState } from "./types.js";

interface ProcessInfo {
  pid: number;
  cpuPercent: number;
  startedAt: number;
  tty: string;
  project: string;
  projectName: string;
  sessionIds: string[];
}

/** Parsed context from a session JSONL tail */
interface SessionContext {
  projectName: string | null;
  latestAction: string | null;
  pendingPrompt: string | null;
}

export class ProcessDiscovery {
  private telemetry: TelemetryReceiver;
  private discoveredPids = new Set<number>();
  private daemonPid = process.pid;

  constructor(telemetry: TelemetryReceiver) {
    this.telemetry = telemetry;
  }

  scan(): void {
    const processes = this.findClaudeProcesses();
    const alivePids = new Set<number>();

    for (const proc of processes) {
      alivePids.add(proc.pid);
      const id = `discovered_${proc.pid}`;

      // Register session→worker mappings for hook lookups
      for (const sid of proc.sessionIds) {
        this.telemetry.registerSession(sid, id);
      }

      if (this.discoveredPids.has(proc.pid)) {
        const existing = this.telemetry.get(id);
        if (existing) {
          // Re-identify project on every scan
          if (proc.projectName !== "unknown") {
            existing.project = proc.project;
            existing.projectName = proc.projectName;
          }

          // Only update from CPU/JSONL if no recent hook event
          const hookAge = Date.now() - (this.telemetry.getLastHookTime(id) || 0);
          if (hookAge > 15_000) {
            // Read JSONL context on every scan for live action info
            const ctx = this.readSessionContext(proc.sessionIds);

            if (ctx.projectName) {
              existing.projectName = ctx.projectName;
            }

            if (proc.cpuPercent > 5) {
              // Working — show what it's doing
              existing.status = "working";
              existing.currentAction = ctx.latestAction || `CPU ${proc.cpuPercent.toFixed(0)}%`;
              existing.lastAction = existing.currentAction;
              existing.lastActionAt = Date.now();
            } else if (ctx.pendingPrompt) {
              // Idle CPU but JSONL shows a pending prompt — needs direction
              existing.status = "stuck";
              existing.currentAction = ctx.pendingPrompt;
              existing.lastAction = ctx.pendingPrompt;
            } else if (existing.status === "working") {
              // Just stopped working
              existing.status = "waiting";
              existing.currentAction = null;
              existing.lastAction = ctx.latestAction || "Paused";
            } else if (existing.status === "waiting" || existing.status === "idle") {
              // Still idle — keep showing last known action
              if (ctx.latestAction) {
                existing.lastAction = ctx.latestAction;
              }
            }
          }

          this.telemetry.notifyExternal(existing);
        }
        continue;
      }

      // New process — read context immediately
      const ctx = this.readSessionContext(proc.sessionIds);

      const worker: WorkerState = {
        id,
        pid: proc.pid,
        project: proc.project,
        projectName: ctx.projectName || proc.projectName,
        status: ctx.pendingPrompt ? "stuck" : proc.cpuPercent > 5 ? "working" : "waiting",
        currentAction: ctx.pendingPrompt || ctx.latestAction || (proc.cpuPercent > 5 ? `CPU ${proc.cpuPercent.toFixed(0)}%` : null),
        lastAction: ctx.latestAction || "Discovered on machine",
        lastActionAt: Date.now(),
        errorCount: 0,
        startedAt: proc.startedAt,
        task: null,
        managed: false,
        tty: proc.tty,
      };

      this.telemetry.registerDiscovered(id, worker);
      this.discoveredPids.add(proc.pid);
    }

    // Remove dead processes
    for (const pid of this.discoveredPids) {
      if (!alivePids.has(pid)) {
        this.telemetry.removeWorker(`discovered_${pid}`);
        this.discoveredPids.delete(pid);
      }
    }
  }

  private findClaudeProcesses(): ProcessInfo[] {
    try {
      const raw = execFileSync("ps", ["-eo", "pid,pcpu,lstart,tty,command"], {
        encoding: "utf-8",
        timeout: 5000,
      }).trim();

      if (!raw) return [];
      const results: ProcessInfo[] = [];

      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.endsWith("claude") && !trimmed.match(/claude\s*$/)) continue;
        if (trimmed.includes("grep")) continue;

        const parts = trimmed.split(/\s+/);
        if (parts.length < 9) continue;

        const pid = parseInt(parts[0], 10);
        if (isNaN(pid) || pid === this.daemonPid) continue;

        const cpuPercent = parseFloat(parts[1]);
        const mon = parts[3];
        const day = parseInt(parts[4], 10);
        const time = parts[5];
        const year = parseInt(parts[6], 10);
        const startedAt = new Date(`${mon} ${day}, ${year} ${time}`).getTime();

        const info = this.getProcessInfo(pid);
        if (!info) continue;

        results.push({ pid, cpuPercent, startedAt, ...info });
      }

      return results;
    } catch {
      return [];
    }
  }

  private getProcessInfo(pid: number): {
    tty: string;
    project: string;
    projectName: string;
    sessionIds: string[];
  } | null {
    try {
      const raw = execFileSync("lsof", ["-p", String(pid), "-Fn"], {
        encoding: "utf-8",
        timeout: 5000,
      }).trim();

      const lines = raw.split("\n");
      let cwd: string | null = null;
      let tty = "";
      const sessionIds: string[] = [];

      for (let i = 0; i < lines.length; i++) {
        if (lines[i] === "fcwd" && i + 1 < lines.length && lines[i + 1].startsWith("n/")) {
          cwd = lines[i + 1].slice(1);
        }
        if (lines[i].startsWith("n/dev/tty") && !tty) {
          tty = lines[i].slice(1).replace("/dev/", "");
        }
        const taskMatch = lines[i].match(/^n.*\/.claude\/tasks\/([0-9a-f-]{36})/);
        if (taskMatch && !sessionIds.includes(taskMatch[1])) {
          sessionIds.push(taskMatch[1]);
        }
      }

      if (!cwd) return null;

      const projectName = this.projectNameFromCwd(cwd);
      const homeDir = process.env.HOME || `/Users/${process.env.USER}`;
      const project = (cwd === homeDir || cwd === "/")
        ? `${homeDir}/factory/projects/${projectName}`
        : cwd;

      return { tty, project, projectName, sessionIds };
    } catch {
      return null;
    }
  }

  /**
   * Single JSONL read that extracts project name, latest action, and pending prompts.
   * Reads the tail of the most recently modified session file.
   */
  private readSessionContext(sessionIds: string[]): SessionContext {
    const result: SessionContext = { projectName: null, latestAction: null, pendingPrompt: null };
    if (sessionIds.length === 0) return result;

    const homeDir = process.env.HOME || `/Users/${process.env.USER}`;
    const projectsDir = join(homeDir, ".claude", "projects");

    try {
      let bestFile: string | null = null;
      let bestMtime = 0;

      for (const projectDir of readdirSync(projectsDir)) {
        const fullDir = join(projectsDir, projectDir);
        for (const sessionId of sessionIds) {
          const jsonlPath = join(fullDir, `${sessionId}.jsonl`);
          try {
            const stat = statSync(jsonlPath);
            if (stat.mtimeMs > bestMtime) {
              bestMtime = stat.mtimeMs;
              bestFile = jsonlPath;
            }
          } catch {
            // File doesn't exist
          }
        }
      }

      if (!bestFile) return result;

      const tail = this.readTail(bestFile, 5_000);

      // --- Extract project name ---
      const projectCounts = new Map<string, number>();
      for (const match of tail.matchAll(/\/factory\/projects\/([^/\\"]+)/g)) {
        projectCounts.set(match[1], (projectCounts.get(match[1]) || 0) + 1);
      }
      for (const match of tail.matchAll(/\/Users\/[^/]+\/([^/\\"]+)\/(?:src|app|lib|components)\//g)) {
        const name = match[1];
        if (name !== "factory" && name !== ".claude" && name !== ".local") {
          projectCounts.set(name, (projectCounts.get(name) || 0) + 1);
        }
      }
      if (projectCounts.size > 0) {
        const sorted = [...projectCounts.entries()].sort((a, b) => b[1] - a[1]);
        result.projectName = sorted[0][0];
      }

      // --- Extract latest action from the last few lines ---
      const lines = tail.split("\n").filter(Boolean);
      // Walk backwards through lines to find the most recent tool use
      for (let i = lines.length - 1; i >= 0 && i >= lines.length - 20; i--) {
        const line = lines[i];

        // Check for pending prompts first (takes priority)
        if (!result.pendingPrompt) {
          if (line.includes("AskUserQuestion")) {
            result.pendingPrompt = "Waiting for your answer";
          } else if (line.includes("permission_prompt") || line.includes('"type":"permission"')) {
            result.pendingPrompt = "Waiting for permission";
          } else if (line.includes("EnterPlanMode") || line.includes("ExitPlanMode")) {
            result.pendingPrompt = "Waiting for plan approval";
          }
        }

        // Extract tool actions
        if (!result.latestAction) {
          const action = this.parseActionFromLine(line);
          if (action) {
            result.latestAction = action;
          }
        }

        if (result.latestAction && result.pendingPrompt) break;
      }

      // Only report pending prompt if file was modified recently
      if (result.pendingPrompt && Date.now() - bestMtime > 60_000) {
        result.pendingPrompt = null;
      }

      return result;
    } catch {
      return result;
    }
  }

  /** Try to extract a human-readable action from a JSONL line */
  private parseActionFromLine(line: string): string | null {
    try {
      // Quick checks to avoid parsing irrelevant lines
      if (!line.includes("tool")) return null;

      // Look for tool_name and file_path patterns without full JSON parse (faster)
      const toolMatch = line.match(/"tool_name"\s*:\s*"([^"]+)"/);
      if (!toolMatch) return null;

      const toolName = toolMatch[1];
      const fileMatch = line.match(/"file_path"\s*:\s*"([^"]+)"/);
      const descMatch = line.match(/"description"\s*:\s*"([^"]{1,60})"/);
      const cmdMatch = line.match(/"command"\s*:\s*"([^"]{1,60})"/);
      const patternMatch = line.match(/"pattern"\s*:\s*"([^"]{1,30})"/);

      switch (toolName) {
        case "Bash":
          return descMatch ? descMatch[1] : cmdMatch ? cmdMatch[1] : "Running command";
        case "Edit":
          return fileMatch ? `Editing ${basename(fileMatch[1])}` : "Editing file";
        case "Write":
          return fileMatch ? `Writing ${basename(fileMatch[1])}` : "Writing file";
        case "Read":
          return fileMatch ? `Reading ${basename(fileMatch[1])}` : "Reading file";
        case "Grep":
          return patternMatch ? `Searching "${patternMatch[1]}"` : "Searching code";
        case "Glob":
          return patternMatch ? `Finding ${patternMatch[1]}` : "Finding files";
        case "WebFetch":
          return "Fetching web page";
        case "WebSearch":
          return "Searching web";
        case "Task":
          return "Running subagent";
        default:
          return toolName.replace(/^mcp__\w+__/, "");
      }
    } catch {
      return null;
    }
  }

  private readTail(path: string, bytes: number): string {
    const buf = readFileSync(path);
    if (buf.length <= bytes) return buf.toString("utf-8");
    return buf.subarray(buf.length - bytes).toString("utf-8");
  }

  private projectNameFromCwd(cwd: string): string {
    const homeDir = process.env.HOME || `/Users/${process.env.USER}`;
    if (cwd === homeDir || cwd === "/") return "unknown";
    return cwd.split("/").pop() || cwd;
  }
}
