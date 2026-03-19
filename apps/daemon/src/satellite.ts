/**
 * Satellite mode: connects this machine's terminals to a remote primary Hive daemon.
 *
 * The satellite runs local discovery + session streaming, reports workers to the
 * primary via WebSocket, and executes commands (message, kill, spawn, selection)
 * forwarded from the primary's dashboard.
 *
 * Usage: npx tsx apps/daemon/src/index.ts --satellite wss://xxx.trycloudflare.com TOKEN
 */

import { WebSocket } from "ws";
import { hostname } from "os";
import { homedir, platform } from "os";
import { join, basename } from "path";
import { unlinkSync, existsSync } from "fs";
import { execFile } from "child_process";
import { ProcessDiscovery } from "./discovery.js";
import { TelemetryReceiver } from "./telemetry.js";
import { SessionStreamer } from "./session-stream.js";
import { ProcessManager } from "./process-mgr.js";
import { spawnTerminalWindow, closeTerminalWindow } from "./arrange-windows.js";
import { sendSelectionToTty, sendEnterToTty } from "./tty-input.js";
import { patchHookUrls } from "./auth.js";
import type { WorkerState } from "./types.js";

/** Message from satellite → primary */
interface SatelliteUpMessage {
  type: "satellite_hello" | "satellite_workers" | "satellite_chat" | "satellite_result" | "satellite_projects";
  machineId?: string;
  hostname?: string;
  platform?: string;
  workers?: WorkerState[];
  workerId?: string;
  messages?: unknown[];
  full?: boolean;
  requestId?: string;
  ok?: boolean;
  error?: string;
  tty?: string;
  projects?: string[];
}

/** Message from primary → satellite */
interface SatelliteDownMessage {
  type: string;
  requestId?: string;
  workerId?: string;      // prefixed ID (machineId:localId)
  localWorkerId?: string; // local ID on this machine
  project?: string;
  model?: string;
  targetQuadrant?: number;
  initialMessage?: string;
  content?: string;
  optionIndex?: number;
  files?: string[];       // auto-commit: file paths to commit
  message?: string;       // auto-commit: commit message
}

export class SatelliteClient {
  private primaryUrl: string;
  private token: string;
  private machineId: string;
  private ws: WebSocket | null = null;
  private telemetry: TelemetryReceiver;
  private discovery: ProcessDiscovery;
  private streamer: SessionStreamer;
  private procMgr: ProcessManager;
  private reconnectDelay = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private chatSubs = new Map<string, string>(); // prefixed workerId → subKey
  private tickInterval: ReturnType<typeof setInterval> | null = null;

  constructor(primaryUrl: string, token: string, localToken: string) {
    this.primaryUrl = primaryUrl;
    this.token = token;
    this.machineId = hostname().toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 24) || "satellite";

    // Local telemetry server (receives hooks from local Claude instances)
    this.telemetry = new TelemetryReceiver(3001, localToken);
    this.procMgr = new ProcessManager(this.telemetry);
    this.streamer = new SessionStreamer();
    this.discovery = new ProcessDiscovery(this.telemetry, this.streamer);

