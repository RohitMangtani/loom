import { spawn as cpSpawn, type ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import type { TelemetryReceiver } from "./telemetry.js";

const MAX_BUFFER_LINES = 200;
const IDLE_KILL_THRESHOLD = 15 * 60 * 1000; // 15 minutes
const KILL_GRACE_PERIOD = 5000; // 5 seconds

interface ManagedWorker {
  id: string;
  proc: ChildProcess;
  project: string;
  outputBuffer: string[];
}

export class ProcessManager {
  private workers = new Map<string, ManagedWorker>();
  private telemetry: TelemetryReceiver;
  private outputHandler: ((workerId: string, data: string) => void) | null =
    null;

  constructor(telemetry: TelemetryReceiver) {
    this.telemetry = telemetry;
  }

  spawn(project: string, task: string | null): string {
    const id = randomUUID().slice(0, 8);
    const hookPath = path.resolve(
      new URL(".", import.meta.url).pathname,
      "hooks",
      "telemetry-hook.sh"
    );

    // Inject hooks into the project's .claude/settings.local.json
    this.injectHooks(project, id, hookPath);

    const proc = cpSpawn(
      "claude",
      [
        "--print",
        "--output-format",
        "stream-json",
        "--input-format",
        "stream-json",
        "--permission-mode",
        "acceptEdits",
        "--no-session-persistence",
      ],
      {
        cwd: project,
        env: {
          ...process.env,
          HIVE_WORKER_ID: id,
          HIVE_DAEMON_URL: `http://localhost:${3001}`,
        },
        stdio: ["pipe", "pipe", "pipe"],
      }
    );

    const worker: ManagedWorker = {
      id,
      proc,
      project,
      outputBuffer: [],
    };

    this.workers.set(id, worker);

    // Register with telemetry
    this.telemetry.registerWorker(id, proc.pid || 0, project, task);

    // Capture stdout
    proc.stdout?.on("data", (data: Buffer) => {
      const text = data.toString();
      const lines = text.split("\n").filter((l) => l.length > 0);
      worker.outputBuffer.push(...lines);
      while (worker.outputBuffer.length > MAX_BUFFER_LINES) {
        worker.outputBuffer.shift();
      }
      if (this.outputHandler) {
        this.outputHandler(id, text);
      }
    });

    // Capture stderr
    proc.stderr?.on("data", (data: Buffer) => {
      const text = data.toString();
      const lines = text.split("\n").filter((l) => l.length > 0);
      worker.outputBuffer.push(...lines.map((l) => `[stderr] ${l}`));
      while (worker.outputBuffer.length > MAX_BUFFER_LINES) {
        worker.outputBuffer.shift();
      }

      // Increment error count in telemetry
      const state = this.telemetry.get(id);
      if (state) {
        state.errorCount++;
      }
    });

    // Handle process exit
    proc.on("exit", (code) => {
      console.log(`Worker ${id} exited with code ${code}`);
      this.cleanupHooks(project);
      this.telemetry.removeWorker(id);
      this.workers.delete(id);
    });

    // Send the initial task if provided
    if (task) {
      this.sendMessage(id, task);
    }

    return id;
  }

  sendMessage(workerId: string, message: string): boolean {
    const worker = this.workers.get(workerId);
    if (!worker || !worker.proc.stdin?.writable) return false;

    const payload = JSON.stringify({
      type: "user",
      content: message,
    });
    worker.proc.stdin.write(payload + "\n");
    return true;
  }

  kill(workerId: string): void {
    const worker = this.workers.get(workerId);
    if (!worker) return;

    // Send SIGTERM first
    worker.proc.kill("SIGTERM");

    // Force kill after grace period
    setTimeout(() => {
      try {
        worker.proc.kill("SIGKILL");
      } catch {
        // Process may already be gone
      }
    }, KILL_GRACE_PERIOD);
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
    for (const [id] of this.workers) {
      const state = this.telemetry.get(id);
      if (state && now - state.lastActionAt > IDLE_KILL_THRESHOLD) {
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

    // Define hook commands
    const hookEvents = [
      "PreToolUse",
      "PostToolUse",
      "Stop",
      "SubagentStart",
      "SubagentStop",
    ];

    const hooks: Record<string, unknown> = (settings.hooks as Record<string, unknown>) || {};

    for (const event of hookEvents) {
      const hookCmd = `HIVE_WORKER_ID=${workerId} HIVE_HOOK_EVENT=${event} ${hookPath}`;
      const existing = (hooks[event] as string[] | undefined) || [];
      // Only add if not already present
      if (!existing.includes(hookCmd)) {
        existing.push(hookCmd);
      }
      hooks[event] = existing;
    }

    settings.hooks = hooks;

    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + "\n");
  }

  cleanupHooks(project: string): void {
    const settingsFile = path.join(project, ".claude", "settings.local.json");
    if (!fs.existsSync(settingsFile)) return;

    try {
      const settings = JSON.parse(fs.readFileSync(settingsFile, "utf-8"));
      const hooks = settings.hooks as Record<string, string[]> | undefined;
      if (!hooks) return;

      // Remove any hook commands that contain HIVE_WORKER_ID
      for (const event of Object.keys(hooks)) {
        hooks[event] = (hooks[event] || []).filter(
          (cmd: string) => !cmd.includes("HIVE_WORKER_ID")
        );
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
}
