/**
 * Satellite mode: connects this machine's terminals to a remote primary Hive daemon.
 *
 * The satellite runs local discovery + session streaming, reports workers to the
 * primary via WebSocket, and executes commands (message, kill, spawn, selection)
 * forwarded from the primary's dashboard.
 *
 * Usage: npx tsx apps/daemon/src/index.ts --satellite wss://xxx.trycloudflare.com TOKEN
 */

import { hostname } from "os";
import { homedir, platform, arch, cpus, totalmem } from "os";
import { join, basename } from "path";
import { unlinkSync, existsSync, writeFileSync, readFileSync, mkdirSync, readdirSync, statSync } from "fs";
import { execFile, execFileSync } from "child_process";
import type { MachineCapabilities, UploadedFileRef } from "@hive/types";
import { ProcessDiscovery } from "./discovery.js";
import { TelemetryReceiver } from "./telemetry.js";
import { SessionStreamer } from "./session-stream.js";
import { ProcessManager } from "./process-mgr.js";
import { patchHookUrls } from "./auth.js";
import { AutoPilot } from "./auto-pilot.js";
import { Watchdog } from "./watchdog.js";
import type { WorkerState } from "./types.js";
import { resolveExecCwd, runShellExec } from "./shell-exec.js";
import {
  chooseSatelliteRecoveryAction,
  SATELLITE_STABLE_CONNECTION_MS,
} from "./satellite-recovery.js";
import { appendControlPlaneAudit } from "./control-plane-audit.js";
import { storeUploadedFile } from "./upload-store.js";
import {
  FederationSocketClient,
  type FederationDisconnectMeta,
} from "./federation-socket.js";
import type { LoadedPlatform } from "./platform/interfaces.js";

/** Get the git commit hash of the hive repo (short, 8 chars). */
function getGitVersion(): string {
  try {
    // Resolve repo root from this file: apps/daemon/src/satellite.ts → ../../..
    const repoDir = join(import.meta.dirname, "..", "..", "..");
    return execFileSync("git", ["rev-parse", "--short=8", "HEAD"], {
      cwd: repoDir, timeout: 3000, encoding: "utf-8",
    }).trim();
  } catch { return "unknown"; }
}

/** Message from satellite → primary */
interface SatelliteUpMessage {
  type:
    | "satellite_hello"
    | "satellite_workers"
    | "satellite_chat"
    | "satellite_result"
    | "satellite_projects"
    | "satellite_api_request"
    | "satellite_context_response"
    | "satellite_heartbeat";
  machineId?: string;
  hostname?: string;
  platform?: string;
  capabilities?: MachineCapabilities;
  version?: string;
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
  context?: unknown;
  chatHistory?: unknown[];
  data?: unknown;
  ts?: number;
  upload?: UploadedFileRef;
}

/** Message from primary → satellite */
interface SatelliteDownMessage {
  type: string;
  requestId?: string;
  primaryUrl?: string;
  action?: string;
  workerId?: string;      // prefixed ID (machineId:localId)
  localWorkerId?: string; // local ID on this machine
  project?: string;
  model?: string;
  targetQuadrant?: number;
  initialMessage?: string;
  pendingTask?: string;
  content?: string;
  command?: string;
  cwd?: string;
  timeoutMs?: number;
  optionIndex?: number;
  files?: string[];       // auto-commit: file paths to commit
  message?: string;       // auto-commit: commit message
  workers?: unknown[];    // satellite_all_workers: full worker list from primary
  includeHistory?: boolean; // satellite_context: include conversation history
  historyLimit?: number;    // satellite_context: max history entries
  ts?: number;
  fileName?: string;
  mimeType?: string;
  size?: number;
  dataBase64?: string;
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
      // VRAM detection (NVIDIA only)
      try {
        const vram = execFileSync("nvidia-smi", ["--query-gpu=memory.total", "--format=csv,noheader,nounits"], { timeout: 5000, encoding: "utf-8" });
        const mb = parseInt(vram.trim().split("\n")[0], 10);
        if (mb > 0) caps.gpuVramGb = Math.round(mb / 1024);
      } catch { /* skip */ }
    }
  } catch {
    caps.gpu = false;
  }

  // Disk free space
  try {
    if (platform() === "win32") {
      // Windows: use PowerShell to get free space on the system drive
      const ps = execFileSync("powershell", ["-NoProfile", "-Command",
        "Get-Volume -DriveLetter C -ErrorAction SilentlyContinue | Select-Object -ExpandProperty SizeRemaining",
      ], { timeout: 5000, encoding: "utf-8" }).trim();
      const bytes = parseInt(ps, 10);
      if (bytes > 0) caps.diskFreeGb = Math.round(bytes / (1024 ** 3));
    } else {
      const dfArgs = platform() === "darwin" ? ["-g", homedir()] : ["--block-size=G", homedir()];
      const dfCmd = platform() === "darwin" ? "/bin/df" : "df";
      const df = execFileSync(dfCmd, dfArgs, { timeout: 3000, encoding: "utf-8" });
      const parts = df.split("\n")[1]?.split(/\s+/);
      if (parts?.[3]) caps.diskFreeGb = parseInt(parts[3], 10);
    }
  } catch { /* skip */ }

  // Software detection  --  check if commands exist
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

  // Load custom config from ~/.hive/capabilities.json (tags + project overrides)
  let customProjects: Record<string, string> | undefined;
  try {
    const capFile = join(homedir(), ".hive", "capabilities.json");
    if (existsSync(capFile)) {
      const custom = JSON.parse(readFileSync(capFile, "utf-8")) as { tags?: string[]; projects?: Record<string, string> };
      if (custom.tags) caps.tags = custom.tags;
      if (custom.projects) customProjects = custom.projects;
    }
  } catch { /* skip */ }

  // Auto-detect projects: scan common locations for git repos.
  // Each project is identified by directory name → absolute path.
  // Custom projects from capabilities.json override auto-detected ones.
  const projects: Record<string, string> = {};
  const scanDirs = [
    join(homedir(), "factory", "projects"),  // primary convention
    homedir(),                                // top-level repos (~/hive, ~/crawler)
    join(homedir(), "projects"),              // common convention
    join(homedir(), "code"),                  // common convention
    join(homedir(), "dev"),                   // common convention
  ];
  for (const dir of scanDirs) {
    try {
      if (!existsSync(dir)) continue;
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        try {
          if (!statSync(full).isDirectory()) continue;
          if (existsSync(join(full, ".git"))) {
            // Use directory name as project name (first match wins)
            if (!projects[entry]) projects[entry] = full;
          }
        } catch { /* skip unreadable dirs */ }
      }
    } catch { /* skip */ }
  }
  // Custom overrides take priority
  if (customProjects) Object.assign(projects, customProjects);
  if (Object.keys(projects).length > 0) caps.projects = projects;

  return caps;
}

