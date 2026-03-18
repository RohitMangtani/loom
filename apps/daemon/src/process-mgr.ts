import { spawn as cpSpawn, type ChildProcess } from "child_process";
import { randomBytes } from "crypto";
import fs from "fs";
import path from "path";
import { createInterface } from "readline";
import { fileURLToPath } from "url";
import type { TelemetryReceiver } from "./telemetry.js";
import { truncate } from "./utils.js";

const MAX_BUFFER_LINES = 200;
const IDLE_KILL_THRESHOLD = 15 * 60 * 1000; // 15 minutes
const KILL_GRACE_PERIOD = 5000; // 5 seconds

interface ManagedWorker {
  id: string;
  project: string;
  outputBuffer: string[];
  sessionId?: string;
  activeTurn: ChildProcess | null;
  disposed: boolean;
  lastResult?: string;
}

export type ManagedSendResult =
  | { status: "sent" }
  | { status: "busy" }
  | { status: "not_found" }
  | { status: "error"; error: string };

export class ProcessManager {
  private workers = new Map<string, ManagedWorker>();
  private telemetry: TelemetryReceiver;
  private outputHandler: ((workerId: string, data: string) => void) | null =
    null;

  constructor(telemetry: TelemetryReceiver) {
    this.telemetry = telemetry;
  }

  spawn(project: string, task: string | null): string {
    const id = `w_${randomBytes(6).toString("hex")}`;
    const hookPath = this.resolveHookPath();

    // Inject hooks into the project's .claude/settings.local.json
    this.injectHooks(project, id, hookPath);

    const worker: ManagedWorker = {
      id,
      project,
      outputBuffer: [],
      activeTurn: null,
      disposed: false,
    };

    this.workers.set(id, worker);

    // Register with telemetry
    this.telemetry.registerWorker(id, 0, project, task);

    // Send the initial task with Hive dispatch context
    if (task) {
      const preamble = [
        `You are a Hive-managed agent (worker ${id}).`,
        `You can dispatch work to other agents via the Hive REST API at http://127.0.0.1:3001.`,
        `Auth: read token from ~/.hive/token. See ~/.claude/CLAUDE.md for full dispatch docs.`,
        `Your task:\n\n${task}`,
      ].join(" ");
      const result = this.sendMessage(id, preamble);
      if (result.status !== "sent") {
        console.log(`[managed] Failed to send initial task to ${id}: ${"error" in result ? result.error : result.status}`);
      }
    }

    return id;
  }

  sendMessage(workerId: string, message: string): ManagedSendResult {
    const worker = this.workers.get(workerId);
    if (!worker || worker.disposed) return { status: "not_found" };
    if (worker.activeTurn && worker.activeTurn.exitCode === null && !worker.activeTurn.killed) {
      return { status: "busy" };
    }

    worker.lastResult = undefined;

    const args = ["-p"];
    if (worker.sessionId) {
      args.push("--resume", worker.sessionId);
    }
    args.push(
      "--output-format", "stream-json",
      "--verbose",
      "--permission-mode", "acceptEdits",
    );

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HIVE_WORKER_ID: workerId,
      HIVE_DAEMON_URL: "http://localhost:3001",
    };
    delete env.CLAUDECODE;

