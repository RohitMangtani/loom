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
import { homedir, platform, arch, cpus, totalmem } from "os";
import { join, basename } from "path";
import { unlinkSync, existsSync, writeFileSync, readFileSync, mkdirSync } from "fs";
import { execFile, execFileSync } from "child_process";
import type { MachineCapabilities } from "@hive/types";
import { ProcessDiscovery } from "./discovery.js";
import { TelemetryReceiver } from "./telemetry.js";
import { SessionStreamer } from "./session-stream.js";
import { ProcessManager } from "./process-mgr.js";
import { spawnTerminalWindow, closeTerminalWindow, arrangeTerminalWindows, updateTerminalTitles } from "./arrange-windows.js";
import { sendSelectionToTty, sendEnterToTty } from "./tty-input.js";
import { patchHookUrls } from "./auth.js";
import type { WorkerState } from "./types.js";

/** Message from satellite → primary */
interface SatelliteUpMessage {
  type: "satellite_hello" | "satellite_workers" | "satellite_chat" | "satellite_result" | "satellite_projects" | "satellite_api_request";
  machineId?: string;
  hostname?: string;
  platform?: string;
  capabilities?: MachineCapabilities;
  workers?: WorkerState[];
  workerId?: string;
  messages?: unknown[];
  full?: boolean;
  requestId?: string;
  ok?: boolean;
  error?: string;
  tty?: string;
  projects?: string[];
  // API relay fields
  method?: string;
  path?: string;
  body?: unknown;
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
  workers?: unknown[];    // satellite_all_workers: full worker list from primary
}

/** Probe this machine for hardware and software capabilities. */
function detectCapabilities(): MachineCapabilities {
  const caps: MachineCapabilities = {
    platform: platform(),
    arch: arch(),
    cpuCores: cpus().length,
    ramGb: Math.round(totalmem() / (1024 ** 3)),
  };

  // GPU detection (macOS: system_profiler, Linux: nvidia-smi)
  try {
    if (platform() === "darwin") {
      const sp = execFileSync("/usr/sbin/system_profiler", ["SPDisplaysDataType"], { timeout: 5000, encoding: "utf-8" });
      caps.gpu = true;
      const nameMatch = sp.match(/Chipset Model:\s*(.+)/i) || sp.match(/Chip:\s*(.+)/i);
      caps.gpuName = nameMatch?.[1]?.trim() || "Apple GPU";
    } else {
      const nv = execFileSync("nvidia-smi", ["--query-gpu=name", "--format=csv,noheader"], { timeout: 5000, encoding: "utf-8" });
      caps.gpu = true;
      caps.gpuName = nv.trim().split("\n")[0] || "NVIDIA GPU";
    }
  } catch {
    caps.gpu = false;
  }

  // Disk free space
  try {
    const df = execFileSync("/bin/df", ["-g", homedir()], { timeout: 3000, encoding: "utf-8" });
    const parts = df.split("\n")[1]?.split(/\s+/);
    if (parts?.[3]) caps.diskFreeGb = parseInt(parts[3], 10);
  } catch { /* skip */ }

  // Software detection — check if commands exist
  const check = (cmd: string, args: string[] = ["--version"]): boolean => {
    try { execFileSync(cmd, args, { timeout: 3000, encoding: "utf-8", stdio: "pipe" }); return true; }
    catch { return false; }
  };

  caps.ffmpeg = check("ffmpeg", ["-version"]);
  caps.docker = check("docker", ["--version"]);
  caps.python = check("python3", ["--version"]);
  caps.node = check("node", ["--version"]);

  // Python ML libraries
  if (caps.python) {
    caps.pytorch = check("python3", ["-c", "import torch"]);
    caps.tensorflow = check("python3", ["-c", "import tensorflow"]);
  }

  // Load custom tags from ~/.hive/capabilities.json
  try {
    const capFile = join(homedir(), ".hive", "capabilities.json");
    if (existsSync(capFile)) {
      const custom = JSON.parse(readFileSync(capFile, "utf-8")) as { tags?: string[] };
      if (custom.tags) caps.tags = custom.tags;
    }
  } catch { /* skip */ }

  return caps;
}

export class SatelliteClient {
  private primaryUrl: string;
  private token: string;
  private machineId: string;
  private capabilities: MachineCapabilities;
  private ws: WebSocket | null = null;
  private telemetry: TelemetryReceiver;
  private discovery: ProcessDiscovery;
  private streamer: SessionStreamer;
  private procMgr: ProcessManager;
  private reconnectDelay = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private chatSubs = new Map<string, string>(); // prefixed workerId → subKey
  private tickInterval: ReturnType<typeof setInterval> | null = null;
  // API relay: pending requests awaiting response from primary
  private pendingApiRequests = new Map<string, { resolve: (data: unknown) => void; timer: ReturnType<typeof setTimeout> }>();
  private apiRequestId = 0;