export class SatelliteClient {
  private readonly machineId: string;
  private readonly capabilities: MachineCapabilities;
  private readonly telemetry: TelemetryReceiver;
  private readonly discovery: ProcessDiscovery;
  private readonly streamer: SessionStreamer;
  private readonly procMgr: ProcessManager;
  private readonly federation: FederationSocketClient<SatelliteDownMessage, SatelliteUpMessage>;
  private readonly runtimePlatform: LoadedPlatform;
  private autoPilot: AutoPilot | null = null;
  private watchdog: Watchdog | null = null;
  private chatSubs = new Map<string, string>(); // prefixed workerId → subKey
  private tickInterval: ReturnType<typeof setInterval> | null = null;
  // API relay: pending requests awaiting response from primary
  private pendingApiRequests = new Map<string, { resolve: (data: unknown) => void; timer: ReturnType<typeof setTimeout> }>();
  private apiRequestId = 0;
  private connectedAt = 0;
  private offlineSince = 0;
  private consecutiveFailures = 0;
  private shortLivedConnections = 0;
  private selfHealAttempts = 0;
  private lastSelfHealAt = 0;
  private selfHealInFlight = false;

  constructor(primaryUrl: string, token: string, localToken: string, runtimePlatform: LoadedPlatform) {
    this.machineId = hostname().toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 24) || "satellite";
    this.capabilities = detectCapabilities();
    this.runtimePlatform = runtimePlatform;

    console.log(`[satellite] Capabilities: ${JSON.stringify(this.capabilities)}`);

    // Local telemetry server (receives hooks from local Claude instances)
    this.telemetry = new TelemetryReceiver(3001, localToken, {
      terminal: runtimePlatform.terminal,
      windows: runtimePlatform.windows,
    });
    this.procMgr = new ProcessManager(this.telemetry);
    this.streamer = new SessionStreamer();
    this.discovery = new ProcessDiscovery(this.telemetry, this.streamer, {
      discovery: runtimePlatform.discovery,
      terminal: runtimePlatform.terminal,
    });

    // Patch hook URLs so local Claude instances report to local telemetry
    patchHookUrls(localToken);