    const proc = cpSpawn("claude", args, {
      cwd: worker.project,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    worker.activeTurn = proc;

    const state = this.telemetry.get(workerId);
    if (state) {
      state.pid = proc.pid || 0;
    }

    const stdout = createInterface({ input: proc.stdout! });
    stdout.on("line", (line) => this.handleStdoutLine(worker, line));

    const stderr = createInterface({ input: proc.stderr! });
    stderr.on("line", (line) => this.recordOutput(worker, `[stderr] ${line}`, false));

    proc.on("error", (err) => {
      if (worker.disposed) return;
      worker.activeTurn = null;
      const current = this.telemetry.get(workerId);
      if (current) {
        current.pid = 0;
        this.telemetry.markWorkerIdle(workerId, `Turn failed: ${truncate(err.message, 120)}`);
      }
    });

    proc.on("exit", (code, signal) => {
      stdout.close();
      stderr.close();
      worker.activeTurn = null;
      if (worker.disposed) return;

      const current = this.telemetry.get(workerId);
      if (!current) return;
      current.pid = 0;

      if (signal === "SIGTERM" || signal === "SIGKILL") {
        return;
      }

      const genericLastAction =
        !current.lastAction ||
        current.lastAction === "spawned" ||
        current.lastAction === "Received message" ||
        current.lastAction === "Thinking...";

      const idleAction = genericLastAction
        ? (worker.lastResult || (code === 0 ? "Turn complete" : `Turn failed (${code ?? "unknown"})`))
        : undefined;

      this.telemetry.markWorkerIdle(workerId, idleAction);
    });

    proc.stdin?.end(message.trim() + "\n");
    return { status: "sent" };
  }

  kill(workerId: string): void {
    const worker = this.workers.get(workerId);
    if (!worker) return;
    worker.disposed = true;

    if (worker.activeTurn) {
      worker.activeTurn.kill("SIGTERM");
      setTimeout(() => {
        try {
          worker.activeTurn?.kill("SIGKILL");
        } catch {
          // Process may already be gone
        }
      }, KILL_GRACE_PERIOD);
    }

    this.cleanupHooks(worker.project, workerId);
    this.workers.delete(workerId);
    this.telemetry.removeWorker(workerId);
  }

  getRecentOutput(workerId: string, lines = 50): string[] {
    const worker = this.workers.get(workerId);
    if (!worker) return [];
    return worker.outputBuffer.slice(-lines);
  }

  listIds(): string[] {
    return Array.from(this.workers.keys());
  }

  tick(): void {
    const now = Date.now();
    for (const [id, worker] of this.workers) {
      const state = this.telemetry.get(id);
      if (state && state.status === "idle" && !worker.activeTurn && now - state.lastActionAt > IDLE_KILL_THRESHOLD) {
        console.log(`Worker ${id} idle for 15+ minutes, killing.`);
        this.kill(id);
      }
    }
  }

  setOutputHandler(fn: (workerId: string, data: string) => void): void {
    this.outputHandler = fn;
  }

  private injectHooks(
    project: string,
    workerId: string,
    hookPath: string
  ): void {
    const settingsDir = path.join(project, ".claude");
    const settingsFile = path.join(settingsDir, "settings.local.json");

    // Ensure .claude directory exists
    if (!fs.existsSync(settingsDir)) {
      fs.mkdirSync(settingsDir, { recursive: true });
    }

    // Read existing settings or create new
    let settings: Record<string, unknown> = {};
    if (fs.existsSync(settingsFile)) {
      try {
        settings = JSON.parse(fs.readFileSync(settingsFile, "utf-8"));
      } catch {
        settings = {};
      }
    }

    // Define hook commands using Claude Code nested object format
    const hookEvents = [
      "PreToolUse",
      "PostToolUse",
      "Stop",
      "SessionStart",
    ];

    const hooks: Record<string, unknown> = (settings.hooks as Record<string, unknown>) || {};

    for (const event of hookEvents) {
      const hookCmd = `HIVE_WORKER_ID=${workerId} HIVE_HOOK_EVENT=${event} bash ${hookPath}`;
      const hookEntry = {
        hooks: [{ type: "command", command: hookCmd }],
      };

      const existing = (hooks[event] as Array<Record<string, unknown>> | undefined) || [];
      // Only add if not already present
      const alreadyPresent = existing.some((entry) => {
        const entryHooks = entry.hooks as Array<Record<string, string>> | undefined;
        return entryHooks?.some((h) => h.command === hookCmd);
      });
      if (!alreadyPresent) {
        existing.push(hookEntry);
      }
      hooks[event] = existing;
    }

    settings.hooks = hooks;

    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + "\n");
  }

  cleanupHooks(project: string, workerId: string): void {
    const settingsFile = path.join(project, ".claude", "settings.local.json");
    if (!fs.existsSync(settingsFile)) return;

    try {
      const settings = JSON.parse(fs.readFileSync(settingsFile, "utf-8"));
      const hooks = settings.hooks as Record<string, Array<Record<string, unknown>>> | undefined;
      if (!hooks) return;

      // Remove any hook entries that contain HIVE_WORKER_ID
      for (const event of Object.keys(hooks)) {
        hooks[event] = (hooks[event] || []).filter((entry) => {
          const entryHooks = entry.hooks as Array<Record<string, string>> | undefined;
          if (!entryHooks) return true;
          return !entryHooks.some((h) => h.command?.includes(`HIVE_WORKER_ID=${workerId}`));
        });
        if (hooks[event].length === 0) {
          delete hooks[event];
        }
      }

      if (Object.keys(hooks).length === 0) {
        delete settings.hooks;
      } else {
        settings.hooks = hooks;
      }

      fs.writeFileSync(
        settingsFile,
        JSON.stringify(settings, null, 2) + "\n"
      );
    } catch {
      // Best effort cleanup
    }
  }

  private resolveHookPath(): string {
    // Prefer src/hooks/ since tsc doesn't copy .sh files to dist/
    const srcHooks = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "hooks", "telemetry-hook.sh");
    if (fs.existsSync(srcHooks)) return srcHooks;

    const local = fileURLToPath(new URL("./hooks/telemetry-hook.sh", import.meta.url));
    if (fs.existsSync(local)) return local;

    return srcHooks;
  }

  private handleStdoutLine(worker: ManagedWorker, line: string): void {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.recordOutput(worker, line, false);
      return;
    }

    const sessionId = typeof parsed.session_id === "string" ? parsed.session_id : undefined;
    if (sessionId && worker.sessionId !== sessionId) {
      worker.sessionId = sessionId;
      this.telemetry.registerManagedSession(worker.id, worker.project, sessionId);
    }

    const type = parsed.type;
    if (type === "assistant") {
      const message = parsed.message as { content?: Array<{ type?: string; text?: string }> } | undefined;
      const blocks = Array.isArray(message?.content) ? message.content : [];
      for (const block of blocks) {
        if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
          const text = block.text.trim();
          worker.lastResult = truncate(text, 160);
          this.recordOutput(worker, text, false);
        }
      }
      return;
    }

    if (type === "result" && typeof parsed.result === "string" && parsed.result.trim()) {
      worker.lastResult = truncate(parsed.result.trim(), 160);
    }
  }

  private recordOutput(worker: ManagedWorker, text: string, broadcast: boolean): void {
    const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
    if (lines.length === 0) return;
    worker.outputBuffer.push(...lines);
    while (worker.outputBuffer.length > MAX_BUFFER_LINES) {
      worker.outputBuffer.shift();
    }
    if (broadcast && this.outputHandler) {
      for (const line of lines) {
        this.outputHandler(worker.id, line);
      }
    }
  }
}