  constructor(primaryUrl: string, token: string, localToken: string) {
    this.primaryUrl = primaryUrl;
    this.token = token;
    this.machineId = hostname().toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 24) || "satellite";
    this.capabilities = detectCapabilities();

    console.log(`[satellite] Capabilities: ${JSON.stringify(this.capabilities)}`);

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

    // Register API proxy routes so local agents can talk to the primary
    this.registerApiProxy();

    // Install CLAUDE.md so local agents know about the Hive API
    this.installClaudeMd();

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

      // Send hello with capabilities
      this.send({
        type: "satellite_hello",
        machineId: this.machineId,
        hostname: hostname(),
        platform: platform(),
        capabilities: this.capabilities,
      } as SatelliteUpMessage);

      // Send initial worker list
      this.reportWorkers();
    });

    this.ws.on("message", (raw) => {
      try {
        const msg: SatelliteDownMessage = JSON.parse(raw.toString());
        this.handleMessage(msg).catch((err) => {
          console.log(`[satellite] Error handling ${msg.type}: ${err instanceof Error ? err.message : err}`);
        });
      } catch { /* malformed JSON */ }
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

  /** Relay an API request to the primary and wait for the response. */
  private relayToPrimary(method: string, path: string, body?: unknown): Promise<unknown> {
    return new Promise((resolve) => {
      const requestId = `api_${++this.apiRequestId}_${Date.now()}`;
      const timer = setTimeout(() => {
        this.pendingApiRequests.delete(requestId);
        resolve({ error: "Relay timeout" });
      }, 10_000);
      this.pendingApiRequests.set(requestId, { resolve, timer });
      this.send({
        type: "satellite_api_request",
        requestId,
        method,
        path,
        body,
      });
    });
  }

  /** Register API proxy routes on the satellite's local HTTP server.
   *  Local agents call these like normal Hive API — the satellite
   *  relays them to the primary via WebSocket.
   *
   *  Uses a catch-all `/api/*` relay so every current and future
   *  primary endpoint works on satellites automatically. Only
   *  `/api/workers` is handled locally (reads from workers.json). */
  registerApiProxy(): void {
    const app = this.telemetry.getApp();
    const auth = this.telemetry.getAuthMiddleware();
    if (!app || !auth) return;

    // GET /api/workers — read from workers.json (updated by satellite_all_workers)
    // This is the only route handled locally — reading the cached full worker list
    // is faster and works even if the primary WebSocket is momentarily down.
    app.get("/api/workers", auth, (_req: import("express").Request, res: import("express").Response) => {
      try {
        const data = JSON.parse(readFileSync(join(homedir(), ".hive", "workers.json"), "utf-8"));
        res.json(data.workers || []);
      } catch {
        // Fallback: return local workers only
        res.json(this.telemetry.getAll());
      }
    });

    // Catch-all: relay every other /api/* route to the primary daemon.
    // Reconstructs the full URL (path + query string) and forwards the
    // HTTP method + body. New primary endpoints work on satellites
    // with zero additional proxy code.
    app.all(/^\/api\//, auth, async (req: import("express").Request, res: import("express").Response) => {
      const method = req.method;
      // Reconstruct query string
      const qs = Object.entries(req.query as Record<string, string>)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join("&");
      const path = qs ? `${req.path}?${qs}` : req.path;
      const body = method === "GET" || method === "HEAD" ? undefined : req.body;

      try {
        const result = await this.relayToPrimary(method, path, body);
        res.json(result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(502).json({ error: `Relay failed: ${msg.slice(0, 200)}` });
      }
    });

    console.log("[satellite] API proxy registered: /api/workers (local) + catch-all relay for all other /api/* routes");
  }

  /** Install CLAUDE.md with Hive API instructions so local agents know how to
   *  communicate with peers across all machines. */
  private installClaudeMd(): void {
    const claudeDir = join(homedir(), ".claude");
    const claudeMdPath = join(claudeDir, "CLAUDE.md");

    const content = `## Hive — Production Agent

You are 1 of several Claude Code agents running simultaneously across multiple computers. Daemon at 127.0.0.1:3001 coordinates status, messaging, and learnings.

### Rules

- NEVER use AskUserQuestion or EnterPlanMode. Make your best guess. Wrong guesses get corrected faster than questions get answered.
- NEVER spawn new Claude instances, terminals, or agents.
- NEVER use the Task tool to launch subagents as a workaround for dispatching.
- Execute directly. Only dispatch to another agent when the task requires their active conversation context.
- Before any task: \`cat {project}/.claude/hive-learnings.md 2>/dev/null\`
- After solving anything non-obvious: write a learning back via the API. This is mandatory.
- Sandbox blocks \`curl\` to localhost. Use \`dangerouslyDisableSandbox: true\` for daemon API calls.
- Read-only status: \`cat ~/.hive/workers.json\`

### Identity

The identity hook outputs your quadrant as a system-reminder each prompt: "You are Q{N} ({tty}, {project})". Quadrants assigned by \`startedAt\` order (earliest = Q1).

### APIs

Daemon: http://127.0.0.1:3001 | Token: \`$(cat ~/.hive/token)\` | Auth header: \`Authorization: Bearer $TOKEN\`

| Endpoint | Purpose |
|---|---|
| \`GET /api/workers\` | List agents (all machines) |
| \`GET /api/context?workerId=X&history=1\` | Worker conversation context |
| \`POST /api/message {workerId, content}\` | Send prompt to agent (any machine) |
| \`GET /api/message-queue\` | View pending messages |
| \`POST /api/queue {task, project?, priority?}\` | Queue task |
| \`GET /api/queue\` | View task queue |
| \`POST /api/locks {workerId, path}\` | Acquire file lock |
| \`GET /api/locks\` | View all locks |
| \`DELETE /api/locks?workerId=X&path=Y\` | Release locks |
| \`GET /api/conflicts?path=X&excludeWorker=Y\` | Check conflicts |
| \`POST /api/scratchpad {key, value, setBy}\` | Shared context (1hr expiry) |
| \`GET /api/scratchpad?key=X\` | Read scratchpad |
| \`GET /api/artifacts?workerId=X\` | File changes by agent |
| \`POST /api/learning {project, lesson}\` | Persist lesson |
| \`POST /api/reviews {summary, url?, type?}\` | Report a reviewable change |
| \`GET /api/reviews\` | Read all reviews |
| \`GET /api/audit\` | Audit log |
| \`GET /api/signals\` | Worker signals |
| \`GET /api/models\` | Available agent models |
| \`GET /api/projects\` | Available projects |

### Cross-Machine Communication

All API calls go to \`127.0.0.1:3001\` — the local satellite daemon relays them to the primary automatically. You can send messages to agents on ANY machine using their workerId from \`/api/workers\`.

### Self-Unstick

1. Read learnings
2. Check artifacts
3. Try different approach (never retry same thing 3x)
4. If truly stuck, say so — human or auto-pilot intervenes
5. After solving: write the learning back
`;

    try {
      if (!existsSync(claudeDir)) mkdirSync(claudeDir, { recursive: true });
      // Only write if missing or outdated (check for our marker)
      const existing = existsSync(claudeMdPath) ? readFileSync(claudeMdPath, "utf-8") : "";
      if (!existing.includes("Hive — Production Agent")) {
        // Prepend Hive instructions to existing CLAUDE.md
        const merged = existing ? content + "\n---\n\n" + existing : content;
        writeFileSync(claudeMdPath, merged);
        console.log("[satellite] Installed CLAUDE.md with Hive API instructions");
      }
    } catch (err) {
      console.log(`[satellite] Failed to install CLAUDE.md: ${err instanceof Error ? err.message : err}`);
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
        const project = (!msg.project || msg.project === "~") ? homedir() : msg.project;
        const model = msg.model || "claude";
        const result = spawnTerminalWindow(project, model, msg.targetQuadrant, msg.initialMessage, this.telemetry.getAll().length);
        if (result.tty) {
          this.telemetry.markSpawn(result.tty);
          // Create spawn placeholder so the dashboard sees the tile immediately
          // (before the 3s discovery scan) and so discovery's placeholder-resolution
          // path forces idle on the real worker — matching primary behavior.
          const projectName = project.split("/").pop() || project;
          const normalizedTty = result.tty.replace("/dev/", "");
          const placeholderId = `spawning_${normalizedTty.replace(/\//g, "_")}`;
          this.telemetry.registerDiscovered(placeholderId, {
            id: placeholderId,
            pid: 0,
            project,
            projectName,
            status: "waiting" as const,
            currentAction: "Starting...",
            lastAction: "Spawning terminal",
            lastActionAt: Date.now(),
            errorCount: 0,
            startedAt: Date.now(),
            task: null,
            managed: false,
            tty: result.tty,
            model,
          });
          // Auto-remove placeholder after 20s if discovery hasn't replaced it
          setTimeout(() => {
            const still = this.telemetry.get(placeholderId);
            if (still && still.pid === 0) {
              this.telemetry.removeWorker(placeholderId);
            }
          }, 20_000);
        }
        this.send({
          type: "satellite_result",
          requestId: msg.requestId,
          ok: result.ok,
          error: result.error,
          tty: result.tty,
        });
        // Report immediately so primary sees the placeholder
        this.reportWorkers();
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
          this.discovery.suppressPrompt(worker.tty);
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
          // Suppress prompt re-detection for 20s so discovery doesn't
          // re-report the stale prompt text before the terminal advances
          this.discovery.suppressPrompt(worker.tty);
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

      case "satellite_all_workers": {
        // Primary sends the full merged worker list (local + all satellites).
        // Write to ~/.hive/workers.json so the identity hook on this machine
        // shows cross-machine peers in its peer summary.
        const allWorkers = (msg.workers || []) as Array<{ quadrant?: number; id?: string; tty?: string; projectName?: string; model?: string; machine?: string }>;
        try {
          const hiveDir = join(homedir(), ".hive");
          if (!existsSync(hiveDir)) mkdirSync(hiveDir, { recursive: true });
          writeFileSync(
            join(hiveDir, "workers.json"),
            JSON.stringify({ updatedAt: Date.now(), workers: allWorkers }, null, 2) + "\n"
          );
        } catch { /* non-critical */ }

        // Arrange local terminal windows to match primary-assigned quadrants.
        // Extract workers on this machine, map their prefixed IDs back to
        // local workers to get TTYs, then arrange + title them.
        const localWorkers = this.telemetry.getAll();
        const slots: Array<{ quadrant: number; tty: string; projectName: string; model: string }> = [];
        for (const remoteW of allWorkers) {
          if (!remoteW.machine || remoteW.machine !== this.machineId) continue;
          if (!remoteW.quadrant || !remoteW.id) continue;
          // remoteW.id is "machineId:localId" — extract localId
          const colonIdx = remoteW.id.indexOf(":");
          const localId = colonIdx >= 0 ? remoteW.id.slice(colonIdx + 1) : remoteW.id;
          const local = localWorkers.find(w => w.id === localId);
          if (local?.tty) {
            slots.push({
              quadrant: remoteW.quadrant,
              tty: local.tty,
              projectName: local.projectName || "agent",
              model: local.model || "claude",
            });
          }
        }
        if (slots.length > 0) {
          // Use total agent count across all machines for the formation,
          // so satellite windows occupy the correct fraction of the screen.
          const totalAgents = allWorkers.filter(w => w.quadrant).length;
          arrangeTerminalWindows(slots, totalAgents);
          updateTerminalTitles(slots);
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

          // Auto-push to keep repos in sync across machines
          try {
            await new Promise<void>((resolve, reject) => {
              execFile("/usr/bin/git", ["push"], { cwd: project, timeout: 30_000 },
                (err) => err ? reject(err) : resolve());
            });
            console.log(`[satellite-autocommit] Pushed to remote`);
          } catch (pushErr) {
            console.log(`[satellite-autocommit] Push failed (commit preserved) — ${pushErr instanceof Error ? pushErr.message : pushErr}`);
          }

          this.send({ type: "satellite_result", requestId: msg.requestId, ok: true });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          console.log(`[satellite-autocommit] Failed: ${errMsg}`);
          this.send({ type: "satellite_result", requestId: msg.requestId, ok: false, error: errMsg });
        }
        break;
      }

      case "satellite_api_response": {
        const pending = this.pendingApiRequests.get(msg.requestId || "");
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingApiRequests.delete(msg.requestId || "");
          pending.resolve((msg as unknown as Record<string, unknown>).data);
        }
        break;
      }

      case "satellite_update": {
        // Primary tells us to pull latest code and restart.
        // Find our own repo directory, git pull, then respawn the process.
        console.log("[satellite] Received update command — pulling latest code...");
        const repoDir = msg.project || join(homedir(), "factory/projects/hive");
        try {
          await new Promise<void>((resolve, reject) => {
            execFile("/usr/bin/git", ["pull", "--ff-only"], { cwd: repoDir, timeout: 30_000 },
              (err, stdout) => {
                if (err) reject(err);
                else { console.log(`[satellite] git pull: ${(stdout || "").trim()}`); resolve(); }
              });
          });
          this.send({ type: "satellite_result", requestId: msg.requestId, ok: true });
          // Restart: give time for the result to send, then exit.
          // The process supervisor (launchd/systemd/pm2) or install.sh wrapper
          // should restart us automatically.
          console.log("[satellite] Restarting in 2 seconds...");
          setTimeout(() => process.exit(0), 2000);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          console.log(`[satellite] Update failed: ${errMsg}`);
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