    /**
     * Architectural note:
     * - SatelliteClient still owns the command protocol and recovery policy.
     * - FederationSocketClient owns the authenticated socket lifecycle.
     * This keeps the existing behavior intact while making transport concerns
     * testable in isolation.
     */
    this.federation = new FederationSocketClient<SatelliteDownMessage, SatelliteUpMessage>({
      primaryUrl,
      token,
      satelliteId: this.machineId,
      stableConnectionMs: SATELLITE_STABLE_CONNECTION_MS,
      heartbeatIntervalMs: 15_000,
      heartbeatTimeoutMs: 40_000,
      urls: {
        load: () => this.readPersistedPrimaryUrls(),
        save: (urls, activeUrl) => this.persistPrimaryUrls(urls, activeUrl),
      },
      hooks: {
        onOpen: () => {
          console.log(`[satellite] Connected to primary as "${this.machineId}"`);
          this.connectedAt = Date.now();
          this.offlineSince = 0;
          this.selfHealInFlight = false;
          this.send({
            type: "satellite_hello",
            machineId: this.machineId,
            hostname: hostname(),
            platform: platform(),
            capabilities: this.capabilities,
            version: getGitVersion(),
          });
          this.reportWorkers();
        },
        onMessage: (msg) => {
          this.handleMessage(msg).catch((err) => {
            console.log(`[satellite] Error handling ${msg.type}: ${err instanceof Error ? err.message : err}`);
          });
        },
        onDisconnect: async (meta) => this.handleFederationDisconnect(meta),
        onReconnectScheduled: ({ delayMs, nextUrl, rotatedUrl }) => {
          const rotated = rotatedUrl ? " (rotated primary URL)" : "";
          console.log(`[satellite] Disconnected. Reconnecting in ${delayMs / 1000}s via ${nextUrl}${rotated}...`);
        },
        onHeartbeatTimeout: ({ silenceMs }) => {
          console.log(`[satellite] Heartbeat timed out after ${Math.round(silenceMs / 1000)}s without a primary response`);
        },
        onMalformedMessage: (raw) => {
          console.log(`[satellite] Ignoring malformed primary frame: ${raw.slice(0, 120)}`);
        },
        isHeartbeatAck: (msg) => msg.type === "satellite_heartbeat_ack",
        makeHeartbeat: () => ({
          type: "satellite_heartbeat",
          machineId: this.machineId,
          version: getGitVersion(),
          ts: Date.now(),
        }),
      },
    });
  }

  /**
   * Read the persisted primary URL candidates from disk.
   *
   * The transport asks for these on reconnect so tunnel rotation stays
   * transparent to the user. We keep the filesystem access here because the
   * storage location is a Hive policy choice, not a transport concern.
   */
  private readPersistedPrimaryUrls(): string[] {
    const hiveDir = join(homedir(), ".hive");
    const primaryUrlFile = join(hiveDir, "primary-url");
    const urlsFile = join(hiveDir, "primary-urls.txt");
    try {
      return [
        ...(existsSync(primaryUrlFile) ? [readFileSync(primaryUrlFile, "utf-8")] : []),
        ...(existsSync(urlsFile) ? readFileSync(urlsFile, "utf-8").split("\n") : []),
      ].map((value) => value.trim()).filter(Boolean);
    } catch {
      return [];
    }
  }

  /**
   * Persist the active primary URL and the fallback list.
   *
   * The active URL gets its own file because existing install and recovery
   * flows already read `~/.hive/primary-url` directly.
   */
  private persistPrimaryUrls(urls: string[], activeUrl: string): void {
    const hiveDir = join(homedir(), ".hive");
    try {
      mkdirSync(hiveDir, { recursive: true });
      writeFileSync(join(hiveDir, "primary-url"), `${activeUrl}\n`);
      writeFileSync(join(hiveDir, "primary-urls.txt"), `${urls.join("\n")}\n`);
    } catch {
      // Best-effort persistence keeps the live control path non-blocking.
    }
  }

  start(): void {
    // Start local telemetry server (for hooks from local Claude instances)
    this.telemetry.start();
    this.telemetry.registerProcessManager(this.procMgr);
    this.telemetry.setStreamer(this.streamer);
    this.telemetry.onRemoval((workerId) => this.streamer.clearWorker(workerId));
    this.telemetry.onUpdate(() => this.reportWorkers());

    // Register API proxy routes so local agents can talk to the primary
    this.registerApiProxy();

    // Install CLAUDE.md so local agents know about the Hive API
    this.installClaudeMd();

    // Auto-pilot + watchdog  --  same as primary, runs locally on satellite
    this.autoPilot = new AutoPilot(this.telemetry, this.streamer, this.runtimePlatform.terminal);
    this.watchdog = new Watchdog(this.telemetry);

    // Initial discovery scan
    this.discovery.scan();
    this.telemetry.writeWorkersFile();
    console.log(`[satellite] Machine ID: ${this.machineId}`);
    console.log(`[satellite] Found ${this.telemetry.getAll().length} local agent(s)`);

    // Connect to primary through the dedicated federation transport.
    this.federation.start();

    // Periodic: full tick loop matching primary (discovery, status, auto-pilot, watchdog)
    this.tickInterval = setInterval(() => {
      this.telemetry.tick();
      this.procMgr.tick();
      this.discovery.scan();
      this.telemetry.writeWorkersFile();
      this.autoPilot?.tick();
      this.watchdog?.tick();
      this.reportWorkers();
    }, 3_000);
  }

  /**
   * Keep the recovery policy exactly where it used to live while letting the
   * federation transport own raw socket reconnection mechanics.
   */
  private async handleFederationDisconnect(meta: FederationDisconnectMeta): Promise<"reconnect" | "handled"> {
    const now = Date.now();
    if (!this.offlineSince) this.offlineSince = now;
    if (meta.stable) {
      this.consecutiveFailures = 1;
      this.shortLivedConnections = 0;
      this.selfHealAttempts = 0;
    } else {
      this.consecutiveFailures += 1;
      // Only count as short-lived if WS actually opened (local issue).
      // Pure connection failures (WS never opened) = primary unreachable.
      if (meta.wasConnected) {
        this.shortLivedConnections += 1;
      }
    }
    this.connectedAt = 0;

    const action = chooseSatelliteRecoveryAction({
      consecutiveFailures: this.consecutiveFailures,
      shortLivedConnections: this.shortLivedConnections,
      offlineMs: now - this.offlineSince,
      selfHealAttempts: this.selfHealAttempts,
      msSinceLastSelfHeal: this.lastSelfHealAt ? now - this.lastSelfHealAt : Number.POSITIVE_INFINITY,
    });

    if (action !== "none") {
      this.triggerSelfHeal(action).catch((err) => {
        console.log(`[satellite] Self-heal error: ${err instanceof Error ? err.message : String(err)}`);
      });
      return "handled";
    }
    return "reconnect";
  }

  private async triggerSelfHeal(action: "repair" | "reinstall"): Promise<void> {
    if (this.selfHealInFlight) return;
    this.selfHealInFlight = true;
    this.selfHealAttempts += 1;
    this.lastSelfHealAt = Date.now();

    const repoDir = join(import.meta.dirname, "..", "..", "..");
    const logPath = join(homedir(), ".hive", "logs", `satellite-self-heal-${action}.log`);
    const primaryUrlPath = join(homedir(), ".hive", "primary-url");
    const primaryTokenPath = join(homedir(), ".hive", "primary-token");

    const isWindows = process.platform === "win32";
    let selfHealShell: string;
    let selfHealArgs: string[];

    if (isWindows) {
      selfHealShell = "powershell";
      const psCmd = action === "reinstall"
        ? `$u = Get-Content '${primaryUrlPath}' -Raw; $t = Get-Content '${primaryTokenPath}' -Raw; if ($u -and $t) { Set-Location '${repoDir}'; & .\\scripts\\install.ps1 -Connect -Url $u.Trim() -Token $t.Trim() } *> '${logPath}'`
        : `Set-Location '${repoDir}'; & .\\scripts\\doctor.ps1 --repair-satellite *> '${logPath}'`;
      selfHealArgs = ["-NoProfile", "-Command", psCmd];
    } else {
      selfHealShell = "/bin/zsh";
      const bashCmd = action === "reinstall"
        ? `cd '${repoDir}' && PRIMARY_URL=$(cat '${primaryUrlPath}' 2>/dev/null) && PRIMARY_TOKEN=$(cat '${primaryTokenPath}' 2>/dev/null) && [ -n "$PRIMARY_URL" ] && [ -n "$PRIMARY_TOKEN" ] && nohup bash scripts/install.sh --connect "$PRIMARY_URL" "$PRIMARY_TOKEN" > '${logPath}' 2>&1 &`
        : `cd '${repoDir}' && nohup bash scripts/doctor.sh --repair-satellite > '${logPath}' 2>&1 &`;
      selfHealArgs = ["-lc", bashCmd];
    }

    console.log(`[satellite] Self-heal triggered: ${action} (failures=${this.consecutiveFailures}, short=${this.shortLivedConnections})`);
    appendControlPlaneAudit({
      ts: Date.now(),
      type: "maintenance",
      targetMachine: this.machineId,
      action: `self-heal:${action}`,
      ok: true,
    });

    try {
      await new Promise<void>((resolve, reject) => {
        execFile(selfHealShell, selfHealArgs, { timeout: 10_000 }, (err) => err ? reject(err) : resolve());
      });
      setTimeout(() => process.exit(0), 1_000);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.log(`[satellite] Self-heal failed: ${error}`);
      appendControlPlaneAudit({
        ts: Date.now(),
        type: "maintenance",
        targetMachine: this.machineId,
        action: `self-heal:${action}`,
        ok: false,
        error,
      });
      this.selfHealInFlight = false;
      this.federation.scheduleReconnect();
    }
  }

  private send(msg: SatelliteUpMessage): void {
    this.federation.send(msg);
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
   *  Local agents call these like normal Hive API  --  the satellite
   *  relays them to the primary via WebSocket.
   *
   *  Uses a catch-all `/api/*` relay so every current and future
   *  primary endpoint works on satellites automatically. Only
   *  `/api/workers` is handled locally (reads from workers.json). */
  registerApiProxy(): void {
    const app = this.telemetry.getApp();
    const auth = this.telemetry.getAuthMiddleware();
    if (!app || !auth) return;

    // GET /api/workers  --  read from workers.json (updated by satellite_all_workers)
    // This is the only route handled locally  --  reading the cached full worker list
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

    const content = `## Hive  --  Production Agent

You are 1 of several Claude Code agents running simultaneously across multiple computers. Daemon at 127.0.0.1:3001 coordinates status, messaging, and learnings.

### Rules

- NEVER use AskUserQuestion or EnterPlanMode. Make your best guess. Wrong guesses get corrected faster than questions get answered.
- NEVER spawn new Claude instances, terminals, or agents.
- NEVER use the Task tool to launch subagents as a workaround for dispatching.
- Execute directly. Only dispatch to another agent when the task requires their active conversation context.
- **Dispatch rule:** Before sending work to another agent, read your peer summary (shown every prompt) to know which Q is which model, project, and status. Send work to the right agent by checking peers first. Always \`GET /api/workers\` for fresh IDs before dispatching  --  worker IDs change when agents restart.
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
| \`POST /api/exec {command, cwd?, machine?, timeoutMs?}\` | Execute an audited shell command on the local or a remote machine |

### Cross-Machine Communication

All API calls go to \`127.0.0.1:3001\`  --  the local satellite daemon relays them to the primary automatically. You can send messages to agents on ANY machine using their workerId from \`/api/workers\`.

### Self-Unstick

1. Read learnings
2. Check artifacts
3. Try different approach (never retry same thing 3x)
4. If truly stuck, say so  --  human or auto-pilot intervenes
5. After solving: write the learning back
`;

    try {
      if (!existsSync(claudeDir)) mkdirSync(claudeDir, { recursive: true });
      // Only write if missing or outdated (check for our marker)
      const existing = existsSync(claudeMdPath) ? readFileSync(claudeMdPath, "utf-8") : "";
      if (!existing.includes("Hive  --  Production Agent")) {
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
  private lastReportSnapshot = "";
  private lastReportAt = 0;

  private reportWorkers(): void {
    const workers: WorkerState[] = this.telemetry.getAll().map(w => ({
      ...w,
      machine: this.machineId,
    }));
    // Fingerprint: count + IDs + statuses + actions. Only send when changed
    // OR every 15s as a heartbeat (primary expects activity within 30s).
    const snapshot = workers.map(w => `${w.id}:${w.status}:${w.currentAction || ""}`).sort().join("|");
    const now = Date.now();
    const changed = snapshot !== this.lastReportSnapshot;
    const heartbeatDue = now - this.lastReportAt > 15_000;
    if (!changed && !heartbeatDue) return;
    this.lastReportSnapshot = snapshot;
    this.lastReportAt = now;
    this.send({ type: "satellite_workers", machineId: this.machineId, workers });
  }

  /** Handle a command forwarded from the primary. */
  private async handleMessage(msg: SatelliteDownMessage): Promise<void> {
    switch (msg.type) {
      case "satellite_spawn": {
        const project = (!msg.project || msg.project === "~") ? homedir() : msg.project;
        const model = msg.model || "claude";
        const satHeldTask = msg.pendingTask;
        // Spawn without initial message — held until dashboard approval
        const result = this.runtimePlatform.windows.spawnTerminal(
          project,
          model,
          msg.targetQuadrant,
          undefined,
          this.telemetry.getAll().length,
        );
        if (result.tty) {
          this.telemetry.markSpawn(result.tty);
          // Create spawn placeholder so the dashboard sees the tile immediately
          // (before the 3s discovery scan) and so discovery's placeholder-resolution
          // path forces idle on the real worker  --  matching primary behavior.
          const projectName = project.split("/").pop() || project;
          const normalizedTty = result.tty.replace("/dev/", "");
          const placeholderId = `spawning_${normalizedTty.replace(/\//g, "_")}`;
          this.telemetry.registerDiscovered(placeholderId, {
            id: placeholderId,
            pid: 0,
            project,
            projectName,
            status: "waiting" as const,
            currentAction: "Awaiting approval",
            lastAction: "Spawning terminal",
            lastActionAt: Date.now(),
            errorCount: 0,
            startedAt: Date.now(),
            task: null,
            managed: false,
            tty: result.tty,
            model,
            promptType: "approval",
            promptMessage: "Approve this agent?",
            pendingTask: satHeldTask || null,
          });

          // Match local spawn behavior: poll the new terminal immediately so
          // trust/sandbox prompts and missing-CLI errors surface before the
          // next discovery tick.
          let polls = 0;
          const maxPolls = 13; // ~20 seconds
          const pollTimer = setInterval(() => {
            polls++;
            const current = this.telemetry.get(placeholderId);
            if (!current) {
              clearInterval(pollTimer);
              return;
            }

            const content = this.discovery.readTerminalContent(result.tty!);
            if (content) {
              const tail = content.slice(-500);
              if (tail.match(/command not found|not found:.*(?:claude|codex|openclaw)|No such file or directory/i)) {
                const cliName = model.charAt(0).toUpperCase() + model.slice(1);
                current.status = "idle";
                current.currentAction = `${cliName} CLI not installed`;
                current.lastAction = `${cliName} CLI not installed`;
                current.terminalPreview = `${cliName} is not installed on this machine. Install it first, then try again.`;
                this.telemetry.notifyExternal(current);
                clearInterval(pollTimer);
                setTimeout(() => {
                  const still = this.telemetry.get(placeholderId);
                  if (still && still.pid === 0) {
                    this.telemetry.removeWorker(placeholderId);
                  }
                }, 10_000);
                return;
              }
            }

            const prompt = this.discovery.detectPrompt(result.tty!, { bypassCache: true });
            if (prompt && current.promptType !== "approval") {
              // Only set CLI-detected prompts if the daemon-level approval gate
              // isn't active. The approval gate takes priority — CLI trust/sandbox
              // prompts are handled after the user approves the spawn.
              current.status = "waiting";
              current.promptType = prompt.type;
              current.promptMessage = prompt.message;
              current.currentAction = prompt.message;
              current.terminalPreview = prompt.content.split("\n").filter((l: string) => l.trim()).slice(-15).join("\n").trim().slice(0, 500) || undefined;
              this.telemetry.notifyExternal(current);
            }

            if (polls >= maxPolls) {
              clearInterval(pollTimer);
            }
          }, 1500);

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
          setTimeout(() => {
            this.runtimePlatform.windows.closeTerminal(worker.tty!);
          }, 500);
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
        const result = this.runtimePlatform.terminal.sendSelection(worker.tty, msg.optionIndex || 0);
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
        const wasApprovalGate = worker.promptType === "approval";
        const satPendingTask = worker.pendingTask || null;

        if (wasApprovalGate) {
          // Spawn-approval gate: clear the gate, then handle any CLI prompts
          // before sending the held task.
          worker.promptType = null;
          worker.promptMessage = undefined;
          worker.pendingTask = null;
          worker.status = "idle";
          worker.currentAction = null;
          worker.lastAction = "Approved from dashboard";
          worker.lastActionAt = Date.now();
          this.telemetry.notifyExternal(worker);
          this.discovery.suppressPrompt(worker.tty);

          // Check if Claude is also at a CLI trust/sandbox prompt — dismiss it
          // with Enter before sending the task. Without this, the task text gets
          // dumped into the ink selection UI instead of the chat prompt.
          const cliPrompt = this.discovery.detectPrompt(worker.tty, { bypassCache: true });
          const dismissFirst = !!cliPrompt;

          const sendTask = () => {
            if (satPendingTask) {
              this.telemetry.sendToWorkerAsync(localId, satPendingTask, {
                source: "dashboard",
                queueIfBusy: false,
                markDashboardInput: true,
              }).then((r) => {
                console.log(r.ok ? `Spawn approved + task sent for ${worker.tty}` : `Spawn approved but task send failed: ${r.error}`);
              }).catch(() => {});
            } else {
              console.log(`Spawn approved (no pending task) for ${worker.tty}`);
            }
          };

          if (dismissFirst) {
            // Dismiss CLI prompt first, then wait for Claude to boot before sending task
            this.runtimePlatform.terminal.sendKeystrokeAsync(worker.tty, "enter").then(() => {
              // Wait 5s for Claude to finish booting past trust/sandbox prompts
              setTimeout(sendTask, 5000);
            }).catch(() => sendTask());
          } else {
            sendTask();
          }
          this.send({ type: "satellite_result", requestId: msg.requestId, ok: true });
        } else {
          // Legacy trust/sandbox prompt: send Enter keystroke
          const result = this.runtimePlatform.terminal.sendKeystroke(worker.tty, "enter");
          if (result.ok) {
            worker.promptType = null;
            worker.promptMessage = undefined;
            worker.status = "idle";
            worker.currentAction = "Starting...";
            worker.lastAction = "Prompt approved from dashboard";
            worker.lastActionAt = Date.now();
            this.telemetry.notifyExternal(worker);
            this.discovery.suppressPrompt(worker.tty);
          }
          this.send({ type: "satellite_result", requestId: msg.requestId, ok: result.ok, error: result.error });
        }
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

      case "satellite_context": {
        // Primary is requesting worker context (conversation history, status).
        // Read it locally and send back  --  this is what makes cross-machine
        // context queries work transparently.
        const localId = msg.localWorkerId || "";
        const worker = this.telemetry.get(localId);
        if (!worker) {
          this.send({ type: "satellite_result", requestId: msg.requestId, ok: false, error: "Worker not found" });
          return;
        }
        const includeHistory = msg.includeHistory === true;
        const historyLimit = typeof msg.historyLimit === "number" ? msg.historyLimit : 6;
        const context = this.telemetry.getWorkerContext(localId, { includeHistory, historyLimit });
        // Also get recent chat entries for richer context
        const chatHistory = includeHistory ? this.streamer.readHistory(localId).slice(-historyLimit) : [];
        this.send({
          type: "satellite_context_response",
          requestId: msg.requestId,
          context,
          chatHistory,
        } as unknown as SatelliteUpMessage);
        break;
      }

      case "satellite_upload": {
        if (!msg.fileName || !msg.dataBase64) {
          this.send({ type: "satellite_result", requestId: msg.requestId, ok: false, error: "Missing upload payload" });
          return;
        }

        try {
          const upload = storeUploadedFile({
            fileName: msg.fileName,
            mimeType: msg.mimeType,
            dataBase64: msg.dataBase64,
            size: msg.size,
            machine: this.machineId,
          });
          this.send({
            type: "satellite_result",
            requestId: msg.requestId,
            ok: true,
            upload,
          } as unknown as SatelliteUpMessage);
        } catch (err) {
          this.send({
            type: "satellite_result",
            requestId: msg.requestId,
            ok: false,
            error: err instanceof Error ? err.message : "Upload failed",
          });
        }
        break;
      }

      case "satellite_exec": {
        const command = msg.command || "";
        if (!command.trim()) {
          this.send({ type: "satellite_result", requestId: msg.requestId, ok: false, error: "Missing command" });
          return;
        }

        const resolved = resolveExecCwd(msg.cwd);
        if (!resolved.cwd) {
          this.send({
            type: "satellite_result",
            requestId: msg.requestId,
            ok: false,
            error: resolved.error || "Invalid working directory",
            command,
            cwd: msg.cwd,
          } as unknown as SatelliteUpMessage);
          return;
        }

        const result = await runShellExec({
          command,
          cwd: resolved.cwd,
          timeoutMs: msg.timeoutMs,
        });
        appendControlPlaneAudit({
          ts: Date.now(),
          type: "exec",
          targetMachine: this.machineId,
          command,
          cwd: result.cwd,
          ok: result.ok,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          durationMs: result.durationMs,
          ...(result.error ? { error: result.error } : {}),
        });
        this.send({
          type: "satellite_result",
          requestId: msg.requestId,
          ...result,
        } as unknown as SatelliteUpMessage);
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
          // remoteW.id is "machineId:localId"  --  extract localId
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
          // Re-map to local positions: this machine's agents fill its own
          // screen entirely. Sort by global quadrant, then assign local
          // positions 1..N so N agents = N-row full-screen stack.
          slots.sort((a, b) => a.quadrant - b.quadrant);
          const localSlots = slots.map((s, i) => ({ ...s, quadrant: i + 1 }));
          this.runtimePlatform.windows.arrangeWindows(localSlots);
        }
        break;
      }

      case "satellite_primary_url": {
        if (msg.primaryUrl) {
          this.federation.rememberPrimaryUrl(msg.primaryUrl, true);
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
            execFile("git", ["add", ...existingFiles], { cwd: project, timeout: 10_000 },
              (err) => err ? reject(err) : resolve());
          });
          const gitCommit = () => new Promise<string>((resolve, reject) => {
            const shortTask = commitMessage.slice(0, 100);
            const fileNames = existingFiles.map(f => basename(f)).join(", ");
            const fullMsg = `${shortTask}\n\nFiles: ${fileNames}\n\nAuto-committed by Hive (satellite: ${this.machineId}).`;
            execFile("git", ["commit", "-m", fullMsg, "--no-verify"], { cwd: project, timeout: 15_000 },
              (err, stdout) => err ? reject(err) : resolve(stdout));
          });
          const gitHash = () => new Promise<string>((resolve, reject) => {
            execFile("git", ["rev-parse", "--short", "HEAD"], { cwd: project, timeout: 3_000, encoding: "utf-8" },
              (err, stdout) => err ? reject(err) : resolve((stdout || "").trim()));
          });

          await gitAdd();
          await gitCommit();
          const hash = await gitHash();

          console.log(`[satellite-autocommit] Committed ${existingFiles.length} file(s) → ${hash}`);

          // Auto-push to keep repos in sync across machines
          try {
            await new Promise<void>((resolve, reject) => {
              execFile("git", ["push"], { cwd: project, timeout: 30_000 },
                (err) => err ? reject(err) : resolve());
            });
            console.log(`[satellite-autocommit] Pushed to remote`);
          } catch (pushErr) {
            console.log(`[satellite-autocommit] Push failed (commit preserved)  --  ${pushErr instanceof Error ? pushErr.message : pushErr}`);
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
        // After pulling, re-run the install script so the process supervisor
        // config (batch file, Task Scheduler, launchd plist) stays in sync
        // with the code. This is what makes updates fully automatic.
        console.log("[satellite] Received update command  --  pulling latest code...");
        const repoDir = msg.project || join(import.meta.dirname, "..", "..", "..");
        try {
          await new Promise<void>((resolve, reject) => {
            execFile("git", ["pull", "--ff-only"], { cwd: repoDir, timeout: 30_000 },
              (err, stdout) => {
                if (err) reject(err);
                else { console.log(`[satellite] git pull: ${(stdout || "").trim()}`); resolve(); }
              });
          });

          // Re-run install script to update process supervisor config
          // (batch file restart loop, Task Scheduler triggers, launchd plist).
          // This ensures the supervisor config always matches the pulled code.
          const primaryUrlPath = join(homedir(), ".hive", "primary-url");
          const primaryTokenPath = join(homedir(), ".hive", "primary-token");
          const logPath = join(homedir(), ".hive", "logs", "satellite-update.log");
          const isWindows = process.platform === "win32";

          if (isWindows) {
            const psCmd = `$u = Get-Content '${primaryUrlPath}' -Raw; $t = Get-Content '${primaryTokenPath}' -Raw; if ($u -and $t) { Set-Location '${repoDir}'; & .\\scripts\\install.ps1 -Connect -Url $u.Trim() -Token $t.Trim() } *> '${logPath}'`;
            await new Promise<void>((resolve) => {
              execFile("powershell", ["-NoProfile", "-Command", psCmd],
                { timeout: 60_000 }, (err) => {
                  if (err) console.log(`[satellite] install.ps1 re-run warning: ${err.message.slice(0, 100)}`);
                  else console.log("[satellite] install.ps1 re-run complete");
                  resolve(); // non-fatal — the pull already landed
                });
            });
          } else {
            const bashCmd = `cd '${repoDir}' && PRIMARY_URL=$(cat '${primaryUrlPath}' 2>/dev/null) && PRIMARY_TOKEN=$(cat '${primaryTokenPath}' 2>/dev/null) && [ -n "$PRIMARY_URL" ] && [ -n "$PRIMARY_TOKEN" ] && bash scripts/install.sh --connect "$PRIMARY_URL" "$PRIMARY_TOKEN" > '${logPath}' 2>&1`;
            const shell = existsSync("/bin/zsh") ? "/bin/zsh" : "/bin/bash";
            await new Promise<void>((resolve) => {
              execFile(shell, ["-lc", bashCmd],
                { timeout: 60_000 }, (err) => {
                  if (err) console.log(`[satellite] install.sh re-run warning: ${err.message.slice(0, 100)}`);
                  else console.log("[satellite] install.sh re-run complete");
                  resolve();
                });
            });
          }

          this.send({ type: "satellite_result", requestId: msg.requestId, ok: true });
          // Restart: the install script already re-registered the process
          // supervisor, so exit and let it restart us with fresh code.
          console.log("[satellite] Restarting in 2 seconds...");
          setTimeout(() => process.exit(0), 2000);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          console.log(`[satellite] Update failed: ${errMsg}`);
          this.send({ type: "satellite_result", requestId: msg.requestId, ok: false, error: errMsg });
        }
        break;
      }

      case "satellite_maintenance": {
        const repoDir = join(import.meta.dirname, "..", "..", "..");
        const action = msg.action === "repair" || msg.action === "reinstall" ? msg.action : "repair";
        const logPath = join(homedir(), ".hive", "logs", action === "reinstall" ? "satellite-reinstall.log" : "satellite-repair.log");
        const primaryUrlPath = join(homedir(), ".hive", "primary-url");
        const primaryTokenPath = join(homedir(), ".hive", "primary-token");

        const isWindows = process.platform === "win32";
        let detachedCommand: string;
        let shell: string;
        let shellArgs: string[];

        if (isWindows) {
          shell = "powershell";
          if (action === "reinstall") {
            // Read URL/token from files, then run install script
            detachedCommand = `$u = Get-Content '${primaryUrlPath}' -Raw; $t = Get-Content '${primaryTokenPath}' -Raw; if ($u -and $t) { Set-Location '${repoDir}'; git pull --ff-only; & .\\scripts\\install.ps1 -Connect -Url $u.Trim() -Token $t.Trim() } *> '${logPath}'`;
          } else {
            detachedCommand = `Set-Location '${repoDir}'; & .\\scripts\\doctor.ps1 --repair-satellite *> '${logPath}'`;
          }
          shellArgs = ["-NoProfile", "-Command", detachedCommand];
        } else {
          shell = "/bin/zsh";
          if (action === "reinstall") {
            detachedCommand = `cd '${repoDir}' && PRIMARY_URL=$(cat '${primaryUrlPath}' 2>/dev/null) && PRIMARY_TOKEN=$(cat '${primaryTokenPath}' 2>/dev/null) && [ -n "$PRIMARY_URL" ] && [ -n "$PRIMARY_TOKEN" ] && git pull --ff-only && nohup bash scripts/install.sh --connect "$PRIMARY_URL" "$PRIMARY_TOKEN" > '${logPath}' 2>&1 &`;
          } else {
            detachedCommand = `cd '${repoDir}' && nohup bash scripts/doctor.sh --repair-satellite > '${logPath}' 2>&1 &`;
          }
          shellArgs = ["-lc", detachedCommand];
        }

        console.log(`[satellite] Received maintenance command  --  action=${action}`);

        try {
          await new Promise<void>((resolve, reject) => {
            execFile(shell, shellArgs, { timeout: 10_000 }, (err) => err ? reject(err) : resolve());
          });
          this.send({
            type: "satellite_result",
            requestId: msg.requestId,
            ok: true,
            action,
            logPath,
          } as unknown as SatelliteUpMessage);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          console.log(`[satellite] Maintenance failed: ${errMsg}`);
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
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
    this.federation.stop();

    // Clean up pending API requests to prevent memory leaks and phantom rejections.
    for (const [id, entry] of this.pendingApiRequests) {
      clearTimeout(entry.timer);
      entry.resolve(null);
      this.pendingApiRequests.delete(id);
    }
  }
}
