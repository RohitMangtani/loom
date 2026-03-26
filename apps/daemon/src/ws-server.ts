import { WebSocketServer, WebSocket } from "ws";
import { URL } from "url";
import { arch, cpus, homedir, hostname as osHostname, platform as osPlatform, totalmem } from "os";
import { realpathSync, unlinkSync, readdirSync, statSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import type { TelemetryReceiver } from "./telemetry.js";
import type { ProcessManager } from "./process-mgr.js";
import type { SessionStreamer } from "./session-stream.js";
import { sendSelectionToTty, sendEnterToTty, sendEnterToTtyAsync } from "./tty-input.js";
import { spawnTerminalWindow, closeTerminalWindow } from "./arrange-windows.js";
import { validateToken } from "./auth.js";
import { ProcessDiscovery } from "./discovery.js";
import type { ChatEntry, DaemonMessage, DaemonResponse, WorkerState, ConnectedMachine, MachineCapabilities, UploadedFileRef } from "./types.js";
import { execFileSync } from "child_process";
import type { WebPushManager } from "./web-push.js";
import { scanLocalProjects } from "./project-discovery.js";
import { appendControlPlaneAudit, getControlPlaneAuditPath, readControlPlaneAudit } from "./control-plane-audit.js";
import { normalizeExecTimeout, resolveExecCwd, runShellExec } from "./shell-exec.js";
import { storeUploadedFile } from "./upload-store.js";
import type { TerminalIO, WindowManager } from "./platform/interfaces.js";
import {
  isSafeFileName,
  isSafeMachineId,
  isSafeModelId,
  isSafePathField,
  isSafeRequestId,
  isSafeTaskField,
  isSafeWorkerId,
  isValidQuadrant,
} from "./control-plane-guards.js";
import { HiveUser, UserRegistry } from "./user-registry.js";
import { ReplayManager } from "./replay.js";
import type { HiveUser as HiveUserInfo } from "@hive/types";

/** Get the git commit hash of the hive repo (short, 8 chars). */
function getLocalVersion(): string {
  try {
    const repoDir = join(import.meta.dirname, "..", "..", "..");
    return execFileSync("git", ["rev-parse", "--short=8", "HEAD"], {
      cwd: repoDir, timeout: 3000, encoding: "utf-8",
    }).trim();
  } catch { return "unknown"; }
}

const LOCAL_MACHINE_LABEL = osHostname();
const TUNNEL_FILE = join(homedir(), ".hive", "tunnel-url.txt");

function createLegacyAdminUser(token: string): HiveUser {
  return {
    id: "legacy_admin",
    name: "admin",
    role: "admin",
    token,
    createdAt: 0,
  };
}

/** Satellite connection state */
interface SatelliteConnection {
  ws: WebSocket;
  machineId: string;
  hostname: string;
  workers: WorkerState[];
  connectedAt: number;
  lastSeen: number;
  capabilities?: MachineCapabilities;
  version?: string;
}

export class WsServer {
  private wss: WebSocketServer | null = null;
  private telemetry: TelemetryReceiver;
  private procMgr: ProcessManager;
  private streamer: SessionStreamer;
  private discovery: ProcessDiscovery | null = null;
  private port: number;
  private token: string;
  private viewerToken: string;
  private terminal: TerminalIO | null;
  private windows: WindowManager | null;
  private userRegistry: UserRegistry;
  private replayManager: ReplayManager;
  private connectedUsers = new Map<WebSocket, HiveUser>();
  private clients = new Set<WebSocket>();
  private readOnlyClients = new Set<WebSocket>();
  // Track which worker each client is subscribed to
  private clientSubs = new Map<WebSocket, string>();
  private lastWorkersSnapshot: string | null = null;
  private lastModelsSnapshot: string | null = null;
  private lastMachinesSnapshot: string | null = null;
  private lastBroadcastPrimaryUrl: string | null = null;
  private pushMgr: WebPushManager | null = null;

  // Satellite connections: machineId → connection
  private satellites = new Map<string, SatelliteConnection>();
  // Satellite WebSocket → machineId (reverse lookup)
  private satelliteWs = new Map<WebSocket, string>();
  // Dashboard clients subscribed to satellite workers: prefixed workerId → Set<clientWs>
  private satelliteChatClients = new Map<string, Set<WebSocket>>();
  // Cooldown: after dashboard approves/selects a satellite worker, suppress stale
  // promptType from incoming satellite_workers reports for a short period.
  // Key: "machineId:localWorkerId" → expiry timestamp
  private satelliteOverrides = new Map<string, { until: number; status: string; currentAction: string | null; lastAction: string }>();
  // Satellite status smoothing: mirrors discovery.ts hysteresis for remote workers.
  // Without this, the primary blindly relays whatever the satellite reports every 3s,
  // causing dashboard flapping (working→idle→working) when the satellite's own detection
  // catches intermediate states between hysteresis checks.
  // Key: "machineId:localWorkerId"
  private satelliteIdleCounts = new Map<string, number>();       // consecutive idle reports
  private static readonly SAT_IDLE_HYSTERESIS = 2;              // require N consecutive idle reports
  // Satellite status change tracking: for notifications on working→idle transitions
  private satellitePrevStatus = new Map<string, string>();  // "machineId:localId" → last status
  private satelliteStatusListeners: Array<(workerId: string, worker: WorkerState, prevStatus: string) => void> = [];
  // Satellite auto-pilot: track stuck state for grace period + dedup
  private satelliteAutoApproved = new Set<string>();
  private satelliteStuckFirstSeen = new Map<string, number>();
  // Pending satellite context requests: requestId → resolver
  private pendingSatelliteRequests = new Map<string, { resolve: (data: unknown) => void; timer: ReturnType<typeof setTimeout>; machineId: string }>();
  private pendingSatelliteCommands = new Map<string, { resolve: (data: Record<string, unknown>) => void; timer: ReturnType<typeof setTimeout>; machineId: string }>();
  // Satellite handshake race: buffer worker snapshots that arrive before hello.
  private pendingSatelliteWorkers = new Map<string, WorkerState[]>();

  constructor(
    telemetry: TelemetryReceiver,
    procMgr: ProcessManager,
    streamer: SessionStreamer,
    port: number,
    token: string,
    viewerToken: string,
    userRegistry: UserRegistry,
    replayManager: ReplayManager,
    platform?: { terminal: TerminalIO; windows: WindowManager },
  ) {
    this.telemetry = telemetry;
    this.procMgr = procMgr;
    this.streamer = streamer;
    this.port = port;
    this.token = token;
    this.viewerToken = viewerToken;
    this.userRegistry = userRegistry;
    this.replayManager = replayManager;
    this.terminal = platform?.terminal || null;
    this.windows = platform?.windows || null;

    this.telemetry.onUpdate((workerId, worker) => {
      this.broadcast({
        type: "worker_update",
        worker,
        workerId,
      });
    });

    this.telemetry.onReviewAdded((review) => {
      this.broadcast({
        type: "review_added",
        review,
      });
    });

    // Satellite relay: let the REST API route messages to satellite workers
    this.telemetry.setSatelliteRelay(
      async (workerId, content, from) => {
        const sat = this.getSatelliteForWorker(workerId);
        if (!sat) return { ok: false, error: `Satellite for "${workerId}" not connected` };
        const parsed = this.parseSatelliteWorker(workerId)!;
        this.sendToSatellite(sat, {
          type: "satellite_message",
          requestId: `api_msg_${Date.now()}`,
          workerId,
          localWorkerId: parsed.localId,
          content,
        });
        // Optimistic update + clear hysteresis so satellite stays green
        const satKey = `${sat.machineId}:${parsed.localId}`;
        this.satelliteIdleCounts.set(satKey, 0);
        const remote = sat.workers.find(w => w.id === parsed.localId);
        if (remote) {
          remote.status = "working";
          remote.currentAction = "Thinking...";
          remote.lastAction = from ? `Message from ${from}` : "Message via API";
          remote.lastActionAt = Date.now();
        }
        this.lastWorkersSnapshot = null;
        return { ok: true };
      },
      () => this.getAllWorkers(),
      (repoDir) => this.updateAllSatellites(repoDir),
    );

    // Capability-based routing: let telemetry query machine capabilities for task dispatch
    this.telemetry.setCapabilityRouter(
      (machineId, requires) => this.machineHasCapabilities(machineId, requires),
      (requires, preferMachine) => this.findCapableMachine(requires, preferMachine),
    );

    // Satellite context relay: let the REST API query satellite workers' context
    this.telemetry.setSatelliteContextRelay(async (workerId, options) => {
      const sat = this.getSatelliteForWorker(workerId);
      if (!sat) return null;
      const parsed = this.parseSatelliteWorker(workerId);
      if (!parsed) return null;
      return this.requestSatelliteContext(sat, workerId, parsed.localId, options);
    });

    this.telemetry.setSwarmApi(
      () => this.getProjects() as { projects: Array<{ name: string; path: string; machines?: Record<string, string> }> },
      () => this.getAllCapabilities(),
      (request) => this.spawnViaControlPlane(request),
      (workerId, fromMachine) => this.killViaControlPlane(workerId, fromMachine),
      (machineId, action, fromMachine) => this.maintainSatelliteViaControlPlane(machineId, action, fromMachine),
      (request) => this.execViaControlPlane(request),
    );

    // Auto-commit: forward satellite commit requests to the correct satellite machine
    this.telemetry.onAutoCommit((workerId, project, files, message) => {
      const sat = this.getSatelliteForWorker(workerId);
      if (!sat) return; // Local workers are committed directly by telemetry
      const parsed = this.parseSatelliteWorker(workerId);
      if (!parsed) return;
      this.sendToSatellite(sat, {
        type: "satellite_autocommit",
        requestId: `autocommit_${Date.now()}`,
        localWorkerId: parsed.localId,
        project,
        files,
        message,
      });
      console.log(`[auto-commit] Forwarded commit request for ${workerId} to satellite ${sat.machineId}`);
    });

    this.telemetry.onRemoval((removedId) => {
      this.broadcast({ type: "worker_removed", workerId: removedId });
      const workers = this.getAllWorkers();
      this.lastWorkersSnapshot = JSON.stringify(workers);
      this.broadcast({ type: "workers", workers });
    });

    // Atomic placeholder→real worker swap: single full-state broadcast
    this.telemetry.onFullBroadcast(() => {
      const workers = this.getAllWorkers();
      this.lastWorkersSnapshot = JSON.stringify(workers);
      this.broadcast({ type: "workers", workers });
    });

    this.procMgr.setOutputHandler((workerId, data) => {
      this.broadcast({
        type: "chat",
        workerId,
        content: data,
      });
    });
  }

  /** Build the list of available agent types (built-in + custom from agents.json). */
  private getAvailableModels(): { id: string; label: string }[] {
    const builtIn = [
      { id: "claude", label: "Claude" },
      { id: "codex", label: "Codex" },
      { id: "openclaw", label: "OpenClaw" },
    ];
    const custom = ProcessDiscovery.getCustomAgents().map(a => ({
      id: a.id,
      label: a.label,
    }));
    return [...builtIn, ...custom];
  }

  /** Set the discovery instance (for prompt cache management) */
  setDiscovery(discovery: ProcessDiscovery): void {
    this.discovery = discovery;
  }

  /** Set the WebPushManager (for push subscription handling) */
  setPushManager(mgr: WebPushManager): void {
    this.pushMgr = mgr;
  }

  private revertHistory: import("./revert-history.js").RevertHistory | null = null;

  /** Set the RevertHistory (for WS-based revert operations) */
  setRevertHistory(rh: import("./revert-history.js").RevertHistory): void {
    this.revertHistory = rh;
  }

  private deviceLayer: import("./devices/index.js").DeviceLayer | null = null;

  /** Set the DeviceLayer (for WS-based device queries) */
  setDeviceLayer(dl: import("./devices/index.js").DeviceLayer): void {
    this.deviceLayer = dl;
    dl.setBroadcast((msg) => this.publicBroadcast(msg));
  }

  /** Register a listener for satellite worker status changes.
   *  Fires when a satellite worker transitions between states (e.g., working→idle).
   *  Used by NotificationManager to send push notifications for remote workers. */
  onSatelliteStatusChange(cb: (workerId: string, worker: WorkerState, prevStatus: string) => void): void {
    this.satelliteStatusListeners.push(cb);
  }

  /** Get all workers: local + satellite, merged into one list. */
  private getAllWorkers(): WorkerState[] {
    const local = this.telemetry.getAll().map((worker) => ({
      ...worker,
      machineLabel: worker.machineLabel || LOCAL_MACHINE_LABEL,
    }));
    const remote: WorkerState[] = [];
    for (const sat of this.satellites.values()) {
      for (const w of sat.workers) {
        remote.push({
          ...w,
          // Prefix ID to ensure global uniqueness
          id: `${sat.machineId}:${w.id}`,
          machine: sat.machineId,
          machineLabel: sat.hostname,
        });
      }
    }

    // Assign quadrants to satellite workers so the dashboard renders them.
    // Local workers already have quadrants from writeWorkersFile(); satellite
    // workers need slots assigned here to avoid being filtered out.
    if (remote.length > 0) {
      const usedSlots = new Set(local.map(w => w.quadrant).filter(Boolean) as number[]);
      for (const w of remote) {
        for (let slot = 1; slot <= 8; slot++) {
          if (!usedSlots.has(slot)) {
            w.quadrant = slot;
            usedSlots.add(slot);
            break;
          }
        }
      }
    }

    return [...local, ...remote];
  }

  /** Get satellite connection diagnostics for debugging. */
  getSatelliteDiagnostics(): Array<{ machineId: string; hostname: string; workerCount: number; connectedAt: number; lastSeen: number; wsState: number }> {
    const diag: Array<{ machineId: string; hostname: string; workerCount: number; connectedAt: number; lastSeen: number; wsState: number }> = [];
    for (const sat of this.satellites.values()) {
      diag.push({
        machineId: sat.machineId,
        hostname: sat.hostname,
        workerCount: sat.workers.length,
        connectedAt: sat.connectedAt,
        lastSeen: sat.lastSeen,
        wsState: sat.ws.readyState,
      });
    }
    return diag;
  }

  /** Check if a worker ID belongs to a satellite (contains ':'). */
  private parseSatelliteWorker(workerId: string): { machineId: string; localId: string } | null {
    const idx = workerId.indexOf(":");
    if (idx < 0) return null;
    return { machineId: workerId.slice(0, idx), localId: workerId.slice(idx + 1) };
  }

  /** Get the satellite connection for a worker ID, or null if local. */
  private getSatelliteForWorker(workerId: string): SatelliteConnection | null {
    const parsed = this.parseSatelliteWorker(workerId);
    if (!parsed) return null;
    return this.satellites.get(parsed.machineId) || null;
  }

  /** Tell all connected satellites to pull latest code and restart. */
  updateAllSatellites(repoDir?: string): void {
    for (const sat of this.satellites.values()) {
      console.log(`[satellite-update] Sending update command to "${sat.machineId}"`);
      this.sendToSatellite(sat, {
        type: "satellite_update",
        requestId: `update_${Date.now()}`,
        project: repoDir,
      });
    }
  }

  /** Build the list of connected satellite machines for the dashboard. */
  private getConnectedMachines(): ConnectedMachine[] {
    const machines: ConnectedMachine[] = [];
    for (const sat of this.satellites.values()) {
      machines.push({
        id: sat.machineId,
        hostname: sat.hostname,
        workerCount: sat.workers.length,
        capabilities: sat.capabilities,
      });
    }
    return machines;
  }

  /** Check if a machine (by machineId) has all required capabilities. */
  machineHasCapabilities(machineId: string, requires: string[]): boolean {
    if (requires.length === 0) return true;
    const sat = this.satellites.get(machineId);
    if (!sat?.capabilities) return false;
    const caps = sat.capabilities;
    for (const req of requires) {
      // Check boolean capability keys (gpu, ffmpeg, docker, etc.)
      if (req in caps && (caps as Record<string, unknown>)[req] === true) continue;
      // Check custom tags
      if (caps.tags?.includes(req)) continue;
      return false;
    }
    return true;
  }

  /** Find the best machine for a task with required capabilities. Returns machineId or undefined. */
  findCapableMachine(requires: string[], preferMachine?: string): string | undefined {
    // Check preferred machine first
    if (preferMachine) {
      if (this.machineHasCapabilities(preferMachine, requires)) {
        const sat = this.satellites.get(preferMachine);
        if (sat && sat.workers.some(w => w.status === "idle")) return preferMachine;
      }
    }
    // Check all satellites
    for (const sat of this.satellites.values()) {
      if (this.machineHasCapabilities(sat.machineId, requires)) {
        if (sat.workers.some(w => w.status === "idle")) return sat.machineId;
      }
    }
    return undefined;
  }

  /** Get capabilities for all machines (local + satellites). */
  getAllCapabilities(): Record<string, MachineCapabilities> {
    const result: Record<string, MachineCapabilities> = {};
    // Local machine
    result["local"] = this.detectLocalCapabilities();
    // Satellites
    for (const sat of this.satellites.values()) {
      if (sat.capabilities) result[sat.machineId] = sat.capabilities;
    }
    return result;
  }

  /** Detect local machine capabilities (same logic as satellite but for primary). */
  private localCapabilities: MachineCapabilities | null = null;
  private detectLocalCapabilities(): MachineCapabilities {
    if (this.localCapabilities) return this.localCapabilities;
    const caps: MachineCapabilities = {
      platform: osPlatform(),
      arch: arch(),
      cpuCores: cpus().length,
      ramGb: Math.round(totalmem() / (1024 ** 3)),
      node: true,
      projects: scanLocalProjects(homedir()),
    };
    const check = (cmd: string, args: string[]): boolean => {
      try { execFileSync(cmd, args, { timeout: 3000, encoding: "utf-8", stdio: "pipe" }); return true; }
      catch { return false; }
    };
    try {
      if (osPlatform() === "darwin") {
        const sp = execFileSync("/usr/sbin/system_profiler", ["SPDisplaysDataType"], { timeout: 5000, encoding: "utf-8" });
        caps.gpu = true;
        const m = sp.match(/Chipset Model:\s*(.+)/i) || sp.match(/Chip:\s*(.+)/i);
        caps.gpuName = m?.[1]?.trim() || "Apple GPU";
      }
    } catch { caps.gpu = false; }
    caps.ffmpeg = check("ffmpeg", ["-version"]);
    caps.docker = check("docker", ["--version"]);
    caps.python = check("python3", ["--version"]);
    if (caps.python) {
      caps.pytorch = check("python3", ["-c", "import torch"]);
      caps.tensorflow = check("python3", ["-c", "import tensorflow"]);
    }
    try {
      const capFile = join(homedir(), ".hive", "capabilities.json");
      if (existsSync(capFile)) {
        const custom = JSON.parse(readFileSync(capFile, "utf-8"));
        if (custom.tags) caps.tags = custom.tags;
      }
    } catch { /* skip */ }
    this.localCapabilities = caps;
    return caps;
  }

  /** Broadcast connected machines list to all dashboard clients. */
  private broadcastMachines(): void {
    const machines = this.getConnectedMachines();
    this.broadcast({ type: "machines", machines });
  }

  private getCurrentPrimaryWsUrl(): string | null {
    try {
      if (!existsSync(TUNNEL_FILE)) return null;
      const raw = readFileSync(TUNNEL_FILE, "utf-8");
      const httpsUrl = raw.match(/https:\/\/[^\s]+/)?.[0] || raw.trim();
      if (!httpsUrl.startsWith("https://")) return null;
      return httpsUrl.replace("https://", "wss://");
    } catch {
      return null;
    }
  }

  private broadcastPrimaryUrlIfChanged(): void {
    const primaryUrl = this.getCurrentPrimaryWsUrl();
    if (!primaryUrl || primaryUrl === this.lastBroadcastPrimaryUrl) return;
    this.lastBroadcastPrimaryUrl = primaryUrl;
    for (const sat of this.satellites.values()) {
      this.sendToSatellite(sat, {
        type: "satellite_primary_url",
        primaryUrl,
      });
    }
  }

  /** Forward a command to a satellite. */
  private sendToSatellite(sat: SatelliteConnection, msg: Record<string, unknown>): void {
    if (sat.ws.readyState === WebSocket.OPEN) {
      sat.ws.send(JSON.stringify(msg));
    }
  }

  /** Request worker context from a satellite. Returns the context or null on timeout. */
  private requestSatelliteContext(
    sat: SatelliteConnection,
    workerId: string,
    localId: string,
    options: { includeHistory?: boolean; historyLimit?: number },
  ): Promise<unknown> {
    return new Promise((resolve) => {
      const requestId = `ctx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const timer = setTimeout(() => {
        this.pendingSatelliteRequests.delete(requestId);
        resolve(null);
      }, 10_000);
      this.pendingSatelliteRequests.set(requestId, { resolve, timer, machineId: sat.machineId });
      this.sendToSatellite(sat, {
        type: "satellite_context",
        requestId,
        workerId,
        localWorkerId: localId,
        includeHistory: options.includeHistory ?? false,
        historyLimit: options.historyLimit ?? 6,
      });
    });
  }

  private requestSatelliteCommand(
    sat: SatelliteConnection,
    requestId: string,
    msg: Record<string, unknown>,
    timeoutMs = 70_000,
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingSatelliteCommands.delete(requestId);
        resolve({
          ok: false,
          error: `Satellite command timed out after ${timeoutMs}ms`,
          exitCode: null,
          timedOut: true,
        });
      }, timeoutMs);
      this.pendingSatelliteCommands.set(requestId, { resolve, timer, machineId: sat.machineId });
      this.sendToSatellite(sat, msg);
    });
  }

  private recordControlPlaneAudit(entry: Parameters<typeof appendControlPlaneAudit>[0]): void {
    appendControlPlaneAudit(entry);
  }

  private async execViaControlPlane(request: {
    command: string;
    cwd?: string;
    timeoutMs?: number;
    machine?: string;
    fromMachine?: string;
  }): Promise<{
    ok: boolean;
    machine: string;
    command: string;
    cwd: string;
    stdout: string;
    stderr: string;
    exitCode: number | null;
    timedOut: boolean;
    durationMs: number;
    error?: string;
  }> {
    const targetMachine = request.machine && request.machine !== "local"
      ? request.machine
      : (request.fromMachine && request.fromMachine !== "local" ? request.fromMachine : "local");

    const resolved = targetMachine === "local" || request.cwd
      ? resolveExecCwd(
          request.cwd,
          (value) => this.resolveProjectForMachine(targetMachine, value),
          { validateExists: targetMachine === "local" },
        )
      : { cwd: undefined };
    if (!resolved.cwd && request.cwd) {
      const error = resolved.error || "Invalid working directory";
      const result = {
        ok: false,
        machine: targetMachine,
        command: request.command,
        cwd: request.cwd,
        stdout: "",
        stderr: "",
        exitCode: null,
        timedOut: false,
        durationMs: 0,
        error,
      };
      this.recordControlPlaneAudit({
        ts: Date.now(),
        type: "exec",
        sourceMachine: request.fromMachine,
        targetMachine,
        command: request.command,
        cwd: request.cwd,
        ok: false,
        error,
      });
      return result;
    }

    if (targetMachine !== "local") {
      const sat = this.satellites.get(targetMachine);
      if (!sat) {
        const error = `Machine "${targetMachine}" not connected`;
        const result = {
          ok: false,
          machine: targetMachine,
          command: request.command,
          cwd: resolved.cwd || request.cwd || "~",
          stdout: "",
          stderr: "",
          exitCode: null,
          timedOut: false,
          durationMs: 0,
          error,
        };
        this.recordControlPlaneAudit({
          ts: Date.now(),
          type: "exec",
          sourceMachine: request.fromMachine,
          targetMachine,
          command: request.command,
          cwd: resolved.cwd || request.cwd,
          ok: false,
          error,
        });
        return result;
      }

      const requestId = `exec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const execTimeoutMs = normalizeExecTimeout(request.timeoutMs);
      const response = await this.requestSatelliteCommand(sat, requestId, {
        type: "satellite_exec",
        requestId,
        command: request.command,
        cwd: resolved.cwd,
        timeoutMs: execTimeoutMs,
      }, execTimeoutMs + 5_000);
      const result = {
        ok: response.ok === true,
        machine: targetMachine,
        command: request.command,
        cwd: (response.cwd as string) || resolved.cwd || "~",
        stdout: (response.stdout as string) || "",
        stderr: (response.stderr as string) || "",
        exitCode: typeof response.exitCode === "number" ? response.exitCode as number : null,
        timedOut: response.timedOut === true,
        durationMs: typeof response.durationMs === "number" ? response.durationMs as number : 0,
        ...(typeof response.error === "string" ? { error: response.error as string } : {}),
      };
      this.recordControlPlaneAudit({
        ts: Date.now(),
        type: "exec",
        sourceMachine: request.fromMachine,
        targetMachine,
        command: request.command,
        cwd: result.cwd,
        ok: result.ok,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
        ...(result.error ? { error: result.error } : {}),
      });
      return result;
    }

    const result = await runShellExec({
      command: request.command,
      cwd: resolved.cwd,
      timeoutMs: request.timeoutMs,
    });
    const response = {
      ...result,
      machine: "local",
    };
    this.recordControlPlaneAudit({
      ts: Date.now(),
      type: "exec",
      sourceMachine: request.fromMachine,
      targetMachine: "local",
      command: request.command,
      cwd: response.cwd,
      ok: response.ok,
      exitCode: response.exitCode,
      timedOut: response.timedOut,
      durationMs: response.durationMs,
      ...(response.error ? { error: response.error } : {}),
    });
    return response;
  }

  /** Handle messages from a satellite connection. */
  private handleSatelliteMessage(ws: WebSocket, machineId: string, msg: Record<string, unknown>): void {
    const activeSat = this.satellites.get(machineId);
    if (msg.type !== "satellite_hello" && activeSat?.ws && activeSat.ws !== ws) {
      if (msg.type !== "satellite_workers" && msg.type !== "satellite_heartbeat") {
        console.log(`[satellite] Ignoring ${msg.type} from inactive socket for "${machineId}"`);
      }
      return;
    }
    if (msg.type !== "satellite_workers" && msg.type !== "satellite_heartbeat") {
      console.log(`[satellite] Message from "${machineId}": ${msg.type}`);
    }
    switch (msg.type) {
      case "satellite_hello": {
        const caps = msg.capabilities as MachineCapabilities | undefined;
        const satVersion = (msg.version as string) || "unknown";
        const existing = this.satellites.get(machineId);
        const sat: SatelliteConnection = existing?.ws === ws
          ? existing
          : {
              ws,
              machineId,
              hostname: (msg.hostname as string) || machineId,
              workers: existing?.workers || [],
              connectedAt: Date.now(),
              lastSeen: Date.now(),
              capabilities: caps,
              version: satVersion,
            };
        sat.ws = ws;
        sat.hostname = (msg.hostname as string) || machineId;
        sat.connectedAt = Date.now();
        sat.lastSeen = Date.now();
        sat.capabilities = caps;
        sat.version = satVersion;
        this.satellites.set(machineId, sat);
        const capSummary = caps ? Object.entries(caps).filter(([, v]) => v === true).map(([k]) => k).join(", ") : "none";
        console.log(`[satellite] "${machineId}" registered (hostname: ${sat.hostname}, version: ${satVersion}, capabilities: ${capSummary})`);

        const pendingWorkers = this.pendingSatelliteWorkers.get(machineId);
        if (pendingWorkers) {
          this.pendingSatelliteWorkers.delete(machineId);
          console.log(`[satellite] Applying buffered workers for "${machineId}" (${pendingWorkers.length})`);
          this.applySatelliteWorkers(machineId, sat, pendingWorkers);
        }

        // Auto-update: if satellite is running stale code, tell it to pull + restart.
        // The satellite handles satellite_update by running git pull --ff-only then
        // process.exit(0)  --  its process supervisor restarts it with fresh code.
        const primaryVersion = getLocalVersion();
        if (satVersion !== "unknown" && primaryVersion !== "unknown" && satVersion !== primaryVersion) {
          console.log(`[satellite] "${machineId}" version mismatch: satellite=${satVersion} primary=${primaryVersion}  --  sending auto-update`);
          this.sendToSatellite(sat, {
            type: "satellite_update",
            requestId: `autoupdate_${Date.now()}`,
          });
        }

        // Notify dashboard clients about the new satellite
        this.broadcastMachines();
        const primaryUrl = this.getCurrentPrimaryWsUrl();
        if (primaryUrl) {
          this.sendToSatellite(sat, {
            type: "satellite_primary_url",
            primaryUrl,
          });
        }
        break;
      }

      case "satellite_workers": {
        const incoming = ((msg.workers as WorkerState[]) || []).map((worker) => ({ ...worker }));
        const sat = this.satellites.get(machineId);
        if (!sat) {
          this.pendingSatelliteWorkers.set(machineId, incoming);
          console.log(`[satellite] Buffering workers for "${machineId}" until hello arrives (${incoming.length})`);
          return;
        }
        this.applySatelliteWorkers(machineId, sat, incoming);
        break;
      }

      case "satellite_heartbeat": {
        const sat = this.satellites.get(machineId);
        if (!sat) break;
        sat.lastSeen = Date.now();
        this.sendToSatellite(sat, {
          type: "satellite_heartbeat_ack",
          ts: typeof msg.ts === "number" ? msg.ts : Date.now(),
        });
        break;
      }

      case "satellite_chat": {
        // Forward chat data to dashboard clients subscribed to this satellite worker
        const workerId = msg.workerId as string;
        if (!workerId) return;

        const subscribers = this.satelliteChatClients.get(workerId);
        if (!subscribers) return;

        const data: DaemonResponse = {
          type: "chat_history",
          workerId,
          messages: msg.messages as ChatEntry[],
          ...(msg.full ? { full: true } : {}),
        };
        const json = JSON.stringify(data);
        for (const client of subscribers) {
          if (client.readyState === WebSocket.OPEN) {
            client.send(json);
          }
        }
        break;
      }

      case "satellite_result": {
        const requestId = msg.requestId as string | undefined;
        if (requestId) {
          const pending = this.pendingSatelliteCommands.get(requestId);
          if (pending) {
            clearTimeout(pending.timer);
            this.pendingSatelliteCommands.delete(requestId);
            pending.resolve(msg);
            break;
          }
        }
        // Command results  --  currently fire-and-forget, logged for debugging
        if (!(msg as Record<string, unknown>).ok) {
          console.log(`[satellite] Command failed on "${machineId}": ${msg.error || "unknown"}`);
        }
        break;
      }

      case "satellite_api_request": {
        // Satellite is relaying an API call from one of its local agents.
        // Execute it against the primary's API and send back the response.
        const requestId = msg.requestId as string;
        const method = (msg.method as string || "GET").toUpperCase();
        const path = msg.path as string || "";
        const body = msg.body as Record<string, unknown> | undefined;
        const sat = this.satellites.get(machineId);
        if (!sat) break;

        try {
          const result = this.handleApiRelay(method, path, body, machineId);
          // handleApiRelay may return a Promise for satellite context queries
          Promise.resolve(result).then(
            (data) => this.sendToSatellite(sat, { type: "satellite_api_response", requestId, data }),
            (err) => this.sendToSatellite(sat, { type: "satellite_api_response", requestId, data: { error: err instanceof Error ? err.message : "Unknown error" } }),
          );
        } catch (err) {
          this.sendToSatellite(sat, { type: "satellite_api_response", requestId, data: { error: err instanceof Error ? err.message : "Unknown error" } });
        }
        break;
      }

      case "satellite_context_response": {
        // Satellite responded to a context query from requestSatelliteContext()
        const ctxReqId = msg.requestId as string;
        const pending = this.pendingSatelliteRequests.get(ctxReqId);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingSatelliteRequests.delete(ctxReqId);
          const context = (msg.context ?? msg) as Record<string, unknown>;
          const chatHistory = Array.isArray(msg.chatHistory) ? msg.chatHistory as ChatEntry[] : [];
          if (context && typeof context === "object" && chatHistory.length > 0) {
            pending.resolve({
              ...context,
              recentMessages: chatHistory,
            });
          } else {
            pending.resolve(context);
          }
        }
        break;
      }
    }
  }

  private applySatelliteWorkers(machineId: string, sat: SatelliteConnection, incoming: WorkerState[]): void {
    sat.lastSeen = Date.now();
    const prevCount = sat.workers.length;

    // Apply overrides: after dashboard approves/selects a satellite worker,
    // suppress stale promptType from the satellite for a cooldown period.
    // But if the satellite reports the worker is actually working (no prompt),
    // respect that  --  the agent has moved past the prompt.
    const now = Date.now();
    for (const w of incoming) {
      const key = `${machineId}:${w.id}`;
      const override = this.satelliteOverrides.get(key);
      if (override) {
        if (now >= override.until) {
          // Expired
          this.satelliteOverrides.delete(key);
        } else if (w.status === "working" && !w.promptType) {
          // Agent moved past the prompt and is working  --  clear override
          this.satelliteOverrides.delete(key);
        } else if (w.status === "idle") {
          // Agent finished its work  --  clear override, let idle through
          this.satelliteOverrides.delete(key);
        } else {
          w.promptType = null;
          w.promptMessage = undefined;
          w.status = override.status as WorkerState["status"];
          w.currentAction = override.currentAction;
          w.lastAction = override.lastAction;
        }
      }
    }

    // Satellite status smoothing: apply hysteresis to prevent dashboard flapping.
    // The satellite reports raw status every 3s. Without smoothing, intermediate
    // states between the satellite's own hysteresis checks leak through, causing
    // single-report working→idle flicker on the dashboard.
    for (const w of incoming) {
      const key = `${machineId}:${w.id}`;
      if (w.status === "working") {
        this.satelliteIdleCounts.set(key, 0);
      } else if (w.status === "idle") {
        const idleCount = (this.satelliteIdleCounts.get(key) || 0) + 1;
        this.satelliteIdleCounts.set(key, idleCount);
        const definitiveIdle =
          w.lastAction === "Session ended" ||
          w.lastAction === "Waiting for input";
        if (!definitiveIdle && idleCount < WsServer.SAT_IDLE_HYSTERESIS) {
          w.status = "working";
          w.currentAction = w.currentAction || "Thinking...";
        }
      }
    }

    // Task durability: detect satellite workers that disappeared (died, terminal closed).
    // If they had a running task, re-queue it so another worker picks it up.
    const prevIds = new Set(sat.workers.map(w => w.id));
    const incomingIds = new Set(incoming.map(w => w.id));
    for (const prevId of prevIds) {
      if (!incomingIds.has(prevId)) {
        const prefixedId = `${machineId}:${prevId}`;
        const requeued = this.telemetry.requeueSatelliteTask(prefixedId);
        if (requeued) {
          console.log(`[satellite] Worker "${prefixedId}" died with task "${requeued.id}"  --  re-queued`);
        }
        const key = `${machineId}:${prevId}`;
        this.satelliteIdleCounts.delete(key);
        this.satelliteOverrides.delete(key);
      }
    }

    // Detect satellite status transitions and fire listeners (for notifications).
    // This runs AFTER overrides and smoothing, so it reflects final dashboard state.
    // Look up global quadrants from the merged worker list so notifications
    // say "Q4 done (MacBook-Air)" not "Q1 done (MacBook-Air)".
    const allWorkers = this.getAllWorkers();
    for (const w of incoming) {
      const key = `${machineId}:${w.id}`;
      const prev = this.satellitePrevStatus.get(key);
      if (prev && prev !== w.status) {
        // Find the global quadrant for this satellite worker
        const global = allWorkers.find(gw => gw.id === key);
        const prefixedWorker: WorkerState = {
          ...w,
          id: key,
          quadrant: global?.quadrant ?? w.quadrant,
          machine: machineId,
          machineLabel: sat.hostname,
        };
        for (const cb of this.satelliteStatusListeners) {
          try { cb(key, prefixedWorker, prev); } catch { /* non-critical */ }
        }
      }
      this.satellitePrevStatus.set(key, w.status);
    }

    sat.workers = incoming;
    if (sat.workers.length !== prevCount) {
      console.log(`[satellite] "${machineId}" workers: ${prevCount} → ${sat.workers.length}`);
    }
    this.lastWorkersSnapshot = null;
  }

  private registerSatelliteSocket(ws: WebSocket, machineId: string): void {
    const existingSat = this.satellites.get(machineId);
    if (existingSat && existingSat.ws !== ws) {
      existingSat.ws = ws;
      existingSat.lastSeen = Date.now();
    }
    for (const [existingWs, existingMachineId] of this.satelliteWs.entries()) {
      if (existingMachineId !== machineId || existingWs === ws) continue;
      console.log(`[satellite] Closing duplicate connection for "${machineId}"`);
      this.satelliteWs.delete(existingWs);
      existingWs.close();
    }
    this.satelliteWs.set(ws, machineId);
  }

  private handleSatelliteDisconnect(ws: WebSocket, machineId: string): void {
    console.log(`[satellite] "${machineId}" disconnected`);
    if (this.satelliteWs.get(ws) === machineId) {
      this.satelliteWs.delete(ws);
    }

    const active = this.satellites.get(machineId);
    if (active?.ws !== ws) return;

    this.satellites.delete(machineId);
    this.pendingSatelliteWorkers.delete(machineId);

    // Clean up pending requests/commands targeted at this satellite.
    // Without this, entries accumulate indefinitely (memory leak).
    for (const [id, entry] of this.pendingSatelliteRequests) {
      if (entry.machineId === machineId) {
        clearTimeout(entry.timer);
        entry.resolve(null);
        this.pendingSatelliteRequests.delete(id);
      }
    }
    for (const [id, entry] of this.pendingSatelliteCommands) {
      if (entry.machineId === machineId) {
        clearTimeout(entry.timer);
        entry.resolve({ ok: false, error: "Satellite disconnected" });
        this.pendingSatelliteCommands.delete(id);
      }
    }

    this.lastWorkersSnapshot = null;
    this.pushState();
    this.broadcastMachines();
  }

  /** Handle a relayed API request from a satellite.
   *  Executes the same logic as the primary's REST API.
   *  Full parity  --  every route the primary serves is available to satellites. */
  private handleApiRelay(method: string, path: string, body: Record<string, unknown> | undefined, fromMachine: string): unknown {
    // Parse path and query, also extract path params (e.g. /api/reviews/:id)
    const [basePath, queryStr] = path.split("?");
    const query = new URLSearchParams(queryStr || "");
    const segments = basePath.split("/").filter(Boolean); // ["api", "reviews", "abc123"]

    switch (segments[1]) { // switch on the resource name (workers, message, queue, etc.)

      case "workers":
        return this.getAllWorkers();

      case "message": {
        if (method === "POST") {
          if (!body?.workerId || !body?.content) return { error: "Missing workerId or content" };
          const workerId = body.workerId as string;
          const content = body.content as string;

          // Check if target is a satellite worker
          const msgSat = this.getSatelliteForWorker(workerId);
          if (msgSat) {
            const parsed = this.parseSatelliteWorker(workerId)!;
            this.sendToSatellite(msgSat, {
              type: "satellite_message",
              requestId: `relay_msg_${Date.now()}`,
              workerId,
              localWorkerId: parsed.localId,
              content,
            });
            return { ok: true, relayed: true };
          }

          // Local worker
          return this.telemetry.sendToWorker(workerId, content, {
            source: `satellite:${fromMachine}`,
            queueIfBusy: false,
            markDashboardInput: false,
          });
        }
        return { error: "Method not supported" };
      }

      case "context": {
        const workerId = query.get("workerId") || "";
        const workerIds = query.get("workerIds")?.split(",").map(s => s.trim()).filter(Boolean);
        const history = query.get("history") === "1" || query.get("history") === "true";
        const historyLimit = Number(query.get("historyLimit") || 6);
        const options = {
          includeHistory: history,
          historyLimit: Number.isFinite(historyLimit) ? Math.max(1, Math.min(12, historyLimit)) : 6,
        };
        if (workerId) {
          // For satellite workers, use async relay (returns a promise)
          if (workerId.includes(":")) {
            return this.telemetry.getWorkerContextAsync(workerId, options);
          }
          return this.telemetry.getWorkerContext(workerId, options) || { error: `Worker ${workerId} not found` };
        }
        return this.telemetry.getWorkerContexts({
          ...options,
          ...(workerIds ? { workerIds } : {}),
        });
      }

      case "message-queue": {
        if (method === "DELETE" && segments[2]) {
          const cancelled = this.telemetry.cancelMessage(segments[2]);
          return cancelled ? { ok: true, cancelled: segments[2] } : { error: `Message ${segments[2]} not found` };
        }
        return this.telemetry.getMessageQueueDetails();
      }

      case "queue": {
        if (method === "POST") {
          if (!body?.task) return { error: "Missing task" };
          const queued = this.telemetry.pushTask(
            body.task as string,
            body.project as string | undefined,
            (body.priority as number) ?? 10,
            body.blockedBy as string | undefined,
            body.workflowId as string | undefined,
            body.verify as boolean | undefined,
            body.maxVerifyAttempts as number | undefined,
            body.autoCommit as boolean | undefined,
            body.requires as string[] | undefined,
            body.preferMachine as string | undefined,
            body.model as string | undefined,
          );
          return { ok: true, task: queued, remaining: this.telemetry.getTaskQueueLength() };
        }
        if (method === "DELETE" && segments[2]) {
          const removed = this.telemetry.removeTask(segments[2]);
          return removed ? { ok: true } : { error: `Task ${segments[2]} not found` };
        }
        // GET
        return this.telemetry.getTaskQueue();
      }

      case "scratchpad": {
        if (method === "POST" && body) {
          this.telemetry.setScratchpad(
            body.key as string,
            body.value as string,
            body.setBy as string || fromMachine,
          );
          return { ok: true };
        }
        if (method === "DELETE") {
          const delKey = query.get("key") || "";
          if (!delKey) return { error: "Missing key" };
          return { ok: true, deleted: this.telemetry.deleteScratchpad(delKey) };
        }
        // GET
        const key = query.get("key") || "";
        if (key) {
          return this.telemetry.getScratchpad(key) || null;
        }
        return this.telemetry.getAllScratchpad();
      }

      case "learning": {
        if (body?.project && body?.lesson) {
          this.telemetry.writeLearning(body.project as string, body.lesson as string);
          return { ok: true };
        }
        return { error: "Missing project or lesson" };
      }

      case "reviews": {
        const reviewId = segments[2]; // /api/reviews/:id
        if (method === "POST" && body?.summary) {
          this.telemetry.addReview(
            body.summary as string,
            fromMachine,
            "satellite",
            { url: body.url as string | undefined, type: body.type as "push" | "deploy" | "commit" | "pr" | "review-needed" | "general" | undefined },
          );
          return { ok: true };
        }
        if (method === "PATCH" && reviewId) {
          return { ok: this.telemetry.markReviewSeen(reviewId) };
        }
        if (method === "PATCH" && !reviewId) {
          return { ok: true, marked: this.telemetry.markAllReviewsSeen() };
        }
        if (method === "DELETE" && reviewId) {
          return this.telemetry.dismissReview(reviewId) ? { ok: true } : { error: `Review ${reviewId} not found` };
        }
        if (method === "DELETE" && !reviewId) {
          return { ok: true, cleared: this.telemetry.clearAllReviews() };
        }
        // GET
        const unseen = query.get("unseen") === "1" || query.get("unseen") === "true";
        return unseen ? this.telemetry.getUnseenReviews() : this.telemetry.getReviews();
      }

      case "artifacts": {
        const wid = query.get("workerId") || "";
        if (wid) return this.telemetry.getArtifacts(wid);
        // Return all artifacts
        const all: Record<string, Array<{ path: string; action: string; ts: number }>> = {};
        for (const w of this.telemetry.getAll()) {
          const arts = this.telemetry.getArtifacts(w.id);
          if (arts.length > 0) all[w.id] = arts;
        }
        return all;
      }

      case "locks": {
        if (method === "POST" && body) {
          return this.telemetry.acquireLock(body.path as string, body.workerId as string);
        }
        if (method === "DELETE") {
          const lockWorker = query.get("workerId") || body?.workerId as string || "";
          const lockPath = query.get("path") || body?.path as string || "";
          if (!lockWorker) return { error: "Missing workerId" };
          if (lockPath) {
            return { ok: true, released: this.telemetry.releaseLock(lockPath, lockWorker) };
          }
          return { ok: true, releasedCount: this.telemetry.releaseAllLocks(lockWorker) };
        }
        // GET
        return this.telemetry.getAllLocks();
      }

      case "conflicts": {
        const conflictPath = query.get("path") || "";
        const exclude = query.get("excludeWorker") || "";
        if (!conflictPath) return { error: "Missing path" };
        const conflicts = this.telemetry.checkConflicts(conflictPath, exclude);
        return { path: conflictPath, conflicts, hasConflict: conflicts.length > 0 };
      }

      case "audit":
        return this.discovery ? this.discovery.getAuditLog(query.get("tty") || undefined) : [];

      case "signals":
        return this.telemetry.getSignals(query.get("workerId") || undefined);

      case "debug":
        return this.discovery ? this.telemetry.getDebugState(this.discovery) : { error: "Discovery not initialized" };

      case "models":
        return this.getModels();

      case "spawn":
        if (method === "POST") {
          return this.spawnViaControlPlane({
            project: body?.project as string | undefined,
            model: body?.model as string | undefined,
            task: body?.task as string | undefined,
            targetQuadrant: body?.targetQuadrant as number | undefined,
            machine: body?.machine as string | undefined,
            fromMachine,
          });
        }
        return { error: "Method not supported" };

      case "kill":
        if (method === "POST" && body?.workerId) {
          return this.killViaControlPlane(body.workerId as string, fromMachine);
        }
        return { error: "Missing workerId" };

      case "satellites":
        if (method === "POST" && segments[2] === "repair" && body?.machine) {
          return this.maintainSatelliteViaControlPlane(body.machine as string, body.action as string | undefined, fromMachine);
        }
        return { error: "Missing machine" };

      case "exec":
        if (method === "POST" && body?.command) {
          return this.execViaControlPlane({
            command: body.command as string,
            cwd: body.cwd as string | undefined,
            timeoutMs: body.timeoutMs as number | undefined,
            machine: body.machine as string | undefined,
            fromMachine,
          });
        }
        return { error: "Missing command" };

      case "projects":
        return this.getProjects();

      case "capabilities":
        return this.getAllCapabilities();

      case "control-plane-audit":
        return {
          path: getControlPlaneAuditPath(),
          entries: readControlPlaneAudit(Number(query.get("limit") || 100)),
        };

      case "rearrange":
        if (method === "POST") {
          this.telemetry.forceRearrange();
          return { ok: true };
        }
        return { error: "Method not supported" };

      default:
        return { error: `Unknown API path: ${basePath}` };
    }
  }

  /** List available agent models (same logic as /api/models route). */
  private getModels(): unknown {
    const builtIn = [
      { id: "claude", label: "Claude" },
      { id: "codex", label: "Codex" },
      { id: "openclaw", label: "OpenClaw" },
    ];
    const custom = ProcessDiscovery.getCustomAgents().map((a: { id: string; label: string }) => ({
      id: a.id,
      label: a.label,
    }));
    return [...builtIn, ...custom];
  }

  /** List available projects across all machines.
   *  Scans common directories for git repos on the primary, then merges
   *  satellite-reported projects. Projects identified by name, resolved
   *  per-machine  --  "hive" maps to ~/factory/projects/hive on primary
   *  and ~/hive on the MacBook Air. Dashboard and task queue use names. */
  private getProjects(): unknown {
    // name → { machines: { machineId: path } }
    const projectMap = new Map<string, { name: string; machines: Record<string, string> }>();

    // Scan primary machine
    for (const [name, path] of Object.entries(scanLocalProjects(homedir()))) {
      if (!projectMap.has(name)) {
        projectMap.set(name, { name, machines: { local: path } });
      }
    }

    // Merge satellite projects (from capabilities.projects)
    for (const [machineId, sat] of this.satellites) {
      const satProjects = sat.capabilities?.projects;
      if (!satProjects) continue;
      for (const [name, path] of Object.entries(satProjects)) {
        const existing = projectMap.get(name);
        if (existing) {
          existing.machines[machineId] = path;
        } else {
          projectMap.set(name, { name, machines: { [machineId]: path } });
        }
      }
    }

    const projects = Array.from(projectMap.values()).map(p => ({
      name: p.name,
      // Primary path for backward compat (dashboard spawn dialog)
      path: p.machines["local"] || Object.values(p.machines)[0] || "",
      machines: p.machines,
    }));
    return { projects };
  }

  private maintainSatelliteViaControlPlane(
    machineId: string,
    action?: string,
    fromMachine?: string,
  ): { ok: boolean; error?: string; [key: string]: unknown } {
    const sat = this.satellites.get(machineId);
    if (!sat) {
      const error = `Machine "${machineId}" not connected`;
      this.recordControlPlaneAudit({
        ts: Date.now(),
        type: "maintenance",
        sourceMachine: fromMachine,
        targetMachine: machineId,
        action,
        ok: false,
        error,
      });
      return { ok: false, error };
    }

    const normalizedAction = action === "update" || action === "repair" || action === "reinstall"
      ? action
      : (sat.version === "unknown" || !sat.capabilities?.projects ? "update" : "repair");

    if (normalizedAction === "update") {
      this.sendToSatellite(sat, {
        type: "satellite_update",
        requestId: `maint_${Date.now()}`,
        fromMachine,
      });
    } else {
      this.sendToSatellite(sat, {
        type: "satellite_maintenance",
        requestId: `maint_${Date.now()}`,
        action: normalizedAction,
        fromMachine,
      });
    }

    this.recordControlPlaneAudit({
      ts: Date.now(),
      type: "maintenance",
      sourceMachine: fromMachine,
      targetMachine: machineId,
      action: normalizedAction,
      ok: true,
    });
    return { ok: true, machine: machineId, action: normalizedAction };
  }

  private resolveProjectForMachine(machineId: string | undefined, project?: string): string {
    if (!project || project === "~") return "~";
    const targetMachine = machineId && machineId !== "local" ? machineId : "local";
    const projectName = project.split("/").pop() || project;
    const catalog = this.getProjects() as { projects: Array<{ name: string; path: string; machines?: Record<string, string> }> };
    const entry = catalog.projects.find((candidate) =>
      candidate.name === project
      || candidate.name === projectName
      || candidate.path === project
      || Object.values(candidate.machines || {}).includes(project)
    );
    return entry?.machines?.[targetMachine] || entry?.path || project;
  }

  private spawnViaControlPlane(request: {
    project?: string;
    model?: string;
    task?: string;
    targetQuadrant?: number;
    machine?: string;
    fromMachine?: string;
  }): { ok: boolean; error?: string; model?: string; project?: string; machine?: string } {
    const targetMachine = request.machine && request.machine !== "local"
      ? request.machine
      : (request.fromMachine && request.fromMachine !== "local" ? request.fromMachine : undefined);

    if (targetMachine) {
      const targetSat = this.satellites.get(targetMachine);
      if (!targetSat) {
        this.recordControlPlaneAudit({
          ts: Date.now(),
          type: "spawn",
          sourceMachine: request.fromMachine,
          targetMachine,
          cwd: request.project,
          ok: false,
          error: `Machine "${targetMachine}" not connected`,
        });
        return { ok: false, error: `Machine "${targetMachine}" not connected` };
      }
      const satProject = this.resolveProjectForMachine(targetMachine, request.project);
      this.sendToSatellite(targetSat, {
        type: "satellite_spawn",
        requestId: `spawn_${Date.now()}`,
        project: satProject,
        model: request.model || "claude",
        initialMessage: request.task?.trim() || undefined,
        targetQuadrant: request.targetQuadrant,
      });
      console.log(`Spawn routed to satellite "${targetMachine}" project="${satProject}" (model=${request.model || "claude"})`);
      this.recordControlPlaneAudit({
        ts: Date.now(),
        type: "spawn",
        sourceMachine: request.fromMachine,
        targetMachine,
        cwd: satProject,
        action: request.model || "claude",
        ok: true,
      });
      return { ok: true, model: request.model || "claude", project: satProject, machine: targetMachine };
    }

    const home = homedir();
    let real: string;
    if (!request.project || request.project === "~") {
      real = home;
    } else {
      const projectPath = request.project.startsWith("~/")
        ? request.project.replace("~", home)
        : request.project;
      try {
        real = realpathSync(projectPath);
      } catch {
        return { ok: false, error: "Invalid project path" };
      }
      if (!real.startsWith(home + "/") && real !== home) {
        return { ok: false, error: "Invalid project path" };
      }
    }

    const model = request.model || "claude";
    const currentCount = this.telemetry.getAll().length;
    if (currentCount >= 8) {
      return { ok: false, error: "All 8 slots are occupied" };
    }
    const requestedQ = typeof request.targetQuadrant === "number" && request.targetQuadrant >= 1 && request.targetQuadrant <= 8
      ? request.targetQuadrant
      : undefined;
    const openQ = requestedQ ?? this.telemetry.getFirstOpenQuadrant();
    const initMessage = request.task?.trim() || undefined;
    const termResult = this.windows
      ? this.windows.spawnTerminal(real, model, openQ, initMessage, this.telemetry.getAll().length)
      : spawnTerminalWindow(real, model, openQ, initMessage, this.telemetry.getAll().length);
    if (!termResult.ok) {
      return { ok: false, error: termResult.error || "Failed to spawn terminal" };
    }
    if (termResult.tty) {
      this.telemetry.markSpawn(termResult.tty);
      const spawnTty = termResult.tty;
      const projectName = real.split("/").pop() || real;
      const placeholderId = `spawning_${spawnTty.replace("/dev/", "").replace(/\//g, "_")}`;
      const isClaude = model === "claude";
      this.telemetry.registerDiscovered(placeholderId, {
        id: placeholderId,
        pid: 0,
        project: real,
        projectName,
        status: "waiting" as const,
        currentAction: isClaude ? "Trust this project folder?" : "Starting...",
        lastAction: "Spawning terminal",
        lastActionAt: Date.now(),
        errorCount: 0,
        startedAt: Date.now(),
        task: null,
        managed: false,
        tty: spawnTty,
        model,
        terminalPreview: undefined,
        promptType: isClaude ? "trust" : null,
        promptMessage: isClaude ? "Trust this project folder?" : undefined,
      });
    }
    console.log(`Spawned ${model} terminal for ${real} (tty=${termResult.tty})`);
    this.recordControlPlaneAudit({
      ts: Date.now(),
      type: "spawn",
      sourceMachine: request.fromMachine,
      targetMachine: "local",
      cwd: real,
      action: model,
      ok: true,
    });
    return { ok: true, model, project: real, machine: "local" };
  }

  private killViaControlPlane(workerId: string, fromMachine?: string): { ok: boolean; error?: string; workerId?: string } {
    const killSat = this.getSatelliteForWorker(workerId);
    if (killSat) {
      const parsed = this.parseSatelliteWorker(workerId);
      if (!parsed) {
        const error = `Worker ${workerId} not found`;
        this.recordControlPlaneAudit({
          ts: Date.now(),
          type: "kill",
          sourceMachine: fromMachine,
          targetMachine: "unknown",
          workerId,
          ok: false,
          error,
        });
        return { ok: false, error };
      }
      this.sendToSatellite(killSat, {
        type: "satellite_kill",
        requestId: `kill_${Date.now()}`,
        workerId,
        localWorkerId: parsed.localId,
      });
      killSat.workers = killSat.workers.filter(w => w.id !== parsed.localId);
      this.lastWorkersSnapshot = null;
      console.log(`Killed satellite worker ${workerId}`);
      this.recordControlPlaneAudit({
        ts: Date.now(),
        type: "kill",
        sourceMachine: fromMachine,
        targetMachine: killSat.machineId,
        workerId,
        ok: true,
      });
      return { ok: true, workerId };
    }

    const worker = this.telemetry.get(workerId);
    if (!worker) {
      const error = `Worker ${workerId} not found`;
      this.recordControlPlaneAudit({
        ts: Date.now(),
        type: "kill",
        sourceMachine: fromMachine,
        targetMachine: "local",
        workerId,
        ok: false,
        error,
      });
      return { ok: false, error };
    }
    const killPid = worker.pid;
    const killTty = worker.tty;

    this.procMgr.kill(workerId);
    if (killPid) {
      try { process.kill(killPid, "SIGKILL"); } catch { /* already gone */ }
    }
    this.telemetry.removeWorker(workerId);

    if (killTty) {
      const ttyName = killTty.replace("/dev/", "");
      const markerPath = join(homedir(), ".hive", "sessions", ttyName);
      try { unlinkSync(markerPath); } catch { /* already gone */ }
      setTimeout(() => {
        const result = this.windows
          ? this.windows.closeTerminal(killTty)
          : closeTerminalWindow(killTty);
        if (!result.ok) {
          console.log(`[kill] Failed to close terminal ${killTty}: ${result.error}`);
        }
      }, 500);
    }

    console.log(`Killed worker ${workerId} (pid=${killPid}, tty=${killTty})`);
    this.recordControlPlaneAudit({
      ts: Date.now(),
      type: "kill",
      sourceMachine: fromMachine,
      targetMachine: worker.machine || "local",
      workerId,
      ok: true,
    });
    return { ok: true, workerId };
  }

  /** Push full worker list to all clients. Call from the main tick loop
   *  so the dashboard stays current even when status changes come from
   *  discovery (JSONL/CPU analysis) instead of hooks. */
  pushState(): void {
    this.broadcastPrimaryUrlIfChanged();
    // Expire stale satellites: if no satellite_workers received in 30s,
    // the machine is likely asleep or disconnected. Remove it so tiles
    // disappear promptly instead of ghosting until the TCP close fires.
    const now = Date.now();
    for (const [id, sat] of this.satellites) {
      if (now - sat.lastSeen > 30_000) {
        console.log(`[satellite] "${id}" stale (no report in ${Math.round((now - sat.lastSeen) / 1000)}s)  --  removing`);
        // Clean up hysteresis state for this satellite's workers
        for (const w of sat.workers) {
          const key = `${id}:${w.id}`;
          this.satelliteIdleCounts.delete(key);
          this.satelliteOverrides.delete(key);
        }
        sat.ws.close();
        this.satellites.delete(id);
        this.satelliteWs.delete(sat.ws);
        this.pendingSatelliteWorkers.delete(id);
        this.lastWorkersSnapshot = null;
        this.broadcastMachines();
      }
    }

    // Satellite auto-pilot: auto-approve stuck satellite workers.
    // The primary's AutoPilot only handles local workers (telemetry.getAll()).
    // Satellite workers report stuck status via satellite_workers  --  the primary
    // must forward the approval back via satellite_selection.
    for (const [machineId, sat] of this.satellites) {
      for (const w of sat.workers) {
        if (w.status !== "stuck") continue;
        const key = `sat_autopilot_${machineId}:${w.id}_${w.lastActionAt || 0}`;
        if (this.satelliteAutoApproved.has(key)) continue;

        // Grace period: first time seeing this stuck → start timer
        if (!this.satelliteStuckFirstSeen.has(key)) {
          this.satelliteStuckFirstSeen.set(key, now);
          continue;
        }
        const waited = now - this.satelliteStuckFirstSeen.get(key)!;
        if (waited < 3_000) continue; // 3s grace for human intervention

        // Grace expired  --  auto-approve via satellite_selection (option 0 = first option)
        const parsed = this.parseSatelliteWorker(`${machineId}:${w.id}`);
        if (parsed) {
          this.sendToSatellite(sat, {
            type: "satellite_selection",
            requestId: `autopilot_${Date.now()}`,
            workerId: `${machineId}:${w.id}`,
            localWorkerId: parsed.localId,
            optionIndex: 0,
          });
          this.satelliteAutoApproved.add(key);
          this.satelliteStuckFirstSeen.delete(key);
          // Apply override so dashboard shows working immediately
          const overrideKey = `${machineId}:${w.id}`;
          this.satelliteOverrides.set(overrideKey, {
            until: now + 15_000,
            status: "working",
            currentAction: "Thinking...",
            lastAction: "Auto-approved from primary",
          });
          console.log(`[satellite-autopilot] Auto-approved stuck worker "${machineId}:${w.id}" after ${Math.round(waited / 1000)}s`);
        }
      }
    }
    // Prune old satellite auto-pilot state
    if (this.satelliteAutoApproved.size > 200) {
      const arr = Array.from(this.satelliteAutoApproved);
      this.satelliteAutoApproved = new Set(arr.slice(arr.length - 50));
    }
    for (const [k, ts] of this.satelliteStuckFirstSeen) {
      if (now - ts > 60_000) this.satelliteStuckFirstSeen.delete(k);
    }

    const workers = this.getAllWorkers();
    const snapshot = JSON.stringify(workers);
    if (snapshot !== this.lastWorkersSnapshot) {
      this.lastWorkersSnapshot = snapshot;
      if (this.clients.size > 0) {
        this.broadcast({ type: "workers", workers });
      }
      // Broadcast formatted worker slots to all satellites so their identity hooks
      // show cross-machine peers. Build slot format matching workers.json structure.
      if (this.satellites.size > 0) {
        const localWorkers = this.telemetry.getAll();
        const peerSlots: Array<Record<string, unknown>> = [];
        let slot = 1;
        for (const w of localWorkers) {
          peerSlots.push({
            quadrant: w.quadrant || slot++,
            id: w.id, tty: w.tty, project: w.project,
            projectName: w.projectName, status: w.status,
            currentAction: w.currentAction, lastAction: w.lastAction,
            startedAt: w.startedAt, model: w.model || "claude",
            machine: "local", machineLabel: LOCAL_MACHINE_LABEL,
          });
        }
        // Also include satellite workers from OTHER satellites
        let satSlot = peerSlots.length + 1;
        for (const sat of this.satellites.values()) {
          for (const w of sat.workers) {
            peerSlots.push({
              quadrant: satSlot++,
              id: `${sat.machineId}:${w.id}`, tty: w.tty,
              project: w.project, projectName: w.projectName,
              status: w.status, currentAction: w.currentAction,
              lastAction: w.lastAction, startedAt: w.startedAt,
              model: w.model || "claude", machine: sat.machineId, machineLabel: sat.hostname,
            });
          }
        }
        const allWorkersMsg = JSON.stringify({ type: "satellite_all_workers", workers: peerSlots });
        for (const sat of this.satellites.values()) {
          if (sat.ws.readyState === WebSocket.OPEN) {
            sat.ws.send(allWorkersMsg);
          }
        }
      }
    }
    // Push satellite worker slots to telemetry for inclusion in workers.json
    // so the primary's identity hook shows cross-machine peers.
    if (this.satellites.size > 0) {
      const satSlots: Array<{ quadrant: number; id: string; pid: number; tty?: string; project: string; projectName: string; status: string; currentAction: string | null; lastAction: string; startedAt: number; model: string; machine?: string; machineLabel?: string }> = [];
      // Start satellite slots after the highest local quadrant (no gaps)
      const localWorkers = this.telemetry.getAll();
      const maxLocalSlot = localWorkers.reduce((max, w) => Math.max(max, w.quadrant || 0), 0);
      let nextSatSlot = Math.max(maxLocalSlot + 1, localWorkers.length + 1);
      for (const sat of this.satellites.values()) {
        for (const w of sat.workers) {
          satSlots.push({
            quadrant: nextSatSlot++,
            id: `${sat.machineId}:${w.id}`,
            pid: w.pid,
            tty: w.tty,
            project: w.project,
            projectName: w.projectName,
            status: w.status,
            currentAction: w.currentAction,
            lastAction: w.lastAction,
            startedAt: w.startedAt,
            model: w.model || "claude",
            machine: sat.machineId,
            machineLabel: sat.hostname,
          });
        }
      }
      this.telemetry.setSatelliteSlots(satSlots);
    } else {
      this.telemetry.setSatelliteSlots([]);
    }

    // Check if available models changed (custom agents added/removed)
    const models = this.getAvailableModels();
    const modelsSnapshot = JSON.stringify(models);
    if (modelsSnapshot !== this.lastModelsSnapshot) {
      this.lastModelsSnapshot = modelsSnapshot;
      const data = JSON.stringify({ type: "models", models });
      for (const client of this.clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(data);
        }
      }
    }

    // Check if connected machines changed (worker counts update)
    const machinesData = this.getConnectedMachines();
    const machinesSnapshot = JSON.stringify(machinesData);
    if (machinesSnapshot !== this.lastMachinesSnapshot) {
      this.lastMachinesSnapshot = machinesSnapshot;
      this.broadcast({ type: "machines", machines: machinesData });
    }
  }

  start(): void {
    this.wss = new WebSocketServer({ port: this.port, host: "127.0.0.1" });

    console.log(`  WebSocket server listening on 127.0.0.1:${this.port}`);

    this.wss.on("connection", (ws, req) => {
      const reqUrl = new URL(req.url || "/", "http://localhost");
      const candidate = reqUrl.searchParams.get("token") || "";
      const satelliteId = reqUrl.searchParams.get("satellite") || "";
      let user = candidate ? this.userRegistry.authenticate(candidate) : null;
      if (!user && candidate && validateToken(candidate, this.token)) {
        user = createLegacyAdminUser(candidate);
      }

      if (!user) {
        this.send(ws, { type: "error", error: "Unauthorized" });
        ws.close();
        return;
      }

      const isAdmin = user.role === "admin";
      const isViewer = user.role === "viewer";

      // Redact token from log to avoid leaking credentials in log files
      const safeUrl = (req.url || "").replace(/token=[^&]+/, "token=***");
      console.log(`[ws] New connection: satellite=${satelliteId || "none"} user=${user.name} role=${user.role} admin=${isAdmin} url=${safeUrl.slice(0, 80)}`);

      // ── Satellite connection ──────────────────────────────────
      if (satelliteId) {
        if (!isAdmin) {
          this.send(ws, { type: "error", error: "Admin token required for satellite" });
          ws.close();
          return;
        }
        console.log(`[satellite] "${satelliteId}" connected`);
        this.registerSatelliteSocket(ws, satelliteId);

        ws.on("message", (raw) => {
          try {
            const msg = JSON.parse(raw.toString());
            this.handleSatelliteMessage(ws, satelliteId, msg);
          } catch { /* malformed */ }
        });

        ws.on("close", () => this.handleSatelliteDisconnect(ws, satelliteId));

        ws.on("error", () => ws.close());
        return;
      }

      // ── Dashboard / viewer connection ─────────────────────────
      this.clients.add(ws);
      if (isViewer) this.readOnlyClients.add(ws);
      this.connectedUsers.set(ws, user);
      this.broadcastPresence();
      this.broadcastActivity(user, "connected");
      // Send current workers list (local + satellite merged)
      const workers = this.getAllWorkers();
      this.lastWorkersSnapshot = JSON.stringify(workers);
      this.send(ws, { type: "workers", workers });
      this.send(ws, { type: "auth", admin: isAdmin, role: user.role });
      // Send full review list on connect (hosted dashboard can't reach REST on port 3001)
      this.send(ws, { type: "reviews", reviews: this.telemetry.getReviews() });
      // Send available agent models for spawn dialog
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "models", models: this.getAvailableModels() }));
      }
      // Send connected satellite machines for spawn dialog machine picker
      this.send(ws, { type: "machines", machines: this.getConnectedMachines() });
      // Send registered devices
      if (this.deviceLayer) {
        this.send(ws, { type: "devices", devices: this.deviceLayer.registry.getAll() });
      }
      // Send VAPID public key for Web Push subscription
      if (this.pushMgr) {
        this.send(ws, { type: "vapid_key", vapidKey: this.pushMgr.getPublicKey() });
      }
      // Share current presence snapshot
      this.send(ws, { type: "presence", users: this.getPresenceSnapshot() });

      ws.on("message", (raw) => {
        let msg: DaemonMessage;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          this.send(ws, { type: "error", error: "Invalid JSON" });
          return;
        }
        this.handleMessage(ws, msg);
      });

      ws.on("close", () => {
        this.cleanupClient(ws);
      });

      ws.on("error", () => {
        this.cleanupClient(ws);
      });
    });
  }

  private cleanupClient(ws: WebSocket): void {
    const subId = this.clientSubs.get(ws);
    if (subId) {
      this.streamer.unsubscribe(subId + "_" + this.clientId(ws));
      // Clean up satellite chat subscription
      const satClients = this.satelliteChatClients.get(subId);
      if (satClients) {
        satClients.delete(ws);
        if (satClients.size === 0) {
          this.satelliteChatClients.delete(subId);
          const sat = this.getSatelliteForWorker(subId);
          if (sat) {
            this.sendToSatellite(sat, { type: "satellite_unsubscribe", workerId: subId });
          }
        }
      }
      this.clientSubs.delete(ws);
    }
    const departedUser = this.connectedUsers.get(ws);
    if (departedUser) {
      this.connectedUsers.delete(ws);
      this.broadcastPresence();
      this.broadcastActivity(departedUser, "disconnected");
    }
    this.clients.delete(ws);
    this.readOnlyClients.delete(ws);
  }

  private clientId(ws: WebSocket): string {
    // Use object identity as a simple unique key
    return String((ws as unknown as { _socket?: { remotePort?: number } })._socket?.remotePort || Math.random());
  }

  private handleMessage(ws: WebSocket, msg: DaemonMessage): void {
    const activeUser = this.connectedUsers.get(ws);
    // Read-only viewers can only request the worker list or manage push subscriptions
    if (this.readOnlyClients.has(ws) && msg.type !== "list" && msg.type !== "push_subscribe" && msg.type !== "push_unsubscribe" && msg.type !== "worker_context") {
      this.send(ws, { type: "error", error: "Read-only access" });
      return;
    }

    if (msg.project && !isSafePathField(msg.project)) {
      this.send(ws, { type: "error", error: "Invalid project path" });
      return;
    }
    if (msg.workerId && !isSafeWorkerId(msg.workerId)) {
      this.send(ws, { type: "error", error: "Invalid workerId" });
      return;
    }
    if (msg.task && !isSafeTaskField(msg.task)) {
      this.send(ws, { type: "error", error: "Invalid task" });
      return;
    }
    if (msg.model && !isSafeModelId(msg.model)) {
      this.send(ws, { type: "error", error: "Invalid model" });
      return;
    }
    if (msg.machine && !isSafeMachineId(msg.machine)) {
      this.send(ws, { type: "error", error: "Invalid machine" });
      return;
    }
    if (msg.requestId && !isSafeRequestId(msg.requestId)) {
      this.send(ws, { type: "error", error: "Invalid requestId" });
      return;
    }
    if (msg.fileName && !isSafeFileName(msg.fileName)) {
      this.send(ws, { type: "error", error: "Invalid fileName" });
      return;
    }
    if (!isValidQuadrant(msg.targetQuadrant)) {
      this.send(ws, { type: "error", error: "Invalid targetQuadrant" });
      return;
    }

    switch (msg.type) {
      case "subscribe": {
        if (!msg.workerId) {
          this.send(ws, { type: "error", error: "Missing workerId" });
          return;
        }

        // Unsubscribe from previous (local or satellite)
        const prevSub = this.clientSubs.get(ws);
        if (prevSub) {
          // Unsubscribe from local streamer
          this.streamer.unsubscribe(prevSub + "_" + this.clientId(ws));
          // Remove from satellite chat clients
          const prevClients = this.satelliteChatClients.get(prevSub);
          if (prevClients) {
            prevClients.delete(ws);
            if (prevClients.size === 0) {
              this.satelliteChatClients.delete(prevSub);
              // Tell satellite to unsubscribe
              const prevSat = this.getSatelliteForWorker(prevSub);
              if (prevSat) {
                this.sendToSatellite(prevSat, {
                  type: "satellite_unsubscribe",
                  workerId: prevSub,
                });
              }
            }
          }
        }

        const workerId = msg.workerId;
        this.clientSubs.set(ws, workerId);

        // Route to satellite if this is a remote worker
        const subSat = this.getSatelliteForWorker(workerId);
        if (subSat) {
          const parsed = this.parseSatelliteWorker(workerId)!;
          // Track this dashboard client as subscribed to this satellite worker
          if (!this.satelliteChatClients.has(workerId)) {
            this.satelliteChatClients.set(workerId, new Set());
          }
          this.satelliteChatClients.get(workerId)!.add(ws);
          // Tell satellite to start streaming chat
          this.sendToSatellite(subSat, {
            type: "satellite_subscribe",
            workerId,
            localWorkerId: parsed.localId,
          });
          break;
        }

        // Verify session file mapping against TTY marker before reading history.
        // This prevents chat cross-contamination when multiple workers share a project.
        const subWorker = this.telemetry.get(workerId);
        if (subWorker?.tty) {
          this.streamer.verifySessionFile(workerId, subWorker.tty);
        }

        // Send chat history (full = authoritative replace on client)
        const history = this.streamer.readHistory(workerId);
        this.send(ws, { type: "chat_history", workerId, messages: history, full: true });

        // Start streaming new messages
        const subKey = workerId + "_" + this.clientId(ws);
        this.streamer.subscribe(subKey, workerId, (entries, full) => {
          if (ws.readyState === WebSocket.OPEN) {
            this.send(ws, { type: "chat_history", workerId, messages: entries, ...(full ? { full: true } : {}) });
          }
        });

        break;
      }

      case "unsubscribe": {
        const subId = this.clientSubs.get(ws);
        if (subId) {
          this.streamer.unsubscribe(subId + "_" + this.clientId(ws));
          this.clientSubs.delete(ws);
        }
        break;
      }

      case "spawn": {
        // Route to satellite if a remote machine is specified
        if (msg.machine && msg.machine !== "local") {
          const targetSat = this.satellites.get(msg.machine);
          if (!targetSat) {
            this.send(ws, { type: "error", error: `Machine "${msg.machine}" not connected` });
            return;
          }
          // Resolve project to satellite's local path.
          // msg.project can be a name ("hive"), a primary path, or "~".
          // Check satellite's capabilities.projects for the name mapping.
          let satProject = msg.project || "~";
          if (satProject && satProject !== "~") {
            const projectName = satProject.split("/").pop() || satProject;
            const satPath = targetSat.capabilities?.projects?.[projectName];
            if (satPath) {
              satProject = satPath;
            }
            // If no mapping found, send as-is  --  satellite handles its own resolution
          }
          this.sendToSatellite(targetSat, {
            type: "satellite_spawn",
            requestId: `spawn_${Date.now()}`,
            project: satProject,
            model: msg.model || "claude",
            initialMessage: msg.task?.trim() || undefined,
          });
          console.log(`Spawn routed to satellite "${msg.machine}" project="${satProject}" (model=${msg.model || "claude"})`);
          break;
        }

        const home = homedir();
        // Default to home directory if no project specified
        let real: string;
        if (!msg.project || msg.project === "~") {
          real = home;
        } else {
          const projectPath = msg.project.startsWith("~/")
            ? msg.project.replace("~", home)
            : msg.project;
          // Path traversal guard: real path (symlinks resolved) must be under home dir
          try {
            real = realpathSync(projectPath);
          } catch {
            this.send(ws, { type: "error", error: "Invalid project path" });
            return;
          }
          if (!real.startsWith(home + "/") && real !== home) {
            this.send(ws, { type: "error", error: "Invalid project path" });
            return;
          }
        }

        const model = msg.model || "claude";
        // Prevent spawning beyond 8 agents
        const currentCount = this.telemetry.getAll().length;
        if (currentCount >= 8) {
          this.send(ws, { type: "error", error: "All 8 slots are occupied" });
          return;
        }
        // Use the requested quadrant if provided and available, otherwise first open
        const requestedQ = typeof msg.targetQuadrant === "number" && msg.targetQuadrant >= 1 && msg.targetQuadrant <= 8
          ? msg.targetQuadrant
          : undefined;
        const openQ = requestedQ ?? this.telemetry.getFirstOpenQuadrant();

        // Only send an init message if the user provided a task
        const initMessage = msg.task?.trim() || undefined;

        // Open a real Terminal window with the CLI, positioned in the target quadrant
        const termResult = this.windows
          ? this.windows.spawnTerminal(real, model, openQ, initMessage, this.telemetry.getAll().length)
          : spawnTerminalWindow(real, model, openQ, initMessage, this.telemetry.getAll().length);
        if (!termResult.ok) {
          this.send(ws, { type: "error", error: termResult.error || "Failed to spawn terminal" });
          return;
        }

        // Mark TTY as freshly spawned so discovery skips heuristic session
        // file resolution  --  new agents start with blank chat history.
        if (termResult.tty) {
          this.telemetry.markSpawn(termResult.tty);
        }

        // Create an immediate placeholder worker so the dashboard tile
        // shows content before the 3-second discovery scan picks it up.
        if (termResult.tty) {
          const spawnTty = termResult.tty;
          const normalizedTty = spawnTty.replace("/dev/", "");
          const projectName = real.split("/").pop() || real;
          const placeholderId = `spawning_${normalizedTty.replace(/\//g, "_")}`;
          // Claude agents always show a trust prompt on first launch in a folder.
          // Pre-set promptType so the dashboard shows the blue "Trust folder"
          // button immediately instead of a blank "Starting..." tile.
          const isClaude = model === "claude";
          const placeholder: WorkerState = {
            id: placeholderId,
            pid: 0,
            project: real,
            projectName,
            status: "waiting" as const,
            currentAction: isClaude ? "Trust this project folder?" : "Starting...",
            lastAction: "Spawning terminal",
            lastActionAt: Date.now(),
            errorCount: 0,
            startedAt: Date.now(),
            task: null,
            managed: false,
            tty: spawnTty,
            model,
            terminalPreview: undefined,
            promptType: isClaude ? "trust" : null,
            promptMessage: isClaude ? "Trust this project folder?" : undefined,
          };
          this.telemetry.registerDiscovered(placeholderId, placeholder);

          // Poll terminal content every 1.5s until discovery replaces the
          // placeholder or 20s elapse  --  whichever comes first.
          let polls = 0;
          const maxPolls = 13; // ~20 seconds
          const pollTimer = setInterval(() => {
            polls++;
            // Stop if discovery has replaced the placeholder (worker with
            // this TTY now has a real PID)
            const current = this.telemetry.get(placeholderId);
            if (!current) {
              clearInterval(pollTimer);
              return;
            }

            // Check terminal output for prompts or "not found" errors
            if (this.discovery) {
              // Detect "command not found"  --  CLI isn't installed
              const content = this.discovery.readTerminalContent(spawnTty);
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
                  // Auto-remove after 10s so the error tile doesn't linger forever
                  setTimeout(() => {
                    const still = this.telemetry.get(placeholderId);
                    if (still && still.pid === 0) {
                      this.telemetry.removeWorker(placeholderId);
                    }
                  }, 10_000);
                  return;
                }
              }

              // Check for trust/sandbox prompts
              const prompt = this.discovery.detectPrompt(spawnTty, { bypassCache: true });
              if (prompt) {
                current.status = "waiting";
                current.promptType = prompt.type;
                current.promptMessage = prompt.message;
                current.currentAction = prompt.message;
                current.terminalPreview = prompt.content.split("\n").filter((l: string) => l.trim()).slice(-15).join("\n").trim().slice(0, 500) || undefined;
                this.telemetry.notifyExternal(current);
              } else if (current.promptType && polls >= 8) {
                // Pre-set promptType (e.g. trust for Claude) but no prompt detected
                // after 8 polls (~12s). The CLI takes 3-5s to boot, so we wait long
                // enough to be confident the folder was already trusted before clearing.
                // (Old threshold of 2 polls / ~3s was too aggressive and caused the
                // approval button to vanish before the CLI finished loading.)
                current.promptType = null;
                current.promptMessage = undefined;
                current.status = "idle";
                current.currentAction = null;
                this.telemetry.notifyExternal(current);
              }
            }

            if (polls >= maxPolls) {
              clearInterval(pollTimer);
              // If still a placeholder after 20s, remove it (something went wrong)
              const stillPlaceholder = this.telemetry.get(placeholderId);
              if (stillPlaceholder && stillPlaceholder.pid === 0) {
                this.telemetry.removeWorker(placeholderId);
              }
            }
          }, 1500);
        }

        this.send(ws, {
          type: "workers",
          workers: this.telemetry.getAll(),
        });
        console.log(`Spawned ${model} terminal for ${msg.project} (tty=${termResult.tty})`);
        if (activeUser) {
          const projectLabel = msg.project || "~";
          this.broadcastActivity(activeUser, `Spawned ${model} in ${projectLabel}`);
        }
        break;
      }

      case "kill": {
        if (!msg.workerId) {
          this.send(ws, { type: "error", error: "Missing workerId" });
          return;
        }

        // Route to satellite if this is a remote worker
        const killSat = this.getSatelliteForWorker(msg.workerId);
        if (killSat) {
          const parsed = this.parseSatelliteWorker(msg.workerId)!;
          this.sendToSatellite(killSat, {
            type: "satellite_kill",
            requestId: `kill_${Date.now()}`,
            workerId: msg.workerId,
            localWorkerId: parsed.localId,
          });
          // Remove from satellite's worker list immediately
          killSat.workers = killSat.workers.filter(w => w.id !== parsed.localId);
          this.lastWorkersSnapshot = null;
          console.log(`Killed satellite worker ${msg.workerId}`);
          break;
        }

        // Grab PID and TTY BEFORE any removal (procMgr.kill removes from telemetry)
        const killWorker = this.telemetry.get(msg.workerId);
        const killPid = killWorker?.pid;
        const killTty = killWorker?.tty;

        // Try ProcessManager first (for managed/spawned workers)
        this.procMgr.kill(msg.workerId);

        // SIGKILL immediately  --  process must be dead before we close the
        // Terminal window, otherwise Terminal shows a confirmation dialog
        // that can only be dismissed on the physical machine.
        if (killPid) {
          try { process.kill(killPid, "SIGKILL"); } catch { /* already gone */ }
        }

        // Remove from telemetry immediately (before discovery can re-discover)
        this.telemetry.removeWorker(msg.workerId);

        // Clear the TTY session marker so a new agent on the same TTY
        // doesn't inherit the old chat history.
        if (killTty) {
          const ttyName = killTty.replace("/dev/", "");
          const markerPath = join(homedir(), ".hive", "sessions", ttyName);
          try { unlinkSync(markerPath); } catch { /* already gone */ }
        }

        // Close the Terminal.app window/tab after process is dead (no dialog)
        if (killTty) {
          setTimeout(() => {
            const result = this.windows
              ? this.windows.closeTerminal(killTty)
              : closeTerminalWindow(killTty);
            if (!result.ok) {
              console.log(`[kill] Failed to close terminal ${killTty}: ${result.error}`);
            }
          }, 500);
        }
        console.log(`Killed worker ${msg.workerId} (pid=${killPid}, tty=${killTty})`);
        if (activeUser) {
          this.broadcastActivity(activeUser, `Killed ${msg.workerId}`);
        }
        break;
      }

      case "message": {
        if (!msg.workerId || !msg.content) {
          this.send(ws, {
            type: "error",
            error: "Missing workerId or content",
          });
          return;
        }

        // Route to satellite if this is a remote worker
        const msgSat = this.getSatelliteForWorker(msg.workerId);
        if (msgSat) {
          const parsed = this.parseSatelliteWorker(msg.workerId)!;
          this.sendToSatellite(msgSat, {
            type: "satellite_message",
            requestId: `msg_${Date.now()}`,
            workerId: msg.workerId,
            localWorkerId: parsed.localId,
            content: msg.content,
          });
          // Optimistic update + clear hysteresis so satellite stays green
          const dashSatKey = `${msgSat.machineId}:${parsed.localId}`;
          this.satelliteIdleCounts.set(dashSatKey, 0);
          const msgRemote = msgSat.workers.find(w => w.id === parsed.localId);
          if (msgRemote) {
            msgRemote.status = "working";
            msgRemote.currentAction = "Thinking...";
            msgRemote.lastAction = "Message sent from dashboard";
            msgRemote.lastActionAt = Date.now();
            this.lastWorkersSnapshot = null;
          }
          break;
        }

        const extra = msg as DaemonMessage & {
          from?: string;
          contextWorkerIds?: string[];
          includeSenderContext?: boolean;
        };
        // Async send  --  does NOT block the event loop. Dashboard stays responsive.
        this.telemetry.sendToWorkerAsync(msg.workerId, msg.content, {
          source: "dashboard",
          queueIfBusy: false,
          markDashboardInput: true,
          fromWorkerId: extra.from,
          contextWorkerIds: extra.contextWorkerIds,
          includeSenderContext: extra.includeSenderContext,
        }).then((result) => {
          if (!result.ok) {
            this.send(ws, { type: "error", error: result.error });
          } else if (!result.queued) {
            this.streamer.nudge(msg.workerId!);
          }
          if (result.ok && activeUser) {
            this.broadcastActivity(activeUser, `Sent message to ${msg.workerId}`);
          }
        });
        break;
      }

      case "selection": {
        if (!msg.workerId) {
          this.send(ws, { type: "error", error: "Missing workerId" });
          return;
        }

        // Route to satellite if this is a remote worker
        const selSat = this.getSatelliteForWorker(msg.workerId);
        if (selSat) {
          const parsed = this.parseSatelliteWorker(msg.workerId)!;
          this.sendToSatellite(selSat, {
            type: "satellite_selection",
            requestId: `sel_${Date.now()}`,
            workerId: msg.workerId,
            localWorkerId: parsed.localId,
            optionIndex: msg.optionIndex,
          });
          // Optimistic update + override
          const selRemote = selSat.workers.find(w => w.id === parsed.localId);
          if (selRemote) {
            selRemote.status = "working";
            selRemote.currentAction = "Thinking...";
            selRemote.lastAction = "User approved from dashboard";
            selRemote.lastActionAt = Date.now();
            selRemote.stuckMessage = undefined;
            this.lastWorkersSnapshot = null;
            this.satelliteOverrides.set(`${selSat.machineId}:${parsed.localId}`, {
              until: Date.now() + 25_000,
              status: "working",
              currentAction: "Thinking...",
              lastAction: "User approved from dashboard",
            });
          }
          break;
        }

        const selWorker = this.telemetry.get(msg.workerId);
        if (!selWorker?.tty) {
          this.send(ws, { type: "error", error: `Worker ${msg.workerId} not found or no TTY` });
          return;
        }
        // Allow selection if worker is stuck OR if it was recently stuck
        // (auto-pilot may have changed status to "working" but the prompt
        // is still displayed in the terminal waiting for input)
        const selResult = this.terminal
          ? this.terminal.sendSelection(selWorker.tty, msg.optionIndex || 0)
          : sendSelectionToTty(selWorker.tty, msg.optionIndex || 0);
        if (selResult.ok) {
          selWorker.status = "working";
          selWorker.currentAction = "Thinking...";
          selWorker.lastAction = "User approved from dashboard";
          selWorker.lastActionAt = Date.now();
          selWorker.stuckMessage = undefined;
          this.telemetry.markDashboardInput(msg.workerId);
          this.telemetry.markInputSent(msg.workerId, "dashboard:selection");
          this.telemetry.notifyExternal(selWorker);
          this.streamer.nudge(msg.workerId);
          console.log(`Selection sent to ${selWorker.tty}: option ${msg.optionIndex || 0}`);
          if (activeUser) {
            this.broadcastActivity(activeUser, `Selected option ${msg.optionIndex ?? 0} on ${msg.workerId}`);
          }
        } else {
          this.send(ws, { type: "error", error: selResult.error || "Selection failed" });
        }
        break;
      }

      case "list": {
        this.send(ws, {
          type: "workers",
          workers: this.telemetry.getAll(),
        });
        break;
      }

      case "worker_context": {
        if (!msg.workerId) {
          this.send(ws, { type: "error", error: "Missing workerId" });
          return;
        }
        const historyLimit = typeof msg.historyLimit === "number"
          ? Math.max(1, Math.min(20, Math.trunc(msg.historyLimit)))
          : 10;
        void this.telemetry.getWorkerContextAsync(msg.workerId, {
          includeHistory: msg.includeHistory !== false,
          historyLimit,
        }).then((context) => {
          if (ws.readyState !== WebSocket.OPEN) return;
          this.send(ws, {
            type: "worker_context",
            workerId: msg.workerId,
            context: (context && typeof context === "object") ? context as DaemonResponse["context"] : null,
          });
        }).catch((err) => {
          if (ws.readyState !== WebSocket.OPEN) return;
          this.send(ws, {
            type: "error",
            error: err instanceof Error ? err.message : "Failed to load worker context",
          });
        });
        break;
      }

      case "context_transfer": {
        const sourceIds = msg.sourceWorkerIds;
        const targetId = msg.targetWorkerId;
        if (!sourceIds?.length || !targetId) {
          this.send(ws, { type: "error", error: "Missing sourceWorkerIds or targetWorkerId" });
          return;
        }

        // Build a concatenated context summary from all source workers
        const parts: string[] = [];
        for (const sid of sourceIds) {
          const srcWorker = this.telemetry.get(sid);
          if (!srcWorker) continue;
          const srcNum = srcWorker.quadrant || "?";
          const srcName = srcWorker.projectName || "unknown";
          const chatEntries = this.streamer.readHistory(sid);
          const recent = chatEntries.slice(-20);
          if (recent.length === 0) {
            parts.push(`--- Q${srcNum} (${srcName}) ---\nNo recent messages.`);
            continue;
          }
          const lines = recent.map((e: { role: string; text: string }) => {
            const prefix = e.role === "user" ? "Human" : "Agent";
            return `${prefix}: ${e.text}`;
          });
          parts.push(`--- Q${srcNum} (${srcName}) ---\n${lines.join("\n")}`);
        }

        if (parts.length === 0) {
          this.send(ws, { type: "error", error: "No context found for source workers" });
          return;
        }

        const contextMessage = `Context transferred from ${sourceIds.length === 1 ? "another agent" : `${sourceIds.length} agents`}:\n\n${parts.join("\n\n")}`;

        this.telemetry.sendToWorkerAsync(targetId, contextMessage, {
          source: "dashboard",
          queueIfBusy: false,
          markDashboardInput: true,
        }).then((result) => {
          if (!result.ok) {
            this.send(ws, { type: "error", error: result.error });
          }
          if (result.ok && activeUser) {
            this.broadcastActivity(activeUser, `Transferred context to ${targetId}`);
          }
        });
        break;
      }

      case "list_devices": {
        const devices = this.deviceLayer?.registry.getAll() ?? [];
        this.send(ws, { type: "devices", devices });
        break;
      }

      case "list_reverts": {
        if (!this.revertHistory) {
          this.send(ws, { type: "reverts", reverts: [] });
          return;
        }
        this.send(ws, { type: "reverts", reverts: this.revertHistory.list() });
        break;
      }

      case "revert": {
        if (!this.revertHistory) {
          this.send(ws, { type: "error", error: "Revert history not available" });
          return;
        }
        const revertId = msg.revertId;
        const confirmation = msg.revertConfirmation;
        if (!revertId || !confirmation) {
          this.send(ws, { type: "error", error: "Missing revertId or confirmation" });
          return;
        }
        const entry = this.revertHistory.get(revertId);
        if (!entry) {
          this.send(ws, { type: "error", error: "Revert entry not found" });
          return;
        }
        if (!confirmation.startsWith(entry.commit)) {
          this.send(ws, { type: "error", error: `Confirmation must start with ${entry.commit}` });
          return;
        }
        // Execute git revert
        try {
          execFileSync("git", ["-C", entry.projectPath, "revert", "--no-edit", entry.commit], {
            timeout: 15_000,
            encoding: "utf-8",
          });
          this.send(ws, { type: "revert_result", ok: true, message: `Reverted ${entry.commit} in ${entry.projectName}` });
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message.slice(0, 200) : "Revert failed";
          this.send(ws, { type: "revert_result", ok: false, error: errMsg });
        }
        break;
      }

      case "upload_file": {
        if (!msg.workerId || !msg.requestId || !msg.fileName || !msg.dataBase64) {
          this.send(ws, { type: "error", error: "Missing upload fields" });
          return;
        }

        const sendResult = (payload: { ok: boolean; upload?: UploadedFileRef; error?: string }) => {
          if (ws.readyState !== WebSocket.OPEN) return;
          this.send(ws, {
            type: "upload_result",
            workerId: msg.workerId,
            requestId: msg.requestId,
            ok: payload.ok,
            ...(payload.upload ? { upload: payload.upload } : {}),
            ...(payload.error ? { error: payload.error } : {}),
          });
        };

        const uploadSat = this.getSatelliteForWorker(msg.workerId);
        if (uploadSat) {
          const parsed = this.parseSatelliteWorker(msg.workerId)!;
          const requestId = `upload_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          void this.requestSatelliteCommand(uploadSat, requestId, {
            type: "satellite_upload",
            requestId,
            workerId: msg.workerId,
            localWorkerId: parsed.localId,
            fileName: msg.fileName,
            mimeType: msg.mimeType,
            size: msg.size,
            dataBase64: msg.dataBase64,
          }, 30_000).then((result) => {
            if (result.ok) {
              sendResult({
                ok: true,
                upload: result.upload as UploadedFileRef | undefined,
              });
            } else {
              sendResult({
                ok: false,
                error: typeof result.error === "string" ? result.error : "Upload failed",
              });
            }
          }).catch((err) => {
            sendResult({
              ok: false,
              error: err instanceof Error ? err.message : "Upload failed",
            });
          });
          break;
        }

        const uploadWorker = this.telemetry.get(msg.workerId);
        if (!uploadWorker) {
          this.send(ws, { type: "error", error: `Worker ${msg.workerId} not found` });
          return;
        }

        try {
          const upload = storeUploadedFile({
            fileName: msg.fileName,
            mimeType: msg.mimeType,
            dataBase64: msg.dataBase64,
            size: msg.size,
          });
          sendResult({ ok: true, upload });
        } catch (err) {
          sendResult({
            ok: false,
            error: err instanceof Error ? err.message : "Upload failed",
          });
        }
        break;
      }

      case "suggestion_feedback": {
        if (msg.workerId && msg.appliedLabel && msg.shownLabels) {
          this.telemetry.recordSuggestionFeedback(
            msg.workerId,
            msg.appliedLabel,
            msg.shownLabels
          );
        }
        break;
      }

      case "review_seen": {
        if (msg.reviewId) {
          this.telemetry.markReviewSeen(msg.reviewId);
        }
        break;
      }

      case "review_dismiss": {
        if (msg.reviewId) {
          this.telemetry.dismissReview(msg.reviewId);
        }
        break;
      }

      case "review_seen_all": {
        this.telemetry.markAllReviewsSeen();
        break;
      }

      case "review_clear_all": {
        this.telemetry.clearAllReviews();
        this.broadcast({ type: "reviews", reviews: [] });
        break;
      }

      case "approve_prompt": {
        if (!msg.workerId) {
          this.send(ws, { type: "error", error: "Missing workerId" });
          return;
        }

        // Route to satellite if this is a remote worker
        const approveSat = this.getSatelliteForWorker(msg.workerId);
        if (approveSat) {
          const parsed = this.parseSatelliteWorker(msg.workerId)!;
          this.sendToSatellite(approveSat, {
            type: "satellite_approve",
            requestId: `approve_${Date.now()}`,
            workerId: msg.workerId,
            localWorkerId: parsed.localId,
          });
          // Optimistic update + override: reflect change immediately and
          // prevent stale satellite reports from reverting it for 15s.
          const approveRemote = approveSat.workers.find(w => w.id === parsed.localId);
          if (approveRemote) {
            approveRemote.promptType = null;
            approveRemote.promptMessage = undefined;
            approveRemote.status = "idle";
            approveRemote.currentAction = null;
            approveRemote.lastAction = "Prompt approved from dashboard";
            approveRemote.lastActionAt = Date.now();
            this.lastWorkersSnapshot = null;
            this.satelliteOverrides.set(`${approveSat.machineId}:${parsed.localId}`, {
              until: Date.now() + 25_000,
              status: "idle",
              currentAction: null,
              lastAction: "Prompt approved from dashboard",
            });
          }
          break;
        }

        const promptWorker = this.telemetry.get(msg.workerId);
        if (!promptWorker?.tty) {
          this.send(ws, { type: "error", error: `Worker ${msg.workerId} not found or no TTY` });
          return;
        }
        if (!promptWorker.promptType) {
          this.send(ws, { type: "error", error: "No pending prompt" });
          return;
        }

        // Optimistically update state so the dashboard reflects the
        // approval immediately, before the async AppleScript finishes.
        promptWorker.promptType = null;
        promptWorker.promptMessage = undefined;
        promptWorker.status = "idle";
        promptWorker.currentAction = null;
        promptWorker.lastAction = "Prompt approved from dashboard";
        promptWorker.lastActionAt = Date.now();
        if (this.discovery) {
          this.discovery.clearPromptCache(promptWorker.tty);
          this.discovery.suppressPrompt(promptWorker.tty);
        }
        this.telemetry.notifyExternal(promptWorker);

        // Send Enter keystroke through the async mutex so it serializes
        // with message sends and other approvals  --  prevents focus races
        // when approving multiple trust prompts rapidly.
        const approveTty = promptWorker.tty;
        const approvePromise = this.terminal
          ? this.terminal.sendKeystrokeAsync(approveTty, "enter")
          : sendEnterToTtyAsync(approveTty);
        approvePromise.then((approveResult) => {
          if (approveResult.ok) {
            console.log(`Prompt approved for ${approveTty}`);
          } else {
            console.log(`Prompt approve failed for ${approveTty}: ${approveResult.error}`);
          }
        }).catch((err) => {
          console.log(`Prompt approve error for ${approveTty}: ${err instanceof Error ? err.message : String(err)}`);
        });
        if (activeUser) {
          this.broadcastActivity(activeUser, `Approved prompt for ${msg.workerId}`);
        }
        break;
      }

      case "orchestrator": {
        this.send(ws, {
          type: "orchestrator",
          content: "Orchestrator not yet implemented",
        });
        break;
      }

      case "push_subscribe": {
        if (!this.pushMgr) {
          this.send(ws, { type: "error", error: "Push not available" });
          return;
        }
        if (!msg.subscription?.endpoint || !msg.subscription?.keys?.p256dh || !msg.subscription?.keys?.auth) {
          this.send(ws, { type: "error", error: "Invalid push subscription" });
          return;
        }
        this.pushMgr.addSubscription(msg.subscription, msg.pushLabel);
        this.send(ws, { type: "push_status", subscribed: true });
        break;
      }

      case "push_unsubscribe": {
        if (this.pushMgr && msg.subscription?.endpoint) {
          this.pushMgr.removeSubscription(msg.subscription.endpoint);
        }
        this.send(ws, { type: "push_status", subscribed: false });
        break;
      }

      case "user_list": {
        const users = this.userRegistry.getAll();
        this.send(ws, { type: "user_list", users });
        break;
      }

      case "user_create": {
        const connUser = this.connectedUsers.get(ws);
        if (!connUser || connUser.role !== "admin") {
          this.send(ws, { type: "error", error: "Admin access required" });
          break;
        }
        const userName = typeof msg.userName === "string" ? msg.userName.trim() : "";
        const userRole = msg.userRole as string;
        if (!userName || !["admin", "operator", "viewer", "voice"].includes(userRole)) {
          this.send(ws, { type: "error", error: "Missing userName or invalid userRole" });
          break;
        }
        const created = this.userRegistry.createUser(userName, userRole as "admin" | "operator" | "viewer" | "voice");
        this.send(ws, { type: "user_created", user: created });
        break;
      }

      case "user_remove": {
        const connUser2 = this.connectedUsers.get(ws);
        if (!connUser2 || connUser2.role !== "admin") {
          this.send(ws, { type: "error", error: "Admin access required" });
          break;
        }
        const removeId = typeof msg.userId === "string" ? msg.userId : "";
        if (!removeId) {
          this.send(ws, { type: "error", error: "Missing userId" });
          break;
        }
        const removed = this.userRegistry.removeUser(removeId);
        this.send(ws, { type: "user_removed", userId: removeId, ok: removed });
        break;
      }

      default:
        this.send(ws, { type: "error", error: "Unknown message type" });
    }
  }

  private send(ws: WebSocket, response: DaemonResponse): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(response));
    }
  }

  private broadcast(response: DaemonResponse): void {
    const data = JSON.stringify(response);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  }

  /** Public broadcast for external subsystems (device layer, etc.). */
  publicBroadcast(response: Record<string, unknown>): void {
    this.broadcast(response as unknown as DaemonResponse);
  }

  private getPresenceSnapshot(): HiveUserInfo[] {
    const seen = new Map<string, HiveUser>();
    for (const user of this.connectedUsers.values()) {
      seen.set(user.id, user);
    }
    return Array.from(seen.values()).map((user) => ({
      id: user.id,
      name: user.name,
      role: user.role,
      createdAt: user.createdAt,
    }));
  }

  private broadcastPresence(): void {
    this.broadcast({
      type: "presence",
      users: this.getPresenceSnapshot(),
    });
  }

  private broadcastActivity(user: HiveUser, action: string): void {
    this.broadcast({
      type: "activity",
      userId: user.id,
      userName: user.name,
      action,
      timestamp: Date.now(),
    });
    this.recordReplay("activity", { userId: user.id, action });
  }

  private recordReplay(type: string, payload: unknown): void {
    this.replayManager?.record(type, payload);
  }
}