    // Patch hook URLs so local Claude instances report to local telemetry
    patchHookUrls(localToken);
  }

  start(): void {
    // Start local telemetry server (for hooks from local Claude instances)
    this.telemetry.start();
    this.telemetry.registerProcessManager(this.procMgr);
    this.telemetry.setStreamer(this.streamer);
    this.telemetry.onRemoval((workerId) => this.streamer.clearWorker(workerId));

    // Initial discovery scan
    this.discovery.scan();
    console.log(`[satellite] Machine ID: ${this.machineId}`);
    console.log(`[satellite] Found ${this.telemetry.getAll().length} local agent(s)`);

    // Connect to primary
    this.connect();

    // Periodic: discovery + report
    this.tickInterval = setInterval(() => {
      this.telemetry.tick();
      this.procMgr.tick();
      this.discovery.scan();
      this.reportWorkers();
    }, 3_000);
  }

  private connect(): void {
    const sep = this.primaryUrl.includes("?") ? "&" : "?";
    const url = `${this.primaryUrl}${sep}token=${encodeURIComponent(this.token)}&satellite=${encodeURIComponent(this.machineId)}`;

    console.log(`[satellite] Connecting to primary...`);
    this.ws = new WebSocket(url);

    this.ws.on("open", () => {
      console.log(`[satellite] Connected to primary as "${this.machineId}"`);
      this.reconnectDelay = 1000;

      // Send hello
      this.send({
        type: "satellite_hello",
        machineId: this.machineId,
        hostname: hostname(),
        platform: platform(),
      });

      // Send initial worker list
      this.reportWorkers();
    });

    this.ws.on("message", (raw) => {
      try {
        const msg: SatelliteDownMessage = JSON.parse(raw.toString());
        this.handleMessage(msg);
      } catch { /* malformed message */ }
    });

    this.ws.on("close", () => {
      console.log(`[satellite] Disconnected. Reconnecting in ${this.reconnectDelay / 1000}s...`);
      this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
    });

    this.ws.on("error", () => {
      // onclose will fire next — reconnect happens there
    });
  }

  private send(msg: SatelliteUpMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  /** Report all local workers to the primary with machine tag. */
  private reportWorkers(): void {
    const workers: WorkerState[] = this.telemetry.getAll().map(w => ({
      ...w,
      machine: this.machineId,
    }));
    this.send({ type: "satellite_workers", machineId: this.machineId, workers });
  }

  /** Handle a command forwarded from the primary. */
  private async handleMessage(msg: SatelliteDownMessage): Promise<void> {
    switch (msg.type) {
      case "satellite_spawn": {
        const project = msg.project || homedir();
        const model = msg.model || "claude";
        const result = spawnTerminalWindow(project, model, msg.targetQuadrant, msg.initialMessage, this.telemetry.getAll().length);
        if (result.tty) {
          this.telemetry.markSpawn(result.tty);
        }
        this.send({
          type: "satellite_result",
          requestId: msg.requestId,
          ok: result.ok,
          error: result.error,
          tty: result.tty,
        });
        break;
      }

      case "satellite_kill": {
        const localId = msg.localWorkerId || "";
        const worker = this.telemetry.get(localId);
        if (!worker) {
          this.send({ type: "satellite_result", requestId: msg.requestId, ok: false, error: "Worker not found" });
          return;
        }

        // SIGKILL process
        if (worker.pid) {
          try { process.kill(worker.pid, "SIGKILL"); } catch { /* already gone */ }
        }

        // Remove from telemetry
        this.telemetry.removeWorker(localId);

        // Clear session marker
        if (worker.tty) {
          const ttyName = worker.tty.replace("/dev/", "");
          const markerPath = join(homedir(), ".hive", "sessions", ttyName);
          try { unlinkSync(markerPath); } catch { /* already gone */ }

          // Close terminal window
          setTimeout(() => closeTerminalWindow(worker.tty!), 500);
        }

        this.send({ type: "satellite_result", requestId: msg.requestId, ok: true });
        break;
      }

      case "satellite_message": {
        const localId = msg.localWorkerId || "";
        const worker = this.telemetry.get(localId);
        if (!worker?.tty) {
          this.send({ type: "satellite_result", requestId: msg.requestId, ok: false, error: "Worker not found or no TTY" });
          return;
        }

        const result = await this.telemetry.sendToWorkerAsync(localId, msg.content || "", {
          source: "dashboard",
          queueIfBusy: false,
          markDashboardInput: true,
        });

        this.send({
          type: "satellite_result",
          requestId: msg.requestId,
          ok: result.ok,
          error: result.ok ? undefined : result.error,
        });

        if (result.ok && !result.queued) {
          this.streamer.nudge(localId);
        }
        break;
      }

      case "satellite_selection": {
        const localId = msg.localWorkerId || "";
        const worker = this.telemetry.get(localId);
        if (!worker?.tty) {
          this.send({ type: "satellite_result", requestId: msg.requestId, ok: false, error: "No TTY" });
          return;
        }
        const result = sendSelectionToTty(worker.tty, msg.optionIndex || 0);
        if (result.ok) {
          worker.status = "working";
          worker.currentAction = "Thinking...";
          worker.lastAction = "User approved from dashboard";
          worker.lastActionAt = Date.now();
          worker.stuckMessage = undefined;
          this.telemetry.notifyExternal(worker);
        }
        this.send({ type: "satellite_result", requestId: msg.requestId, ok: result.ok, error: result.error });
        break;
      }

      case "satellite_approve": {
        const localId = msg.localWorkerId || "";
        const worker = this.telemetry.get(localId);
        if (!worker?.tty) {
          this.send({ type: "satellite_result", requestId: msg.requestId, ok: false, error: "No TTY" });
          return;
        }
        const result = sendEnterToTty(worker.tty);
        if (result.ok) {
          worker.promptType = null;
          worker.promptMessage = undefined;
          worker.status = "idle";
          worker.currentAction = "Starting...";
          worker.lastAction = "Prompt approved from dashboard";
          worker.lastActionAt = Date.now();
          this.telemetry.notifyExternal(worker);
        }
        this.send({ type: "satellite_result", requestId: msg.requestId, ok: result.ok, error: result.error });
        break;
      }

      case "satellite_subscribe": {
        const localId = msg.localWorkerId || "";
        const prefixedId = msg.workerId || localId;
        const worker = this.telemetry.get(localId);
        if (!worker) return;

        // Verify session file mapping
        if (worker.tty) {
          this.streamer.verifySessionFile(localId, worker.tty);
        }

        // Send full history
        const history = this.streamer.readHistory(localId);
        this.send({ type: "satellite_chat", workerId: prefixedId, messages: history, full: true });

        // Subscribe for incremental updates
        const subKey = `sat_${prefixedId}`;
        this.chatSubs.set(prefixedId, subKey);
        this.streamer.subscribe(subKey, localId, (entries, full) => {
          this.send({
            type: "satellite_chat",
            workerId: prefixedId,
            messages: entries,
            ...(full ? { full: true } : {}),
          });
        });
        break;
      }

      case "satellite_unsubscribe": {
        const prefixedId = msg.workerId || "";
        const subKey = this.chatSubs.get(prefixedId);
        if (subKey) {
          this.streamer.unsubscribe(subKey);
          this.chatSubs.delete(prefixedId);
        }
        break;
      }

      case "satellite_autocommit": {
        const project = msg.project || "";
        const files = msg.files || [];
        const commitMessage = msg.message || "Auto-commit by Hive";

        if (!project || files.length === 0) {
          this.send({ type: "satellite_result", requestId: msg.requestId, ok: false, error: "No project or files" });
          return;
        }

        // Filter to files that exist on disk
        const existingFiles = files.filter(f => existsSync(f));
        if (existingFiles.length === 0) {
          this.send({ type: "satellite_result", requestId: msg.requestId, ok: false, error: "No files exist on disk" });
          return;
        }

        // Run git add + commit asynchronously
        try {
          const gitAdd = () => new Promise<void>((resolve, reject) => {
            execFile("/usr/bin/git", ["add", ...existingFiles], { cwd: project, timeout: 10_000 },
              (err) => err ? reject(err) : resolve());
          });
          const gitCommit = () => new Promise<string>((resolve, reject) => {
            const shortTask = commitMessage.slice(0, 100);
            const fileNames = existingFiles.map(f => basename(f)).join(", ");
            const fullMsg = `${shortTask}\n\nFiles: ${fileNames}\n\nAuto-committed by Hive (satellite: ${this.machineId}).`;
            execFile("/usr/bin/git", ["commit", "-m", fullMsg, "--no-verify"], { cwd: project, timeout: 15_000 },
              (err, stdout) => err ? reject(err) : resolve(stdout));
          });
          const gitHash = () => new Promise<string>((resolve, reject) => {
            execFile("/usr/bin/git", ["rev-parse", "--short", "HEAD"], { cwd: project, timeout: 3_000, encoding: "utf-8" },
              (err, stdout) => err ? reject(err) : resolve((stdout || "").trim()));
          });

          await gitAdd();
          await gitCommit();
          const hash = await gitHash();

          console.log(`[satellite-autocommit] Committed ${existingFiles.length} file(s) → ${hash}`);
          this.send({ type: "satellite_result", requestId: msg.requestId, ok: true });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          console.log(`[satellite-autocommit] Failed: ${errMsg}`);
          this.send({ type: "satellite_result", requestId: msg.requestId, ok: false, error: errMsg });
        }
        break;
      }

      // Ignore messages meant for dashboard clients (workers, auth, etc.)
      default:
        break;
    }
  }

  stop(): void {
    if (this.tickInterval) clearInterval(this.tickInterval);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
    }
  }
}
