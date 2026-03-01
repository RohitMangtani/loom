import { execFileSync } from "child_process";
import { readFileSync, readdirSync, statSync } from "fs";
import { basename, join } from "path";
import type { TelemetryReceiver } from "./telemetry.js";
import type { SessionStreamer } from "./session-stream.js";
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
  status: "working" | "idle";
  fileAgeMs: number;
}

export class ProcessDiscovery {
  private telemetry: TelemetryReceiver;
  private streamer: SessionStreamer;
  private discoveredPids = new Set<number>();
  private daemonPid = process.pid;

  constructor(telemetry: TelemetryReceiver, streamer: SessionStreamer) {
    this.telemetry = telemetry;
    this.streamer = streamer;
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

      // Register session file with streamer for chat history
      let sessionFile: string | null = null;
      if (proc.sessionIds.length > 0) {
        sessionFile = this.streamer.findSessionFile(proc.sessionIds);
      }
      // Fallback: find via cwd-based project directory (lsof can miss task files)
      if (!sessionFile) {
        const jsonl = this.findBestJsonlFile(proc.sessionIds, proc.project);
        if (jsonl) sessionFile = jsonl.path;
      }
      if (sessionFile) {
        this.streamer.setSessionFile(id, sessionFile);
      }

      if (this.discoveredPids.has(proc.pid)) {
        const existing = this.telemetry.get(id);
        if (existing) {
          // Re-identify project on every scan
          if (proc.projectName !== "unknown") {
            existing.project = proc.project;
            existing.projectName = proc.projectName;
          }

          // LAYER 1: JSONL mtime heartbeat (cheap stat, every scan)
          // Fresh file = actively writing = definitely working
          const jsonl = this.findBestJsonlFile(proc.sessionIds, proc.project);
          if (jsonl && Date.now() - jsonl.mtimeMs < 30_000 && existing.status !== "stuck") {
            existing.lastActionAt = Date.now();
            if (existing.status === "idle") {
              existing.status = "working";
              existing.currentAction = "Working...";
            }
          }

          // LAYER 2: Deep JSONL analysis when hooks are stale
          // Hooks are ground truth when fresh. When stale, JSONL tells us
          // if Claude is thinking (green) or truly idle (red).
          const hookAge = Date.now() - (this.telemetry.getLastHookTime(id) || 0);
          if (hookAge > 15_000) {
            // Don't touch stuck (yellow) — hooks own that state
            if (existing.status === "stuck") {
              this.telemetry.notifyExternal(existing);
              continue;
            }

            // Hook says tool is mid-execution — green
            if (this.telemetry.isToolInFlight(id)) {
              this.telemetry.notifyExternal(existing);
              continue;
            }

            const ctx = this.readSessionContext(proc.sessionIds, proc.project);

            if (ctx.projectName) {
              existing.projectName = ctx.projectName;
            }

            if (ctx.status === "working") {
              // JSONL confirms working (fresh mtime, tool in flight, or thinking)
              existing.status = "working";
              existing.currentAction = ctx.latestAction || "Thinking...";
              existing.lastAction = ctx.latestAction || existing.lastAction;
              existing.lastActionAt = Date.now();
            } else {
              // JSONL says conversation turn is complete — truly idle
              if (ctx.latestAction) {
                existing.lastAction = ctx.latestAction;
              }
              existing.status = "idle";
              existing.currentAction = null;
            }
          }

          this.telemetry.notifyExternal(existing);
        }
        continue;
      }

      // New process — read JSONL for initial status
      const ctx = this.readSessionContext(proc.sessionIds, proc.project);

      const worker: WorkerState = {
        id,
        pid: proc.pid,
        project: proc.project,
        projectName: ctx.projectName || proc.projectName,
        status: ctx.status,
        currentAction: ctx.status === "working" ? (ctx.latestAction || "Working...") : null,
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
   * Find the most recently modified JSONL session file.
   * Tries session IDs first (exact match), falls back to cwd-based
   * project directory search (finds agents even when lsof misses task files).
   */
  private findBestJsonlFile(sessionIds: string[], cwd?: string): { path: string; mtimeMs: number } | null {
    const homeDir = process.env.HOME || `/Users/${process.env.USER}`;
    const projectsDir = join(homeDir, ".claude", "projects");
    let bestFile: string | null = null;
    let bestMtime = 0;

    try {
      // Primary: search by session ID across all project dirs
      if (sessionIds.length > 0) {
        for (const projectDir of readdirSync(projectsDir)) {
          const fullDir = join(projectsDir, projectDir);
          for (const sessionId of sessionIds) {
            try {
              const stat = statSync(join(fullDir, `${sessionId}.jsonl`));
              if (stat.mtimeMs > bestMtime) {
                bestMtime = stat.mtimeMs;
                bestFile = join(fullDir, `${sessionId}.jsonl`);
              }
            } catch { /* doesn't exist */ }
          }
        }
      }

      // Fallback: search by cwd → Claude project directory
      // Claude Code encodes /Users/foo/bar as -Users-foo-bar
      if (!bestFile && cwd) {
        const encoded = cwd.replace(/\//g, "-");
        const candidateDir = join(projectsDir, encoded);
        try {
          for (const file of readdirSync(candidateDir)) {
            if (!file.endsWith(".jsonl")) continue;
            try {
              const stat = statSync(join(candidateDir, file));
              if (stat.mtimeMs > bestMtime) {
                bestMtime = stat.mtimeMs;
                bestFile = join(candidateDir, file);
              }
            } catch { /* skip */ }
          }
        } catch { /* dir doesn't exist */ }
      }
    } catch { /* projectsDir doesn't exist */ }

    return bestFile ? { path: bestFile, mtimeMs: bestMtime } : null;
  }

  /**
   * Simple, reliable status detection via JSONL file mtime.
   *
   * GREEN: File modified in the last 30 seconds → Claude is active
   * RED:   Everything else → idle
   *
   * File mtime is ground truth. Claude writes to JSONL constantly when
   * working. When it stops writing, it's idle. That's it.
   */
  private readSessionContext(sessionIds: string[], cwd?: string): SessionContext {
    const result: SessionContext = {
      projectName: null, latestAction: null,
      status: "idle", fileAgeMs: Infinity,
    };

    const best = this.findBestJsonlFile(sessionIds, cwd);
    if (!best) return result;

    try {
      result.fileAgeMs = Date.now() - best.mtimeMs;

      const tail = this.readTail(best.path, 10_000);

      // Extract project name from cwd field
      const cwdMatch = tail.match(/"cwd"\s*:\s*"([^"]+)"/);
      if (cwdMatch) {
        const cwd = cwdMatch[1];
        const factoryMatch = cwd.match(/\/factory\/projects\/([^/]+)/);
        if (factoryMatch) {
          result.projectName = factoryMatch[1];
        } else {
          const segments = cwd.split("/").filter(Boolean);
          const last = segments[segments.length - 1];
          if (last && last !== "rmgtni" && last !== "Users") {
            result.projectName = last;
          }
        }
      }

      // Extract latest action for display
      const lines = tail.split("\n").filter(Boolean);
      for (let i = lines.length - 1; i >= Math.max(0, lines.length - 20); i--) {
        const action = this.parseActionFromLine(lines[i]);
        if (action) { result.latestAction = action; break; }
      }

      // Status: mtime < 30s = working, else check for in-flight tool
      if (result.fileAgeMs < 30_000) {
        result.status = "working";
        return result;
      }

      // Mtime is stale, but check JSONL tail for two "still working" patterns:
      //
      // 1. TOOL IN FLIGHT: last assistant message has tool_use with no
      //    tool_result after it → long-running command (Bash, build, etc.)
      //
      // 2. THINKING: last meaningful entry is a "user" message (or
      //    tool_result) with no subsequent "assistant" message → Claude
      //    received input and is processing tokens on the API server.
      //    No hooks fire and nothing gets written to JSONL during this gap.

      let lastUser = false;    // saw "user" or tool_result more recently than "assistant"
      let lastAssistant = false;

      for (let i = lines.length - 1; i >= Math.max(0, lines.length - 20); i--) {
        const line = lines[i];

        // Pattern 1: tool in flight (tool_use without tool_result after it)
        if (line.includes('"tool_result"')) {
          // Tool finished — not in-flight. But Claude might be thinking
          // about the result (no assistant response yet), so mark and keep scanning.
          if (!lastAssistant) lastUser = true;
          break;
        }
        if (line.includes('"tool_use"') && line.includes('"assistant"')) {
          result.status = "working";
          return result;
        }

        // Pattern 2: thinking — track last message type
        if (!lastUser && !lastAssistant) {
          if (line.includes('"type":"user"') || line.includes('"type": "user"')) {
            lastUser = true;
          } else if (line.includes('"type":"assistant"') || line.includes('"type": "assistant"')) {
            lastAssistant = true;
          }
        }
      }

      // If the last meaningful entry was user input (or tool_result) and
      // Claude hasn't responded yet, it's thinking — show green.
      if (lastUser && !lastAssistant) {
        result.status = "working";
        result.latestAction = "Thinking...";
        return result;
      }

      result.status = "idle";
      return result;
    } catch {
      return result;
    }
  }

  /** Try to extract a human-readable action from a JSONL line */
  private parseActionFromLine(line: string): string | null {
    try {
      // Quick checks to avoid parsing irrelevant lines
      if (!line.includes("tool_use")) return null;

      // JSONL tool_use format: {"type":"tool_use","name":"Bash","input":{...}}
      // Match "name" that appears after "tool_use" context
      const toolMatch = line.match(/"tool_use"[^}]*?"name"\s*:\s*"([^"]+)"/);
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
        case "AskUserQuestion":
          return "Asking you a question";
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
