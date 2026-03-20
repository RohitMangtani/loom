import express from "express";
import type { Request, Response, NextFunction } from "express";
import { randomBytes } from "crypto";
import { hostname } from "os";
import { basename, join } from "path";
import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync, readdirSync, statSync } from "fs";
import { describeAction, truncate } from "./utils.js";
import type { DaemonSnapshot } from "./state-store.js";
import type { Server } from "http";
import { validateToken } from "./auth.js";
import { sendInputToTty, sendInputToTtyAsync } from "./tty-input.js";
import type { ProcessManager } from "./process-mgr.js";
import type { ProcessDiscovery } from "./discovery.js";
import type { ChatEntry, MachineCapabilities, WorkerState, TelemetryEvent } from "./types.js";
import { TaskQueue } from "./task-queue.js";
import type { QueuedTask } from "./task-queue.js";
import { Scratchpad } from "./scratchpad.js";
import type { ScratchpadEntry } from "./scratchpad.js";
import { LockManager } from "./lock-manager.js";
import { registerApiRoutes } from "./api-routes.js";
import { updateTerminalTitles, arrangeTerminalWindows, detectQuadrantsFromWindowPositions, positionWindowToQuadrant, resetArrangementCache } from "./arrange-windows.js";
import type { Collector } from "./collector.js";
import { SuggestionEngine } from "./suggestion-engine.js";
import { ReviewStore } from "./review-store.js";
import type { ReviewItem } from "./review-store.js";
import { scanLocalProjects } from "./project-discovery.js";

const IDLE_THRESHOLD = 30_000;
const HOME = process.env.HOME || `/Users/${process.env.USER}`;
const LOCAL_MACHINE_LABEL = hostname();

interface QueuedMessage {
  id: string;
  content: string;
  source: string;
  queuedAt: number;
  withIdentity?: boolean;
  lastAction?: string;
  markDashboardInput?: boolean;
  trackDispatch?: boolean;
  taskBrief?: string;
  taskId?: string;
  workflowId?: string;
  fromWorkerId?: string;
  contextWorkerIds?: string[];
  includeSenderContext?: boolean;
  verify?: boolean;
  maxVerifyAttempts?: number;
  autoCommit?: boolean;
}

interface WorkerContextOptions {
  includeHistory?: boolean;
  historyLimit?: number;
  artifactLimit?: number;
}

interface SwarmProjectEntry {
  name: string;
  path: string;
  machines?: Record<string, string>;
}

interface SwarmSpawnRequest {
  project?: string;
  model?: string;
  task?: string;
  targetQuadrant?: number;
  machine?: string;
  fromMachine?: string;
}

export interface WorkerContextSnapshot {
  workerId: string;
  quadrant?: number;
  tty?: string;
  model: string;
  project: string;
  projectName: string;
  status: WorkerState["status"];
  currentAction: string | null;
  lastAction: string;
  lastDirection?: string;
  recentArtifacts: Array<{ path: string; action: string; ts: number }>;
  recentMessages: ChatEntry[];
  contextSummary: string;
}

interface TelemetryStreamer {
  getSessionFile(id: string): string | null;
  setSessionFile(id: string, path: string): void;
  readHistory?(workerId: string): ChatEntry[];
}

export class TelemetryReceiver {
  private workers = new Map<string, WorkerState>();
  private listeners: Array<(workerId: string, state: WorkerState) => void> = [];
  private removalListeners: Array<(workerId: string) => void> = [];
  private server: Server | null = null;
  private port: number;
  private app: ReturnType<typeof express> | null = null;
  private requireAuth: ((req: Request, res: Response, next: NextFunction) => void) | null = null;

  /** Expose Express app for satellite API route registration. */
  getApp(): ReturnType<typeof express> | null { return this.app; }
  getAuthMiddleware(): ((req: Request, res: Response, next: NextFunction) => void) | null { return this.requireAuth; }

  // Hook support
  private sessionToWorker = new Map<string, string>();
  private lastHookTime = new Map<string, number>();
  private toolInFlight = new Map<string, { tool: string; since: number } | null>();
  private idleConfirmed = new Map<string, boolean>();
  private lastDashboardInput = new Map<string, number>();
  private lastInputSent = new Map<string, number>();

  // Artifact tracking
  private artifacts = new Map<string, Array<{ path: string; action: string; ts: number }>>();
  private static readonly MAX_ARTIFACTS = 50;

  // LLM suggestion engine (Phase 3)
  private suggestionEngine = new SuggestionEngine();

  // Session file streamer reference (set via setStreamer, used for register-tty correction)
  private streamer: TelemetryStreamer | null = null;

  // Sessions corrected by register-tty are "pinned" — discovery's registerSession
  // must not overwrite them with wrong birthtime-based guesses.
  private pinnedSessions = new Map<string, string>(); // session_id → correct workerId

  // Pending register-tty corrections: queued when identity.sh fires before
  // the daemon has discovered the worker (race on cold boot).
  // Replayed in registerDiscovered() when the worker appears.
  private pendingTtyRegistrations = new Map<string, string>(); // tty → session_id

  // Durable TTY→session_id file path. Written on every register-tty call,
  // read on daemon startup. Survives daemon AND computer restarts because
  // it has no expiry — identity.sh overwrites it on the first prompt of each
  // new session, so stale entries are harmless (the JSONL file just won't exist).
  private static readonly TTY_SESSION_PATH = join(
    process.env.HOME || `/Users/${process.env.USER}`, ".hive", "tty-sessions.json"
  );

  // Recently-spawned TTYs: suppresses heuristic session file resolution so
  // freshly spawned agents start with blank chat history instead of inheriting
  // stale JSONL from a previous session in the same project.
  private recentSpawns = new Map<string, number>(); // tty → spawnTimestamp
  private static readonly SPAWN_GRACE_PERIOD = 60_000; // 60s

  // Satellite workers injected by ws-server for inclusion in workers.json
  // so the primary's identity hook shows cross-machine peers.
  private satelliteSlots: Array<{ quadrant: number; id: string; pid: number; tty?: string; project: string; projectName: string; status: string; currentAction: string | null; lastAction: string; startedAt: number; model: string; machine?: string; machineLabel?: string }> = [];

  // Dispatch tracking
  private dispatchedTasks = new Map<string, {
    task: string; project: string; sentAt: number;
    taskId?: string; workflowId?: string; fromWorkerId?: string;
    // Verification loop fields
    verify?: boolean; maxVerifyAttempts?: number;
    verifyAttempts?: number; verifyPhase?: boolean;
    artifactsAtVerifyStart?: number;
    // Auto-commit after completion
    autoCommit?: boolean;
  }>();

  // Auto-commit listeners (ws-server uses this to route satellite commits)
  private autoCommitListeners: Array<(workerId: string, project: string, files: string[], message: string) => void> = [];

  // Satellite relay: ws-server registers this so the REST API can route
  // messages to satellite workers (workerId contains "machineId:localId").
  private satelliteMessageRelay: ((workerId: string, content: string, from?: string) => Promise<{ ok: boolean; error?: string }>) | null = null;
  private satelliteAllWorkersGetter: (() => WorkerState[]) | null = null;
  private swarmProjectsGetter: (() => { projects: SwarmProjectEntry[] }) | null = null;
  private swarmCapabilitiesGetter: (() => Record<string, MachineCapabilities>) | null = null;
  private swarmSpawnHandler: ((request: SwarmSpawnRequest) => { ok: boolean; error?: string; [key: string]: unknown }) | null = null;
  private swarmKillHandler: ((workerId: string, fromMachine?: string) => { ok: boolean; error?: string; [key: string]: unknown }) | null = null;
  private swarmSatelliteMaintenanceHandler: ((machineId: string, action?: string, fromMachine?: string) => { ok: boolean; error?: string; [key: string]: unknown }) | null = null;

  // Workflow handoffs: workflowId → handoff context from completed steps
  private workflowHandoffs = new Map<string, string[]>();

  // Signal timeline (ring buffer per worker)
  private signals = new Map<string, Array<{ ts: number; signal: string; detail: string }>>();
  private static readonly MAX_SIGNALS = 50;

  // Message queue for busy workers
  private messageQueue = new Map<string, QueuedMessage[]>();
  private messageIdCounter = 0;

  // Pending hook queue (hooks waiting for session registration)
  private pendingHooks = new Map<string, Array<{ body: Record<string, unknown>; receivedAt: number }>>();
  private static readonly HOOK_QUEUE_TTL = 10_000;
  private static readonly HOOK_QUEUE_MAX_PER_SESSION = 20;

  // Composed subsystems
  private taskQueue: TaskQueue;
  private scratchpad: Scratchpad;
  private lockManager: LockManager;
  private reviewStore: ReviewStore;

  // Review listeners (for WS broadcast of new reviews)
  private reviewListeners: Array<(review: ReviewItem) => void> = [];

  private token: string;
  private collector: Collector | null = null;
  private processManager: ProcessManager | null = null;

  constructor(port: number, token: string) {
    this.port = port;
    this.token = token;
    this.taskQueue = new TaskQueue();
    this.scratchpad = new Scratchpad();
    this.reviewStore = new ReviewStore();
    this.lockManager = new LockManager(
      (id) => this.workers.has(id),
      (id) => this.workers.get(id)?.tty,
    );
  }

  start(): void {
    const app = express();
    app.use(express.json({ limit: "10mb" }));
    this.app = app;

    const requireAuth = (req: Request, res: Response, next: NextFunction) => {
      const header = req.headers.authorization || "";
      const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
      const query = (req.query.token as string) || "";
      const candidate = bearer || query;
      if (!validateToken(candidate, this.token)) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      next();
    };
    this.requireAuth = requireAuth;

    app.get("/health", (_req, res) => {
      res.json({ ok: true });
    });

    app.post("/telemetry", requireAuth, (req, res) => {
      const event = req.body as TelemetryEvent;
      if (!event.worker_id || !event.event) {
        res.status(400).json({ error: "Missing worker_id or event" });
        return;
      }
      this.handleEvent(event);
      res.json({ ok: true });
    });

    app.post("/hook", requireAuth, (req, res) => {
      const decision = this.handleHook(req.body);
      if (decision) {
        res.json(decision);
      } else {
        res.json({ ok: true });
      }
    });

    // Session→TTY correction endpoint.
    // Called by identity.sh on every UserPromptSubmit with {session_id, tty}.
    // Corrects birthtime-based session file mapping when workers start
    // within seconds of each other (system restart scenario).
    app.post("/api/register-tty", requireAuth, (req, res) => {
      const { session_id, tty } = req.body as { session_id?: string; tty?: string };
      if (!session_id || !tty) {
        res.status(400).json({ error: "session_id and tty required" });
        return;
      }

      // Find which worker owns this TTY
      let targetWorker: WorkerState | undefined;
      for (const w of this.workers.values()) {
        if (w.tty === tty) {
          targetWorker = w;
          break;
        }
      }
      if (!targetWorker) {
        // Worker not discovered yet (identity.sh fired before first scan).
        // Queue for replay when the worker appears.
        this.pendingTtyRegistrations.set(tty, session_id);
        this.saveTtySessions();
        console.log(`[register-tty] Queued ${session_id} for tty=${tty} (worker not yet discovered)`);
        res.json({ ok: true, action: "queued" });
        return;
      }

      // Check if session is already correctly mapped
      const currentMapping = this.sessionToWorker.get(session_id);
      if (currentMapping === targetWorker.id) {
        res.json({ ok: true, action: "already-correct" });
        return;
      }

      // Correct the mapping: session_id → worker on this TTY
      console.log(`[register-tty] Correcting session ${session_id}: ${currentMapping || "unmapped"} → ${targetWorker.id} (tty=${tty})`);

      // Pin this session so discovery's registerSession doesn't overwrite it
      this.pinnedSessions.set(session_id, targetWorker.id);
      this.sessionToWorker.set(session_id, targetWorker.id);

      // Clear fresh-spawn suppression — identity hook confirms the new session is live
      this.clearSpawn(tty);

      // Update the session file to match this session_id
      const homeDir = process.env.HOME || `/Users/${process.env.USER}`;
      const projectsDir = join(homeDir, ".claude", "projects");
      // The JSONL is in the encoded-cwd directory. Try the worker's known project path first,
      // then fall back to home directory encoding.
      const encodings = [
        targetWorker.project.replace(/\//g, "-"),
        (homeDir).replace(/\//g, "-"),
      ];
      for (const encoded of encodings) {
        const candidateFile = join(projectsDir, encoded, `${session_id}.jsonl`);
        if (existsSync(candidateFile)) {
          // Also clear the old session file assignment if it was wrong
          const oldFile = this.streamer?.getSessionFile(targetWorker.id);
          if (oldFile && basename(oldFile, ".jsonl") !== session_id) {
            console.log(`[register-tty] Updating session file for ${targetWorker.id}: ${basename(oldFile)} → ${session_id}.jsonl`);
          }
          this.streamer?.setSessionFile(targetWorker.id, candidateFile);
          this.replayPendingHooks(session_id, targetWorker.id);
          break;
        }
      }

      this.saveTtySessions();
      res.json({ ok: true, action: "corrected", workerId: targetWorker.id });
    });

    this.server = app.listen(this.port, "127.0.0.1", () => {
      console.log(`  Telemetry receiver listening on 127.0.0.1:${this.port}`);
    });
  }

  /** Register REST API routes (dispatch API). */
  registerApi(procMgr: ProcessManager, discovery: ProcessDiscovery): void {
    if (!this.app || !this.requireAuth) {
      throw new Error("registerApi() called before start()");
    }
    registerApiRoutes(this.app, this.requireAuth, this, procMgr, discovery);
  }

  registerCollector(collector: Collector): void {
    this.collector = collector;
    if (this.app && this.requireAuth) {
      collector.registerRoutes(this.app, this.requireAuth);
    }
  }

  registerProcessManager(procMgr: ProcessManager): void {
    this.processManager = procMgr;
  }

  /** Give telemetry access to the session streamer for register-tty corrections */
  setStreamer(s: TelemetryStreamer): void {
    this.streamer = s;
  }

  /** Persist TTY→session_id map to disk. Called on every register-tty so mappings
   *  survive daemon restarts AND computer restarts. */
  private saveTtySessions(): void {
    const map: Record<string, string> = {};
    for (const [tty, sessionId] of this.pendingTtyRegistrations) {
      map[tty] = sessionId;
    }
    for (const [sessionId, workerId] of this.pinnedSessions) {
      const worker = this.workers.get(workerId);
      if (worker?.tty) map[worker.tty] = sessionId;
    }
    try {
      writeFileSync(TelemetryReceiver.TTY_SESSION_PATH, JSON.stringify(map) + "\n");
    } catch { /* best-effort */ }
  }

  /** Load TTY→session_id map from disk and resolve to JSONL file paths.
   *  Returns tty → absolute JSONL path for each valid entry. */
  loadTtySessions(): Map<string, string> {
    const result = new Map<string, string>();
    try {
      if (!existsSync(TelemetryReceiver.TTY_SESSION_PATH)) return result;
      const raw = JSON.parse(readFileSync(TelemetryReceiver.TTY_SESSION_PATH, "utf-8")) as Record<string, string>;
      const homeDir = process.env.HOME || `/Users/${process.env.USER}`;
      const projectsDir = join(homeDir, ".claude", "projects");

      for (const [tty, sessionId] of Object.entries(raw)) {
        // Search all project dirs for this session's JSONL file
        try {
          for (const dir of readdirSync(projectsDir)) {
            const candidate = join(projectsDir, dir, `${sessionId}.jsonl`);
            if (existsSync(candidate)) {
              result.set(tty, candidate);
              break;
            }
          }
        } catch { /* skip */ }
      }
    } catch { /* file missing or corrupt */ }
    return result;
  }

  // --- Session management ---

  registerSession(sessionId: string, workerId: string): void {
    // Respect pinned sessions: register-tty provides ground truth (TTY→session mapping
    // from identity.sh). Discovery's birthtime heuristic must not overwrite it.
    const pinned = this.pinnedSessions.get(sessionId);
    if (pinned && pinned !== workerId) {
      return; // Don't overwrite — register-tty already corrected this
    }
    this.sessionToWorker.set(sessionId, workerId);
    this.replayPendingHooks(sessionId, workerId);
  }

  registerManagedSession(workerId: string, project: string, sessionId: string): void {
    this.sessionToWorker.set(sessionId, workerId);
    const encodings = [
      project.replace(/\//g, "-"),
      HOME.replace(/\//g, "-"),
    ];
    for (const encoded of encodings) {
      const candidate = join(HOME, ".claude", "projects", encoded, `${sessionId}.jsonl`);
      if (existsSync(candidate)) {
        this.streamer?.setSessionFile(workerId, candidate);
        break;
      }
    }
  }

  /** Returns the pinned session_id for a worker, if register-tty has corrected it */
  getPinnedSessionForWorker(workerId: string): string | null {
    for (const [sid, wid] of this.pinnedSessions) {
      if (wid === workerId) return sid;
    }
    return null;
  }

  isSessionOwnedByOther(sessionId: string, workerId: string): boolean {
    const owner = this.sessionToWorker.get(sessionId);
    return !!owner && owner !== workerId;
  }

  getLastHookTime(workerId: string): number | undefined {
    return this.lastHookTime.get(workerId);
  }

  /** Mark a TTY as freshly spawned so discovery skips heuristic session resolution */
  markSpawn(tty: string): void {
    const normalized = tty.startsWith("/dev/") ? tty : `/dev/${tty}`;
    this.recentSpawns.set(normalized, Date.now());
  }

  /** Check if a TTY was recently spawned (within grace period) */
  isRecentSpawn(tty: string | undefined): boolean {
    if (!tty) return false;
    const normalized = tty.startsWith("/dev/") ? tty : `/dev/${tty}`;
    const spawnedAt = this.recentSpawns.get(normalized);
    if (!spawnedAt) return false;
    if (Date.now() - spawnedAt > TelemetryReceiver.SPAWN_GRACE_PERIOD) {
      this.recentSpawns.delete(normalized);
      return false;
    }
    return true;
  }

  /** Clear spawn mark (called when identity hook pins a session — authoritative source) */
  clearSpawn(tty: string): void {
    const normalized = tty.startsWith("/dev/") ? tty : `/dev/${tty}`;
    this.recentSpawns.delete(normalized);
  }

  isIdleConfirmed(workerId: string): boolean {
    return this.idleConfirmed.get(workerId) === true;
  }

  setIdleConfirmed(workerId: string, value: boolean): void {
    this.idleConfirmed.set(workerId, value);
  }

  isToolInFlight(workerId: string): boolean {
    return this.toolInFlight.get(workerId) != null;
  }

  getToolInFlight(workerId: string): { tool: string; since: number } | null {
    return this.toolInFlight.get(workerId) ?? null;
  }

  // --- Input tracking ---

  markDashboardInput(workerId: string): void {
    this.lastDashboardInput.set(workerId, Date.now());
  }

  getLastDashboardInput(workerId: string): number {
    return this.lastDashboardInput.get(workerId) || 0;
  }

  markInputSent(workerId: string, source?: string): void {
    this.lastInputSent.set(workerId, Date.now());
    this.recordSignal(workerId, "input_sent", source ? `${source} → pending` : "external input → pending");
  }

  getLastInputSent(workerId: string): number {
    return this.lastInputSent.get(workerId) || 0;
  }

  // --- Artifact tracking ---

  recordArtifact(workerId: string, filePath: string, action: string): void {
    if (!this.artifacts.has(workerId)) {
      this.artifacts.set(workerId, []);
    }
    const list = this.artifacts.get(workerId)!;
    const existing = list.find(a => a.path === filePath);
    if (existing) {
      existing.action = action;
      existing.ts = Date.now();
    } else {
      list.push({ path: filePath, action, ts: Date.now() });
      if (list.length > TelemetryReceiver.MAX_ARTIFACTS) {
        list.shift();
      }
    }
  }

  getArtifacts(workerId: string): Array<{ path: string; action: string; ts: number }> {
    return this.artifacts.get(workerId) || [];
  }

  private getRecentArtifacts(workerId: string, limit = 5): Array<{ path: string; action: string; ts: number }> {
    return this.getArtifacts(workerId)
      .filter((artifact) => Date.now() - artifact.ts < 30 * 60 * 1000)
      .slice(-limit);
  }

  private getRecentMessages(workerId: string, limit = 6): ChatEntry[] {
    if (!this.streamer?.readHistory) return [];
    return this.streamer.readHistory(workerId)
      .slice(-limit)
      .map((entry) => ({
        ...entry,
        text: truncate(entry.text, 160),
      }));
  }

  private formatWorkerContext(context: WorkerContextSnapshot): string {
    const heading = `${context.quadrant ? `Q${context.quadrant}` : context.workerId} ${context.tty ? `(${context.tty}, ${context.model})` : `(${context.model})`}`;
    const lines = [
      `### ${heading}`,
      `- Project: ${context.projectName}`,
      `- Status: ${context.status}`,
      `- Action: ${context.currentAction || context.lastAction}`,
    ];

    if (context.lastDirection) {
      lines.push(`- Last direction: ${context.lastDirection}`);
    }

    if (context.recentArtifacts.length > 0) {
      const files = context.recentArtifacts
        .map((artifact) => `${artifact.path.split("/").slice(-2).join("/")} (${artifact.action})`);
      lines.push(`- Recent files: ${files.join(", ")}`);
    }

    if (context.recentMessages.length > 0) {
      lines.push("- Recent conversation:");
      for (const entry of context.recentMessages) {
        lines.push(`  - ${entry.role}: ${entry.text}`);
      }
    }

    return lines.join("\n");
  }

  getWorkerContext(workerId: string, options: WorkerContextOptions = {}): WorkerContextSnapshot | null {
    const worker = this.getWorkerSnapshot(workerId);
    if (!worker) return null;

    const hasLocalState = this.workers.has(workerId);

    const recentArtifacts = hasLocalState ? this.getRecentArtifacts(workerId, options.artifactLimit ?? 5) : [];
    const recentMessages = options.includeHistory === false || !hasLocalState
      ? []
      : this.getRecentMessages(workerId, options.historyLimit ?? 6);

    const context: WorkerContextSnapshot = {
      workerId: worker.id,
      quadrant: worker.quadrant,
      tty: worker.tty,
      model: worker.model || "claude",
      project: worker.project,
      projectName: worker.projectName,
      status: worker.status,
      currentAction: worker.currentAction,
      lastAction: worker.lastAction,
      lastDirection: worker.lastDirection,
      recentArtifacts,
      recentMessages,
      contextSummary: "",
    };
    context.contextSummary = this.formatWorkerContext(context);
    return context;
  }

  getWorkerContexts(options: WorkerContextOptions & { workerIds?: string[] } = {}): WorkerContextSnapshot[] {
    const allow = options.workerIds ? new Set(options.workerIds) : null;
    return this.getAll()
      .filter((worker) => !allow || allow.has(worker.id))
      .map((worker) => this.getWorkerContext(worker.id, options))
      .filter((worker): worker is WorkerContextSnapshot => worker !== null);
  }

  composeMessageWithContext(
    targetWorkerId: string,
    content: string,
    options: {
      fromWorkerId?: string;
      contextWorkerIds?: string[];
      includeSenderContext?: boolean;
      historyLimit?: number;
    } = {},
  ): string {
    const contextIds = new Set<string>();
    if (options.includeSenderContext !== false && options.fromWorkerId && this.getWorkerSnapshot(options.fromWorkerId)) {
      contextIds.add(options.fromWorkerId);
    }
    for (const workerId of options.contextWorkerIds || []) {
      if (this.getWorkerSnapshot(workerId)) contextIds.add(workerId);
    }
    contextIds.delete(targetWorkerId);

    if (contextIds.size === 0) return content;

    const contexts = Array.from(contextIds)
      .map((workerId) => this.getWorkerContext(workerId, { historyLimit: options.historyLimit ?? 4 }))
      .filter((ctx): ctx is WorkerContextSnapshot => ctx !== null);
    if (contexts.length === 0) return content;

    return `${content.trim()}\n\n## Hive Peer Context\nUse this only if it is relevant to the task.\n\n${contexts.map((ctx) => ctx.contextSummary).join("\n\n")}`;
  }

  private writeContextBundle(worker: WorkerState, content: string): string {
    const dir = join(HOME, ".hive", "context-messages");
    const name = `msg-${Date.now()}-${randomBytes(4).toString("hex")}.md`;
    const path = join(dir, name);
    const header = [
      "# Hive Routed Message",
      `Target: ${worker.quadrant ? `Q${worker.quadrant}` : worker.id}${worker.tty ? ` (${worker.tty})` : ""}`,
      `Model: ${worker.model || "claude"}`,
      `Created: ${new Date().toISOString()}`,
      "",
    ].join("\n");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, `${header}${content.trim()}\n`, "utf-8");
    return path;
  }

  private prepareTtyPayload(worker: WorkerState, content: string): string {
    if (!worker.tty || content.length <= 400) return content;
    const bundlePath = this.writeContextBundle(worker, content);
    return `Read ${bundlePath} and follow it exactly. The full routed message and peer context are in that file.`;
  }

  checkConflicts(
    filePath: string,
    excludeWorkerId?: string,
    maxAgeMs = 30 * 60 * 1000,
  ): Array<{ workerId: string; tty?: string; action: string; ts: number }> {
    const results: Array<{ workerId: string; tty?: string; action: string; ts: number }> = [];
    const now = Date.now();
    for (const [wid, arts] of this.artifacts) {
      if (wid === excludeWorkerId) continue;
      for (const art of arts) {
        if (art.path === filePath && now - art.ts < maxAgeMs) {
          const worker = this.workers.get(wid);
          results.push({ workerId: wid, tty: worker?.tty, action: art.action, ts: art.ts });
        }
      }
    }
    return results;
  }

  // --- Dispatch tracking ---

  trackDispatch(workerId: string, taskBrief: string, taskId?: string, workflowId?: string, fromWorkerId?: string, verify?: boolean, maxVerifyAttempts?: number, autoCommit?: boolean): void {
    const worker = this.getWorkerSnapshot(workerId);
    const project = worker?.project || "";
    this.dispatchedTasks.set(workerId, {
      task: taskBrief.slice(0, 200),
      project,
      sentAt: Date.now(),
      taskId,
      workflowId,
      fromWorkerId,
      verify,
      maxVerifyAttempts,
      autoCommit,
    });
  }

  private checkCompletedDispatches(): void {
    for (const [workerId, dispatch] of this.dispatchedTasks) {
      const worker = this.getWorkerSnapshot(workerId);
      if (!worker) {
        if (dispatch.taskId) {
          this.taskQueue.requeueRunningTask(workerId);
        }
        this.dispatchedTasks.delete(workerId);
        continue;
      }

      if (worker.status === "idle" && Date.now() - dispatch.sentAt > 10_000) {
        const artifacts = this.getArtifacts(workerId);
        const recentArtifacts = artifacts.filter(a => Date.now() - a.ts < 30 * 60 * 1000);
        const maxVerify = dispatch.maxVerifyAttempts || 3;

        // --- Verification loop ---
        // Phase 1: Task just finished, verification enabled, not yet in verify phase
        if (dispatch.verify && !dispatch.verifyPhase) {
          dispatch.verifyPhase = true;
          dispatch.verifyAttempts = 1;
          dispatch.artifactsAtVerifyStart = artifacts.length;
          dispatch.sentAt = Date.now();
          const ttyLabel = worker.tty || workerId;
          const verifyMsg = `[Hive Verify] You just completed: "${dispatch.task}". Before this is marked done, verify your work:\n1. Run the build or dev server if applicable and check for errors\n2. Review what you changed for correctness\n3. Fix any issues you find\nIf everything looks good, just say done. If you fixed something, say what. (Attempt 1/${maxVerify})`;
          this.sendToWorker(workerId, verifyMsg, {
            source: "verification",
            queueIfBusy: true,
            lastAction: "Verification check",
          });
          console.log(`[verify] ${ttyLabel}: verification prompt sent (attempt 1/${maxVerify})`);
          continue;
        }

        // Phase 2: Agent went idle after a verification prompt
        if (dispatch.verify && dispatch.verifyPhase) {
          const currentArtifactCount = artifacts.length;
          const madeChanges = currentArtifactCount > (dispatch.artifactsAtVerifyStart || 0);
          const attempts = dispatch.verifyAttempts || 1;
          const ttyLabel = worker.tty || workerId;

          if (madeChanges && attempts < maxVerify) {
            // Agent fixed something during verification — re-verify
            dispatch.verifyAttempts = attempts + 1;
            dispatch.sentAt = Date.now();
            dispatch.artifactsAtVerifyStart = currentArtifactCount;
            const verifyMsg = `[Hive Verify] You made changes during verification. Check again — run build, confirm no new errors. (Attempt ${attempts + 1}/${maxVerify})`;
            this.sendToWorker(workerId, verifyMsg, {
              source: "verification",
              queueIfBusy: true,
              lastAction: "Re-verification check",
            });
            console.log(`[verify] ${ttyLabel}: re-verify (made changes), attempt ${attempts + 1}/${maxVerify}`);
            continue;
          }

          // Verification complete — either no changes (clean pass) or retry cap hit
          if (madeChanges) {
            console.log(`[verify] ${ttyLabel}: verification cap reached after ${attempts} attempts (still making changes)`);
          } else {
            console.log(`[verify] ${ttyLabel}: verification passed (no changes on attempt ${attempts})`);
          }
          // Fall through to normal completion
        }

        // --- Normal completion (with or without verification) ---
        const fileList = artifacts.length > 0
          ? ` Files: ${artifacts.map(a => basename(a.path)).join(", ")}`
          : "";
        const verifyNote = dispatch.verify
          ? ` [verified: ${dispatch.verifyAttempts || 0} attempt(s)]`
          : "";
        const lesson = `Completed: ${dispatch.task}${fileList}${verifyNote}`;
        this.writeLearning(dispatch.project, lesson);

        // Auto-commit: commit artifact files if explicitly enabled for this dispatch
        if (dispatch.autoCommit && recentArtifacts.length > 0 && dispatch.project) {
          if (worker.machine) {
            // Satellite worker — notify listeners so ws-server can forward to satellite
            const files = recentArtifacts
              .filter(a => a.action === "created" || a.action === "edited" || a.action === "wrote")
              .map(a => a.path);
            if (files.length > 0) {
              for (const listener of this.autoCommitListeners) {
                listener(workerId, dispatch.project, [...new Set(files)], dispatch.task);
              }
              console.log(`[auto-commit] ${workerId}: satellite commit requested for ${files.length} file(s)`);
            }
          } else {
            // Local worker — commit directly
            const commitHash = this.autoCommitArtifacts(workerId, dispatch.project, dispatch.task);
            if (commitHash) {
              const commitLesson = `Auto-committed ${recentArtifacts.length} file(s) → ${commitHash}`;
              this.writeLearning(dispatch.project, commitLesson);
            }
          }
        }

        if (dispatch.taskId) {
          this.taskQueue.markCompleted(dispatch.taskId);
        }

        // Auto-handoff: if this task was part of a workflow, build handoff for next step
        if (dispatch.workflowId) {
          const handoff = this.buildHandoff(workerId, worker, dispatch);
          const existing = this.workflowHandoffs.get(dispatch.workflowId) || [];
          existing.push(handoff);
          this.workflowHandoffs.set(dispatch.workflowId, existing);
          console.log(`[handoff] ${worker.tty || workerId}: workflow ${dispatch.workflowId} step done → handoff queued`);
        }

        // Completion callback: notify the agent that dispatched this task
        if (dispatch.fromWorkerId) {
          const sender = this.workers.get(dispatch.fromWorkerId);
          if (sender) {
            const receiverName = worker.tty || workerId;
            const senderName = sender.tty || dispatch.fromWorkerId;
            const files = recentArtifacts.map(a => {
              const short = a.path.split("/").slice(-2).join("/");
              return `${short} (${a.action})`;
            });
            const filesSummary = files.length > 0
              ? ` Files changed: ${files.slice(-8).join(", ")}.`
              : " No files changed.";
            const notification = `[Hive] ${receiverName} finished your task: "${dispatch.task}".${filesSummary} Verify their work didn't overwrite or conflict with yours.`;
            this.enqueueMessage(dispatch.fromWorkerId, {
              content: notification,
              source: "dispatch-callback",
            });
            console.log(`[dispatch-callback] ${receiverName} → ${senderName}: task complete, verification queued`);
          }
        }

        this.dispatchedTasks.delete(workerId);
        continue;
      }

      if (Date.now() - dispatch.sentAt > 30 * 60 * 1000) {
        this.dispatchedTasks.delete(workerId);
      }
    }
  }

  private buildHandoff(workerId: string, worker: WorkerState, dispatch: { task: string; project: string; taskId?: string }): string {
    const artifacts = this.getArtifacts(workerId);
    const recentArtifacts = artifacts.filter(a => Date.now() - a.ts < 30 * 60 * 1000);
    const files = recentArtifacts.map(a => {
      const short = a.path.split("/").slice(-2).join("/");
      return `  - ${short} (${a.action})`;
    });

    const lines = [
      `## Handoff from ${worker.tty || workerId}${dispatch.taskId ? ` (${dispatch.taskId})` : ""}`,
      `Completed: ${dispatch.task}`,
    ];
    if (files.length > 0) {
      lines.push("Files modified:");
      lines.push(...files.slice(-10));
    }
    return lines.join("\n");
  }

  writeLearning(project: string, lesson: string): void {
    if (!project) return;
    const claudeDir = join(project, ".claude");
    const learningFile = join(claudeDir, "hive-learnings.md");
    try {
      if (!existsSync(claudeDir)) mkdirSync(claudeDir, { recursive: true });
      const header = !existsSync(learningFile)
        ? "# Hive Learnings\n\nLessons captured automatically. Every agent in this project reads this file.\n\n"
        : "";
      const timestamp = new Date().toISOString().split("T")[0];
      appendFileSync(learningFile, `${header}- [${timestamp}] ${lesson}\n`);
      console.log(`[auto-learn] ${lesson.slice(0, 80)}`);
    } catch { /* non-critical */ }
  }

  // --- Satellite relay (for REST API → satellite worker routing) ---

  private satelliteUpdateFn: ((repoDir?: string) => void) | null = null;
  private capabilityChecker: ((machineId: string, requires: string[]) => boolean) | null = null;
  private capableMachineFinder: ((requires: string[], preferMachine?: string) => string | undefined) | null = null;

  setSatelliteRelay(
    relay: (workerId: string, content: string, from?: string) => Promise<{ ok: boolean; error?: string }>,
    allWorkers: () => WorkerState[],
    updateAll?: (repoDir?: string) => void,
  ): void {
    this.satelliteMessageRelay = relay;
    this.satelliteAllWorkersGetter = allWorkers;
    this.satelliteUpdateFn = updateAll || null;
  }

  /** Register capability-based routing functions from ws-server. */
  setCapabilityRouter(
    checker: (machineId: string, requires: string[]) => boolean,
    finder: (requires: string[], preferMachine?: string) => string | undefined,
  ): void {
    this.capabilityChecker = checker;
    this.capableMachineFinder = finder;
  }

  /** Tell all connected satellites to pull and restart. */
  updateSatellites(repoDir?: string): void {
    if (this.satelliteUpdateFn) this.satelliteUpdateFn(repoDir);
  }

  /** Relay a message to a satellite worker. Returns null if workerId is local. */
  async relaySatelliteMessage(workerId: string, content: string, from?: string): Promise<{ ok: boolean; error?: string } | null> {
    if (!workerId.includes(":") || !this.satelliteMessageRelay) return null;
    return this.satelliteMessageRelay(workerId, content, from);
  }

  /** Get all workers including satellite workers (for REST API). */
  getAllWorkersIncludingSatellites(): WorkerState[] {
    if (this.satelliteAllWorkersGetter) return this.satelliteAllWorkersGetter();
    return this.getAll();
  }

  setSwarmApi(
    projectsGetter: () => { projects: SwarmProjectEntry[] },
    capabilitiesGetter: () => Record<string, MachineCapabilities>,
    spawnHandler: (request: SwarmSpawnRequest) => { ok: boolean; error?: string; [key: string]: unknown },
    killHandler: (workerId: string, fromMachine?: string) => { ok: boolean; error?: string; [key: string]: unknown },
    satelliteMaintenanceHandler?: (machineId: string, action?: string, fromMachine?: string) => { ok: boolean; error?: string; [key: string]: unknown },
  ): void {
    this.swarmProjectsGetter = projectsGetter;
    this.swarmCapabilitiesGetter = capabilitiesGetter;
    this.swarmSpawnHandler = spawnHandler;
    this.swarmKillHandler = killHandler;
    this.swarmSatelliteMaintenanceHandler = satelliteMaintenanceHandler || null;
  }

  getSwarmProjects(): { projects: SwarmProjectEntry[] } {
    if (this.swarmProjectsGetter) return this.swarmProjectsGetter();
    const projects = Object.entries(scanLocalProjects(HOME)).map(([name, path]) => ({
      name,
      path,
      machines: { local: path },
    }));
    return { projects };
  }

  getSwarmCapabilities(): Record<string, MachineCapabilities> {
    if (this.swarmCapabilitiesGetter) return this.swarmCapabilitiesGetter();
    return {
      local: {
        node: true,
        projects: scanLocalProjects(HOME),
      },
    };
  }

  spawnViaSwarm(request: SwarmSpawnRequest): { ok: boolean; error?: string; [key: string]: unknown } {
    if (!this.swarmSpawnHandler) return { ok: false, error: "Spawn control not available" };
    return this.swarmSpawnHandler(request);
  }

  killViaSwarm(workerId: string, fromMachine?: string): { ok: boolean; error?: string; [key: string]: unknown } {
    if (!this.swarmKillHandler) return { ok: false, error: "Kill control not available" };
    return this.swarmKillHandler(workerId, fromMachine);
  }

  maintainSatelliteViaSwarm(machineId: string, action?: string, fromMachine?: string): { ok: boolean; error?: string; [key: string]: unknown } {
    if (!this.swarmSatelliteMaintenanceHandler) return { ok: false, error: "Satellite maintenance control not available" };
    return this.swarmSatelliteMaintenanceHandler(machineId, action, fromMachine);
  }

  private getWorkerSnapshot(workerId: string): WorkerState | undefined {
    return this.workers.get(workerId) || this.satelliteAllWorkersGetter?.().find((worker) => worker.id === workerId);
  }

  private isRemoteWorker(workerId: string, worker?: WorkerState): boolean {
    return !!worker?.machine || workerId.includes(":");
  }

  private resolveProjectForMachine(project: string, machine?: string): string {
    if (!project) return project;
    const normalizedMachine = machine || "local";
    const normalizedProject = project.startsWith("~/")
      ? join(HOME, project.slice(2))
      : project;
    const projectName = basename(normalizedProject);
    for (const entry of this.getSwarmProjects().projects) {
      if (
        entry.name === project ||
        entry.name === projectName ||
        entry.path === normalizedProject ||
        entry.machines?.local === normalizedProject ||
        Object.values(entry.machines || {}).includes(normalizedProject)
      ) {
        return entry.machines?.[normalizedMachine] || entry.path || normalizedProject;
      }
    }
    return normalizedProject;
  }

  private workerMatchesProject(worker: WorkerState, taskProject?: string): boolean {
    if (!taskProject) return true;
    const resolvedProject = this.resolveProjectForMachine(taskProject, worker.machine);
    return worker.project === resolvedProject
      || worker.project.startsWith(resolvedProject + "/")
      || worker.project.includes(taskProject)
      || worker.projectName === taskProject
      || worker.projectName === basename(taskProject);
  }

  // Satellite context relay: registered by ws-server
  private satelliteContextRelay: ((workerId: string, options: { includeHistory?: boolean; historyLimit?: number }) => Promise<unknown>) | null = null;

  setSatelliteContextRelay(relay: (workerId: string, options: { includeHistory?: boolean; historyLimit?: number }) => Promise<unknown>): void {
    this.satelliteContextRelay = relay;
  }

  /** Get context for a worker, transparently relaying to satellite if needed. */
  async getWorkerContextAsync(workerId: string, options: { includeHistory?: boolean; historyLimit?: number } = {}): Promise<unknown> {
    const local = this.getWorkerContext(workerId, options);
    if (local) return local;
    if (workerId.includes(":") && this.satelliteContextRelay) {
      return this.satelliteContextRelay(workerId, options);
    }
    return null;
  }

  // --- Auto-commit ---

  onAutoCommit(listener: (workerId: string, project: string, files: string[], message: string) => void): void {
    this.autoCommitListeners.push(listener);
  }

  /**
   * Auto-commit artifacts after a dispatched task completes.
   * Only commits files that were created or edited (not read).
   * Returns the commit hash on success, or null on failure.
   */
  autoCommitArtifacts(workerId: string, project: string, taskDescription: string): string | null {
    const artifacts = this.getArtifacts(workerId);
    const committableFiles = artifacts
      .filter(a => Date.now() - a.ts < 30 * 60 * 1000)
      .filter(a => a.action === "created" || a.action === "edited" || a.action === "wrote")
      .map(a => a.path);

    if (committableFiles.length === 0) {
      console.log(`[auto-commit] ${workerId}: no committable artifacts, skipping`);
      return null;
    }

    // Deduplicate
    const uniqueFiles = [...new Set(committableFiles)];

    // Execute git commands locally
    try {
      const { execFileSync } = require("child_process");

      // Check if project is a git repo
      try {
        execFileSync("/usr/bin/git", ["rev-parse", "--git-dir"], {
          cwd: project,
          encoding: "utf-8",
          timeout: 3000,
        });
      } catch {
        console.log(`[auto-commit] ${workerId}: ${project} is not a git repo, skipping`);
        return null;
      }

      // Stage only the specific artifact files
      const existingFiles = uniqueFiles.filter(f => existsSync(f));
      if (existingFiles.length === 0) {
        console.log(`[auto-commit] ${workerId}: no artifact files exist on disk, skipping`);
        return null;
      }

      execFileSync("/usr/bin/git", ["add", ...existingFiles], {
        cwd: project,
        encoding: "utf-8",
        timeout: 10_000,
      });

      // Check if there's anything staged
      const staged = execFileSync("/usr/bin/git", ["diff", "--cached", "--name-only"], {
        cwd: project,
        encoding: "utf-8",
        timeout: 5_000,
      }).trim();

      if (!staged) {
        console.log(`[auto-commit] ${workerId}: nothing staged after git add, skipping`);
        return null;
      }

      // Build commit message
      const shortTask = taskDescription.slice(0, 100);
      const fileNames = existingFiles.map(f => basename(f)).join(", ");
      const commitMsg = `${shortTask}\n\nFiles: ${fileNames}\n\nAuto-committed by Hive after task completion.`;

      execFileSync("/usr/bin/git", ["commit", "-m", commitMsg, "--no-verify"], {
        cwd: project,
        encoding: "utf-8",
        timeout: 15_000,
      });

      // Get the commit hash
      const hash = execFileSync("/usr/bin/git", ["rev-parse", "--short", "HEAD"], {
        cwd: project,
        encoding: "utf-8",
        timeout: 3000,
      }).trim();

      console.log(`[auto-commit] ${workerId}: committed ${existingFiles.length} file(s) → ${hash}`);

      // Auto-push to keep repos in sync across machines
      try {
        execFileSync("/usr/bin/git", ["push"], {
          cwd: project,
          encoding: "utf-8",
          timeout: 30_000,
        });
        console.log(`[auto-commit] ${workerId}: pushed to remote`);
      } catch (pushErr) {
        console.log(`[auto-commit] ${workerId}: push failed (commit preserved) — ${pushErr instanceof Error ? pushErr.message : pushErr}`);
      }

      return hash;
    } catch (err) {
      console.log(`[auto-commit] ${workerId}: git commit failed — ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  // --- Signal timeline ---

  recordSignal(workerId: string, signal: string, detail: string): void {
    if (!this.signals.has(workerId)) {
      this.signals.set(workerId, []);
    }
    const buf = this.signals.get(workerId)!;
    buf.push({ ts: Date.now(), signal, detail });
    if (buf.length > TelemetryReceiver.MAX_SIGNALS) {
      buf.splice(0, buf.length - TelemetryReceiver.MAX_SIGNALS);
    }
  }

  getSignals(workerId?: string): Record<string, Array<{ ts: number; signal: string; detail: string }>> {
    if (workerId) {
      return { [workerId]: this.signals.get(workerId) || [] };
    }
    const all: Record<string, Array<{ ts: number; signal: string; detail: string }>> = {};
    for (const [id, buf] of this.signals) {
      if (buf.length > 0) all[id] = buf;
    }
    return all;
  }

  // --- Worker lifecycle ---

  registerWorker(id: string, pid: number, project: string, task: string | null): WorkerState {
    const projectName = project.split("/").pop() || project;
    const now = Date.now();
    const worker: WorkerState = {
      id, pid, project, projectName,
      status: "working", currentAction: null, lastAction: "spawned",
      lastActionAt: now, errorCount: 0, startedAt: now, task, managed: true,
    };
    this.workers.set(id, worker);
    this.notify(worker);
    return worker;
  }

  registerDiscovered(id: string, worker: WorkerState): void {
    this.workers.set(id, worker);
    if (!this.lastHookTime.has(id)) {
      this.lastHookTime.set(id, Date.now());
    }

    // Replay pending register-tty corrections queued before discovery.
    // identity.sh may fire before the daemon's first scan discovers the worker.
    // Skip for Codex workers: pending registrations come from Claude's identity.sh
    // hook which never fires for Codex. Any pending registration for a Codex worker's
    // TTY is stale from a previous Claude session on that same TTY.
    if (worker.tty && worker.model !== "codex") {
      const pendingSession = this.pendingTtyRegistrations.get(worker.tty);
      if (pendingSession) {
        console.log(`[register-tty] Replaying queued correction: tty=${worker.tty} session=${pendingSession} → ${id}`);
        this.pinnedSessions.set(pendingSession, id);
        this.sessionToWorker.set(pendingSession, id);

        // Set the session file
        const homeDir = process.env.HOME || `/Users/${process.env.USER}`;
        const projectsDir = join(homeDir, ".claude", "projects");
        const encodings = [
          worker.project.replace(/\//g, "-"),
          (homeDir).replace(/\//g, "-"),
        ];
        for (const encoded of encodings) {
          const candidateFile = join(projectsDir, encoded, `${pendingSession}.jsonl`);
          if (existsSync(candidateFile)) {
            this.streamer?.setSessionFile(id, candidateFile);
            break;
          }
        }
        this.pendingTtyRegistrations.delete(worker.tty);
        this.replayPendingHooks(pendingSession, id);
      }
    }

    this.notify(worker);
  }

  /** Register a discovered worker WITHOUT broadcasting a worker_update.
   *  Used when atomically replacing a placeholder — the caller handles the broadcast. */
  registerDiscoveredSilent(id: string, worker: WorkerState): void {
    this.workers.set(id, worker);
    if (!this.lastHookTime.has(id)) {
      this.lastHookTime.set(id, Date.now());
    }
    // Replay pending register-tty corrections (same as registerDiscovered)
    if (worker.tty && worker.model !== "codex") {
      const pendingSession = this.pendingTtyRegistrations.get(worker.tty);
      if (pendingSession) {
        console.log(`[register-tty] Replaying queued correction: tty=${worker.tty} session=${pendingSession} → ${id}`);
        this.pinnedSessions.set(pendingSession, id);
        this.sessionToWorker.set(pendingSession, id);
        const homeDir = process.env.HOME || `/Users/${process.env.USER}`;
        const projectsDir = join(homeDir, ".claude", "projects");
        const encodings = [
          worker.project.replace(/\//g, "-"),
          (homeDir).replace(/\//g, "-"),
        ];
        for (const encoded of encodings) {
          const candidateFile = join(projectsDir, encoded, `${pendingSession}.jsonl`);
          if (existsSync(candidateFile)) {
            this.streamer?.setSessionFile(id, candidateFile);
            break;
          }
        }
        this.pendingTtyRegistrations.delete(worker.tty);
        this.replayPendingHooks(pendingSession, id);
      }
    }
    // No notify() — caller will broadcast
  }

  private fullBroadcastListeners: Array<() => void> = [];

  /** Register a callback for forced full-state broadcasts. */
  onFullBroadcast(callback: () => void): void {
    this.fullBroadcastListeners.push(callback);
  }

  /** Force a full workers broadcast to all dashboard clients.
   *  Used after atomic placeholder→real worker swap. */
  forceFullBroadcast(): void {
    for (const cb of this.fullBroadcastListeners) {
      cb();
    }
  }

  removeWorker(id: string): void {
    this.silentRemoveWorker(id);
    for (const cb of this.removalListeners) {
      cb(id);
    }
  }

  /** Remove a worker without triggering removal listeners (no WS broadcast).
   *  Used when atomically replacing a placeholder with a real worker. */
  silentRemoveWorker(id: string): void {
    const trackedDispatch = this.dispatchedTasks.get(id);
    if (trackedDispatch?.taskId) {
      this.taskQueue.requeueRunningTask(id);
    }
    this.dispatchedTasks.delete(id);
    this.workers.delete(id);
    this.messageQueue.delete(id);
    this.lastHookTime.delete(id);
    this.toolInFlight.delete(id);
    this.idleConfirmed.delete(id);
    this.lastInputSent.delete(id);
    this.lockManager.releaseAll(id);
    this.quadrantAssignments.delete(id);
    for (const [sid, wid] of this.sessionToWorker) {
      if (wid === id) {
        this.sessionToWorker.delete(sid);
        this.pendingHooks.delete(sid);
      }
    }
  }

  get(id: string): WorkerState | undefined {
    return this.workers.get(id);
  }

  getAll(): WorkerState[] {
    return Array.from(this.workers.values());
  }

  // Position-driven quadrant assignments: worker_id → slot (1-4).
  // Updated continuously from physical Terminal window positions.
  private quadrantAssignments = new Map<string, number>();
  private lastPositionDetect = 0;
  // Cache: context summaries per worker, invalidated when worker state changes
  private contextCache = new Map<string, { fingerprint: string; context: WorkerContextSnapshot }>();
  private static POSITION_DETECT_INTERVAL = 1_500; // 1.5s — fast snap-back detection

  writeWorkersFile(): void {
    const workers = this.getAll().sort((a, b) => a.startedAt - b.startedAt);

    // Remove dead workers from assignments, then compact: re-number
    // sequentially so closing a terminal shifts everyone back one.
    // Q1, Q2, Q3 → close Q2 → Q1, Q2 (not Q1, Q3).
    for (const id of this.quadrantAssignments.keys()) {
      if (!this.workers.has(id)) this.quadrantAssignments.delete(id);
    }
    // Compact: sort remaining assignments by current slot, re-assign 1..N
    const assigned = [...this.quadrantAssignments.entries()]
      .sort((a, b) => a[1] - b[1]);
    let nextSlot = 1;
    for (const [id, oldSlot] of assigned) {
      if (oldSlot !== nextSlot) {
        this.quadrantAssignments.set(id, nextSlot);
      }
      nextSlot++;
    }

    // Fire off async position detection (throttled to every 3s).
    // Results apply on the NEXT writeWorkersFile() cycle via callback.
    const now = Date.now();
    const workersWithTty = workers.filter(w => w.tty);
    if (workersWithTty.length > 0 && now - this.lastPositionDetect >= TelemetryReceiver.POSITION_DETECT_INTERVAL) {
      this.lastPositionDetect = now;
      // Snapshot worker IDs+TTYs for the callback closure
      const workerSnapshot = workersWithTty.map(w => ({ id: w.id, tty: w.tty! }));
      const allWorkerSnapshot = workers.map(w => ({ id: w.id }));

      detectQuadrantsFromWindowPositions(
        workerSnapshot.map(w => w.tty),
        (positionMap, rawSlots) => {
          if (positionMap.size === 0) return;

          // Sticky assignments: existing workers keep their slots.
          // Position detection only assigns slots to NEW workers (those without an assignment).
          const usedSlots = new Set(this.quadrantAssignments.values());
          let changed = false;

          // Only assign position-based slots to workers that don't have one yet
          for (const w of workerSnapshot) {
            if (this.quadrantAssignments.has(w.id)) continue; // already assigned, keep it
            const posQ = positionMap.get(w.tty);
            if (posQ && !usedSlots.has(posQ)) {
              this.quadrantAssignments.set(w.id, posQ);
              usedSlots.add(posQ);
              changed = true;
            }
          }

          // Snap-back: use rawSlots (natural position without collision resolution)
          // to detect drift. The collision-resolved positionMap can mask drift when
          // a dragged window overlaps another — the free-slot fallback happens to
          // match the original assignment, hiding the actual position mismatch.
          const driftMap = rawSlots || positionMap;
          let drifted = false;
          for (const w of workerSnapshot) {
            const assignedQ = this.quadrantAssignments.get(w.id);
            const detectedQ = driftMap.get(w.tty);
            if (assignedQ && detectedQ && assignedQ !== detectedQ) {
              console.log(`[snap-back] Drift: ${w.tty} assigned=Q${assignedQ} actual=Q${detectedQ}`);
              drifted = true;
              break;
            }
          }
          if (drifted) {
            resetArrangementCache();
            this.forceRearrange();
          }

          if (changed) {
            this.writeWorkersFile();
          }
        },
      );
    }

    // Fallback: assign any still-unassigned workers to lowest available slot
    const usedSlots = new Set(this.quadrantAssignments.values());
    for (const w of workers) {
      if (this.quadrantAssignments.has(w.id)) continue;
      for (let slot = 1; slot <= 8; slot++) {
        if (!usedSlots.has(slot)) {
          this.quadrantAssignments.set(w.id, slot);
          usedSlots.add(slot);
          break;
        }
      }
    }

    // Stamp each WorkerState with its quadrant so WebSocket broadcasts include it.
    // This is the single source of truth — dashboard uses this instead of computing its own.
    for (const w of workers) {
      const q = this.quadrantAssignments.get(w.id);
      w.quadrant = q; // undefined if >8 workers
    }

    // Use cached contexts — only rebuild when worker state changes.
    // This avoids reading full JSONL files (can be hundreds of MB) every 3s.
    const contexts: WorkerContextSnapshot[] = [];
    for (const worker of workers) {
      const fp = `${worker.lastActionAt}|${worker.status}|${worker.quadrant}|${worker.lastDirection?.slice(0, 50)}`;
      const cached = this.contextCache.get(worker.id);
      if (cached && cached.fingerprint === fp) {
        contexts.push(cached.context);
      } else {
        const ctx = this.getWorkerContext(worker.id, { historyLimit: 6, artifactLimit: 5 });
        if (ctx) {
          this.contextCache.set(worker.id, { fingerprint: fp, context: ctx });
          contexts.push(ctx);
        }
      }
    }
    // Prune dead workers from cache
    for (const id of this.contextCache.keys()) {
      if (!this.workers.has(id)) this.contextCache.delete(id);
    }
    const contextsByWorker = new Map(contexts.map((context) => [context.workerId, context]));

    const slots: Array<{
      quadrant: number; id: string; pid: number; tty: string | undefined;
      project: string; projectName: string; status: string;
      currentAction: string | null; lastAction: string; startedAt: number;
      model: string; machine?: string; machineLabel?: string; lastDirection?: string; contextSummary?: string;
    }> = [];
    for (const w of workers) {
      const q = this.quadrantAssignments.get(w.id);
      if (!q) continue; // more than 8 workers
      const context = contextsByWorker.get(w.id);
      slots.push({
        quadrant: q, id: w.id, pid: w.pid, tty: w.tty,
        project: w.project, projectName: w.projectName, status: w.status,
        currentAction: w.currentAction, lastAction: w.lastAction, startedAt: w.startedAt,
        model: w.model || "claude",
        machine: "local",
        machineLabel: LOCAL_MACHINE_LABEL,
        lastDirection: w.lastDirection,
        contextSummary: context?.contextSummary,
      });
    }
    slots.sort((a, b) => a.quadrant - b.quadrant);

    // Merge satellite workers so the primary's identity hook shows cross-machine peers
    const allSlots = [...slots, ...this.satelliteSlots];

    try {
      const hiveDir = join(HOME, ".hive");
      if (!existsSync(hiveDir)) mkdirSync(hiveDir, { recursive: true });
      writeFileSync(
        join(hiveDir, "workers.json"),
        JSON.stringify({ updatedAt: Date.now(), workers: allSlots }, null, 2) + "\n"
      );
      writeFileSync(
        join(hiveDir, "contexts.json"),
        JSON.stringify({ updatedAt: Date.now(), workers: contexts }, null, 2) + "\n"
      );
    } catch { /* non-critical */ }

    // Arrange terminal windows to match quadrant assignments.
    // arrangeTerminalWindows both sets titles AND moves windows to correct positions.
    // It has internal fingerprint caching so redundant calls are skipped.
    const arrangeSlots = slots
      .filter(s => s.tty)
      .map(s => ({
        quadrant: s.quadrant,
        tty: s.tty!,
        projectName: s.projectName,
        model: s.model,
      }));
    arrangeTerminalWindows(arrangeSlots);
  }

  /** Force rearrange terminal windows (resets cache and fires immediately). */
  forceRearrange(): void {
    resetArrangementCache();
    const slots = [...this.quadrantAssignments.entries()]
      .map(([workerId, q]) => {
        const w = this.workers.get(workerId);
        if (!w?.tty) return null;
        return { quadrant: q, tty: w.tty, projectName: w.projectName, model: w.model || "claude" };
      })
      .filter((s): s is NonNullable<typeof s> => s !== null);
    if (slots.length > 0) arrangeTerminalWindows(slots);
  }

  /** Returns the lowest slot (1-8) not currently assigned, or undefined if full. */
  getFirstOpenQuadrant(): number | undefined {
    const used = new Set(this.quadrantAssignments.values());
    for (let q = 1; q <= 8; q++) {
      if (!used.has(q)) return q;
    }
    return undefined;
  }

  onUpdate(callback: (workerId: string, state: WorkerState) => void): void {
    this.listeners.push(callback);
  }

  onRemoval(callback: (workerId: string) => void): void {
    this.removalListeners.push(callback);
  }

  // --- Tick loop ---

  tick(): void {
    const now = Date.now();
    for (const worker of this.workers.values()) {
      if (worker.status === "working" && now - worker.lastActionAt > IDLE_THRESHOLD) {
        try {
          process.kill(worker.pid, 0);
          continue;
        } catch {
          this.toolInFlight.set(worker.id, null);
        }
        worker.status = "idle";
        worker.currentAction = null;
        this.lockManager.releaseAll(worker.id);
        this.generateSuggestions(worker);
        this.notify(worker);
      }
    }
    this.checkCompletedDispatches();
    this.drainQueues();
    this.dispatchFromQueue();
    this.expirePendingHooks();
    this.scratchpad.expire();
    this.reviewStore.expire();
  }

  notifyExternal(worker: WorkerState): void {
    this.notify(worker);
  }

  markWorkerIdle(workerId: string, lastAction?: string): void {
    const worker = this.workers.get(workerId);
    if (!worker) return;
    worker.status = "idle";
    worker.currentAction = null;
    worker.stuckMessage = undefined;
    worker.lastActionAt = Date.now();
    if (lastAction) worker.lastAction = lastAction;
    this.idleConfirmed.set(workerId, false);
    this.lockManager.releaseAll(workerId);
    this.generateSuggestions(worker);
    this.notify(worker);
  }

  /** Trigger LLM suggestion generation for an idle worker */
  private generateSuggestions(worker: WorkerState): void {
    if (!this.suggestionEngine.isEnabled()) return;
    const artifacts = this.getArtifacts(worker.id);
    this.suggestionEngine.generate(worker, artifacts, (suggestions) => {
      // Only apply if the worker is still idle
      const current = this.workers.get(worker.id);
      if (current && current.status === "idle") {
        current.suggestions = suggestions;
        this.notify(current);
      }
    });
  }

  /** Clear suggestions when a worker starts working.
   *  Records skips for any shown suggestions that weren't applied. */
  private clearSuggestions(workerId: string): void {
    const worker = this.workers.get(workerId);
    if (worker?.suggestions && worker.suggestions.length > 0) {
      // Phase 4: record skips for all shown suggestions (none were applied via the button)
      this.suggestionEngine.recordSkipAll(
        worker.suggestions.map((s) => s.label),
        worker.project
      );
      worker.suggestions = undefined;
      this.suggestionEngine.clear(workerId);
    }
  }

  /** Phase 4: Record that a suggestion was applied from the dashboard */
  recordSuggestionFeedback(workerId: string, appliedLabel: string, shownLabels: string[]): void {
    const worker = this.workers.get(workerId);
    this.suggestionEngine.recordApply(appliedLabel, shownLabels, worker?.project);
  }

  // --- Message queue ---

  sendToWorker(
    workerId: string,
    content: string,
    options: {
      source: string;
      lastAction?: string;
      queueIfBusy?: boolean;
      withIdentity?: boolean;
      markDashboardInput?: boolean;
      trackDispatch?: boolean;
      taskBrief?: string;
      taskId?: string;
      workflowId?: string;
      fromWorkerId?: string;
      contextWorkerIds?: string[];
      includeSenderContext?: boolean;
      verify?: boolean;
      maxVerifyAttempts?: number;
      autoCommit?: boolean;
    },
  ): { ok: true; queued?: boolean; id?: string; position?: number } | { ok: false; error: string } {
    const worker = this.getWorkerSnapshot(workerId);
    if (!worker) {
      return { ok: false, error: `Worker ${workerId} not found` };
    }
    const remoteWorker = this.isRemoteWorker(workerId, worker) && !this.workers.has(workerId);

    const contentWithContext = this.composeMessageWithContext(workerId, content, {
      fromWorkerId: options.fromWorkerId,
      contextWorkerIds: options.contextWorkerIds,
      includeSenderContext: options.includeSenderContext,
    });
    const deliverableContent = worker.tty && !remoteWorker
      ? this.prepareTtyPayload(worker, contentWithContext)
      : contentWithContext;

    let payload = deliverableContent;
    if (options.withIdentity && worker.tty) {
      const q = worker.quadrant;
      const identity = q ? `[You are Q${q}, ${worker.tty}, ${worker.model || "claude"}] ` : "";
      payload = identity + deliverableContent;
    }

    if (options.queueIfBusy !== false && worker.status === "working") {
      const id = this.enqueueMessage(workerId, {
        content,
        source: options.source,
        withIdentity: options.withIdentity,
        lastAction: options.lastAction,
        markDashboardInput: options.markDashboardInput,
        trackDispatch: options.trackDispatch,
        taskBrief: options.taskBrief,
        taskId: options.taskId,
        workflowId: options.workflowId,
        fromWorkerId: options.fromWorkerId,
        contextWorkerIds: options.contextWorkerIds,
        includeSenderContext: options.includeSenderContext,
        verify: options.verify,
        maxVerifyAttempts: options.maxVerifyAttempts,
        autoCommit: options.autoCommit,
      });
      return {
        ok: true,
        queued: true,
        id,
        position: this.getMessageQueueSize(workerId),
      };
    }

    let error: string | undefined;
    if (remoteWorker) {
      if (!this.satelliteMessageRelay) {
        error = `No satellite relay registered for ${workerId}`;
      } else {
        this.satelliteMessageRelay(workerId, payload, options.source).catch((err) => {
          console.log(`[satellite-message] ${workerId}: ${err instanceof Error ? err.message : err}`);
        });
      }
    } else if (worker.managed) {
      if (!this.processManager) {
        error = `Worker ${workerId} is managed, but no process manager is registered`;
      } else {
        const result = this.processManager.sendMessage(workerId, payload);
        if (result.status === "busy") {
          if (options.queueIfBusy !== false) {
            const id = this.enqueueMessage(workerId, {
              content,
              source: options.source,
              withIdentity: options.withIdentity,
              lastAction: options.lastAction,
              markDashboardInput: options.markDashboardInput,
              trackDispatch: options.trackDispatch,
              taskBrief: options.taskBrief,
              taskId: options.taskId,
              workflowId: options.workflowId,
              fromWorkerId: options.fromWorkerId,
              contextWorkerIds: options.contextWorkerIds,
              includeSenderContext: options.includeSenderContext,
              verify: options.verify,
              maxVerifyAttempts: options.maxVerifyAttempts,
            });
            return {
              ok: true,
              queued: true,
              id,
              position: this.getMessageQueueSize(workerId),
            };
          }
          error = `Worker ${workerId} is busy`;
        } else if (result.status === "not_found") {
          error = `Worker ${workerId} not found`;
        } else if (result.status === "error") {
          error = result.error;
        }
      }
    } else if (worker.tty) {
      const result = sendInputToTty(worker.tty, payload);
      if (!result.ok) {
        error = result.error || `Failed to send to ${worker.tty}`;
      }
    } else {
      error = `Worker ${workerId} has no available input route`;
    }

    if (error) {
      return { ok: false, error };
    }

    if (!remoteWorker) {
      worker.status = "working";
      worker.currentAction = "Thinking...";
      worker.lastAction = options.lastAction || "Received message";
      worker.lastActionAt = Date.now();
      worker.stuckMessage = undefined;
      this.idleConfirmed.set(workerId, false);
      if (options.markDashboardInput) this.markDashboardInput(workerId);
      this.markInputSent(workerId, options.source);
    }
    if (options.trackDispatch) {
      this.trackDispatch(
        workerId,
        options.taskBrief || content.slice(0, 200),
        options.taskId,
        options.workflowId,
        options.fromWorkerId,
        options.verify,
        options.maxVerifyAttempts,
        options.autoCommit,
      );
    }
    if (!remoteWorker) this.notifyExternal(worker);
    return { ok: true };
  }

  /**
   * Async version of sendToWorker — does NOT block the event loop for TTY sends.
   * Use from WebSocket/API handlers where blocking kills responsiveness.
   * State is updated optimistically before the async send completes.
   */
  async sendToWorkerAsync(
    workerId: string,
    content: string,
    options: {
      source: string;
      lastAction?: string;
      queueIfBusy?: boolean;
      withIdentity?: boolean;
      markDashboardInput?: boolean;
      trackDispatch?: boolean;
      taskBrief?: string;
      taskId?: string;
      workflowId?: string;
      fromWorkerId?: string;
      contextWorkerIds?: string[];
      includeSenderContext?: boolean;
      verify?: boolean;
      maxVerifyAttempts?: number;
      autoCommit?: boolean;
    },
  ): Promise<{ ok: true; queued?: boolean; id?: string; position?: number } | { ok: false; error: string }> {
    const worker = this.getWorkerSnapshot(workerId);
    if (!worker) {
      return { ok: false, error: `Worker ${workerId} not found` };
    }
    const remoteWorker = this.isRemoteWorker(workerId, worker) && !this.workers.has(workerId);

    // Auto-pull before delivering messages from API/dashboard so the agent
    // works on the latest code. Same pattern as task queue dispatch.
    // Skips internal sources (auto-pilot, task-queue — queue already pulls).
    if (!remoteWorker && worker.project && !options.source.startsWith("auto-pilot") && options.source !== "task-queue") {
      try {
        const { execFile: gitPull } = require("child_process");
        gitPull("/usr/bin/git", ["pull", "--ff-only", "--no-edit"], {
          cwd: worker.project,
          encoding: "utf-8",
          timeout: 15_000,
        });
      } catch { /* not a git repo or no remote — skip */ }
    }

    const contentWithContext = this.composeMessageWithContext(workerId, content, {
      fromWorkerId: options.fromWorkerId,
      contextWorkerIds: options.contextWorkerIds,
      includeSenderContext: options.includeSenderContext,
    });
    const deliverableContent = worker.tty && !remoteWorker
      ? this.prepareTtyPayload(worker, contentWithContext)
      : contentWithContext;

    let payload = deliverableContent;
    if (options.withIdentity && worker.tty) {
      const q = worker.quadrant;
      const identity = q ? `[You are Q${q}, ${worker.tty}, ${worker.model || "claude"}] ` : "";
      payload = identity + deliverableContent;
    }

    if (options.queueIfBusy !== false && worker.status === "working") {
      const id = this.enqueueMessage(workerId, {
        content,
        source: options.source,
        withIdentity: options.withIdentity,
        lastAction: options.lastAction,
        markDashboardInput: options.markDashboardInput,
        trackDispatch: options.trackDispatch,
        taskBrief: options.taskBrief,
        taskId: options.taskId,
        workflowId: options.workflowId,
        fromWorkerId: options.fromWorkerId,
        contextWorkerIds: options.contextWorkerIds,
        includeSenderContext: options.includeSenderContext,
        autoCommit: options.autoCommit,
      });
      return {
        ok: true,
        queued: true,
        id,
        position: this.getMessageQueueSize(workerId),
      };
    }

    // Optimistically update state BEFORE async send — dashboard sees
    // the worker go green immediately, no waiting for AppleScript.
    if (!remoteWorker) {
      worker.status = "working";
      worker.currentAction = "Thinking...";
      worker.lastAction = options.lastAction || "Received message";
      worker.lastActionAt = Date.now();
      worker.stuckMessage = undefined;
      this.idleConfirmed.set(workerId, false);
      if (options.markDashboardInput) this.markDashboardInput(workerId);
      this.markInputSent(workerId, options.source);
    }
    if (options.trackDispatch) {
      this.trackDispatch(
        workerId,
        options.taskBrief || content.slice(0, 200),
        options.taskId,
        options.workflowId,
        options.fromWorkerId,
        options.verify,
        options.maxVerifyAttempts,
        options.autoCommit,
      );
    }
    if (!remoteWorker) this.notifyExternal(worker);

    // Now do the actual send without blocking
    let error: string | undefined;
    if (remoteWorker) {
      if (!this.satelliteMessageRelay) {
        error = `No satellite relay registered for ${workerId}`;
      } else {
        const result = await this.satelliteMessageRelay(workerId, payload, options.source);
        if (!result.ok) {
          error = result.error || `Failed to relay to ${workerId}`;
        }
      }
    } else if (worker.managed) {
      if (!this.processManager) {
        error = `Worker ${workerId} is managed, but no process manager is registered`;
      } else {
        const result = this.processManager.sendMessage(workerId, payload);
        if (result.status === "error") {
          error = result.error;
        } else if (result.status === "not_found") {
          error = `Worker ${workerId} not found`;
        }
      }
    } else if (worker.tty) {
      const result = await sendInputToTtyAsync(worker.tty, payload, worker.model);
      if (!result.ok) {
        error = result.error || `Failed to send to ${worker.tty}`;
      }
    } else {
      error = `Worker ${workerId} has no available input route`;
    }

    if (error) {
      console.log(`[send-async] Error sending to ${workerId}: ${error}`);
      // State was already updated optimistically — status detection will
      // self-correct if the message truly didn't arrive.
      return { ok: false, error };
    }

    return { ok: true };
  }

  enqueueMessage(workerId: string, message: Omit<QueuedMessage, "id" | "queuedAt">): string {
    if (!this.messageQueue.has(workerId)) {
      this.messageQueue.set(workerId, []);
    }
    const id = `m${++this.messageIdCounter}`;
    this.messageQueue.get(workerId)!.push({ ...message, id, queuedAt: Date.now() });
    return id;
  }

  cancelMessage(messageId: string): boolean {
    for (const [workerId, queue] of this.messageQueue) {
      const idx = queue.findIndex(m => m.id === messageId);
      if (idx !== -1) {
        queue.splice(idx, 1);
        if (queue.length === 0) this.messageQueue.delete(workerId);
        return true;
      }
    }
    return false;
  }

  getMessageQueueSize(workerId: string): number {
    return (this.messageQueue.get(workerId) || []).length;
  }

  getMessageQueueSizes(): Record<string, number> {
    const result: Record<string, number> = {};
    for (const [id, queue] of this.messageQueue) {
      if (queue.length > 0) result[id] = queue.length;
    }
    return result;
  }

  getMessageQueueDetails(): Record<string, Array<{ id: string; preview: string; source: string; queuedAt: number }>> {
    const result: Record<string, Array<{ id: string; preview: string; source: string; queuedAt: number }>> = {};
    for (const [wid, queue] of this.messageQueue) {
      if (queue.length > 0) {
        result[wid] = queue.map(m => ({
          id: m.id, preview: m.content.slice(0, 100), source: m.source, queuedAt: m.queuedAt,
        }));
      }
    }
    return result;
  }

  private drainQueues(): void {
    for (const [workerId, queue] of this.messageQueue) {
      if (queue.length === 0) continue;
      const worker = this.getWorkerSnapshot(workerId);
      if (!worker || worker.status !== "idle") continue;

      const msg = queue.shift()!;
      if (Date.now() - msg.queuedAt > 30 * 60 * 1000) {
        console.log(`[queue] ${worker.tty}: dropped stale ${msg.id} (queued ${Math.round((Date.now() - msg.queuedAt) / 60000)}m ago)`);
        continue;
      }

      const result = this.sendToWorker(workerId, msg.content, {
        source: msg.source,
        queueIfBusy: false,
        withIdentity: msg.withIdentity,
        lastAction: msg.lastAction || `Queued message (${msg.source})`,
        markDashboardInput: msg.markDashboardInput,
        trackDispatch: msg.trackDispatch ?? true,
        taskBrief: msg.taskBrief || msg.content.slice(0, 200),
        taskId: msg.taskId,
        workflowId: msg.workflowId,
        fromWorkerId: msg.fromWorkerId,
        contextWorkerIds: msg.contextWorkerIds,
        includeSenderContext: msg.includeSenderContext,
        verify: msg.verify,
        maxVerifyAttempts: msg.maxVerifyAttempts,
        autoCommit: msg.autoCommit,
      });
      if (result.ok && !result.queued) {
        console.log(`[queue] ${worker.tty}: drained ${msg.id} (${queue.length} remaining)`);
      } else {
        queue.unshift(msg);
        if (!result.ok) {
          console.log(`[queue] ${worker.tty || worker.id}: failed to drain ${msg.id} — ${result.error}`);
        }
      }
      break;
    }
  }

  /** Set satellite worker slots for inclusion in workers.json (called by ws-server). */
  setSatelliteSlots(slots: typeof this.satelliteSlots): void {
    this.satelliteSlots = slots;
  }

  /** Re-queue a satellite worker's task when it dies. Returns the re-queued task or undefined.
   *  Called by ws-server when a satellite reports a worker gone from its previous report. */
  requeueSatelliteTask(prefixedWorkerId: string): { id: string; task: string } | undefined {
    const dispatch = this.dispatchedTasks.get(prefixedWorkerId);
    if (dispatch?.taskId) {
      const requeued = this.taskQueue.requeueRunningTask(prefixedWorkerId);
      this.dispatchedTasks.delete(prefixedWorkerId);
      if (requeued) return { id: requeued.id, task: requeued.task };
    }
    this.dispatchedTasks.delete(prefixedWorkerId);
    return undefined;
  }

  // --- Task queue facade ---

  pushTask(task: string, project?: string, priority?: number, blockedBy?: string, workflowId?: string, verify?: boolean, maxVerifyAttempts?: number, autoCommit?: boolean, requires?: string[], preferMachine?: string, model?: string): QueuedTask {
    return this.taskQueue.push(task, project, priority, blockedBy, workflowId, verify, maxVerifyAttempts, autoCommit, requires, preferMachine, model);
  }

  removeTask(taskId: string): boolean {
    return this.taskQueue.remove(taskId);
  }

  getTaskQueue(): QueuedTask[] {
    return this.taskQueue.getAll();
  }

  getTaskQueueLength(): number {
    return this.taskQueue.length;
  }

  private buildContextBrief(targetWorkerId: string, taskProject?: string): string {
    const lines: string[] = [];
    const others = this.getAllWorkersIncludingSatellites().filter(w => w.id !== targetWorkerId);
    const resolvedLocalProject = taskProject ? this.resolveProjectForMachine(taskProject, "local") : undefined;

    const active = others.filter(w => w.status === "working");
    if (active.length > 0) {
      lines.push("## Hive Context");
      lines.push("Other agents currently working:");
      for (const w of active) {
        const action = w.currentAction || w.lastAction;
        lines.push(`- ${w.tty || w.id}: ${w.projectName} — ${action}`);
      }
    }

    if (taskProject) {
      const relevantArtifacts: Array<{ worker: string; path: string; action: string }> = [];
      for (const w of others) {
        if (!this.workerMatchesProject(w, taskProject)) continue;
        const arts = this.getArtifacts(w.id);
        for (const art of arts) {
          if (Date.now() - art.ts < 30 * 60 * 1000) {
            relevantArtifacts.push({
              worker: w.tty || w.id,
              path: art.path.split("/").slice(-2).join("/"),
              action: art.action,
            });
          }
        }
      }
      if (relevantArtifacts.length > 0) {
        lines.push("");
        lines.push("Recently modified files in this project (by other agents):");
        for (const a of relevantArtifacts.slice(-10)) {
          lines.push(`- ${a.worker}: ${a.path} (${a.action})`);
        }
        lines.push("Check /api/conflicts?path=X before editing shared files.");
      }
    }

    if (taskProject) {
      const relatedWorkers = others
        .filter((worker) => this.workerMatchesProject(worker, taskProject))
        .sort((a, b) => b.lastActionAt - a.lastActionAt)
        .slice(0, 3);
      if (relatedWorkers.length > 0) {
        lines.push("");
        lines.push("Relevant agent context:");
        for (const worker of relatedWorkers) {
          const summary = [
            `${worker.tty || worker.id} (${worker.model || "claude"})`,
            worker.currentAction || worker.lastAction,
            worker.lastDirection ? `last direction: ${worker.lastDirection}` : null,
          ].filter(Boolean).join(" | ");
          lines.push(`- ${summary}`);
        }
      }
    }

    if (taskProject) {
      const learningPaths = [
        ...(resolvedLocalProject ? [join(resolvedLocalProject, ".claude", "hive-learnings.md")] : []),
        join(HOME, "factory", "projects", taskProject, ".claude", "hive-learnings.md"),
      ];
      for (const lp of learningPaths) {
        try {
          if (existsSync(lp)) {
            const content = readFileSync(lp, "utf-8").trim();
            if (content.length > 0) {
              lines.push("");
              lines.push("## Recent learnings");
              lines.push(content.length > 300 ? content.slice(-300) : content);
              break;
            }
          }
        } catch { /* skip */ }
      }
    }

    return lines.length > 0 ? "\n\n" + lines.join("\n") : "";
  }

  private dispatchFromQueue(): void {
    if (this.taskQueue.length === 0) return;

    const now = Date.now();
    const allWorkers = this.satelliteAllWorkersGetter ? this.satelliteAllWorkersGetter() : this.getAll();
    const allIdleWorkers = allWorkers.filter(w =>
      w.status === "idle" && (now - w.lastActionAt > 15_000)
    );
    if (allIdleWorkers.length === 0) return;

    // Snapshot the queue — iterate all eligible tasks, remove dispatched ones by ID.
    const tasks = this.taskQueue.getAll();
    for (const task of tasks) {
      if (task.blockedBy && !this.taskQueue.isCompleted(task.blockedBy)) continue;

      // Capability-based routing: if task has `requires`, filter to capable machines
      let eligibleWorkers = allIdleWorkers;
      if (task.requires && task.requires.length > 0 && this.capabilityChecker) {
        // Local machine always has id undefined/no machine field
        // Check if local machine satisfies requirements
        const localCapable = this.capabilityChecker("local", task.requires);
        const capableWorkers = allIdleWorkers.filter(w => {
          if (!w.machine) return localCapable; // local worker
          return this.capabilityChecker!(w.machine, task.requires!);
        });
        if (capableWorkers.length === 0) continue; // no capable machine idle — skip, try next tick
        eligibleWorkers = capableWorkers;
      }

      // Model routing: if task specifies a model, only dispatch to agents running that model
      if (task.model) {
        const modelMatch = eligibleWorkers.filter(w => w.model === task.model);
        if (modelMatch.length === 0) continue; // no idle agent with that model — skip, try next tick
        eligibleWorkers = modelMatch;
      }

      // Preferred machine routing
      if (task.preferMachine) {
        const preferred = eligibleWorkers.filter(w =>
          task.preferMachine === "local" ? !w.machine : w.machine === task.preferMachine
        );
        if (preferred.length > 0) eligibleWorkers = preferred;
      }

      // Try to match by project first, then fall back to any eligible worker
      let target = eligibleWorkers.find(w => this.workerMatchesProject(w, task.project));
      if (!target) target = eligibleWorkers[0];
      if (!target) continue;

      const resolvedTaskProject = task.project
        ? this.resolveProjectForMachine(task.project, target.machine)
        : undefined;
      const brief = this.buildContextBrief(target.id, resolvedTaskProject || task.project);

      // Git pull before dispatch: ensure agent starts with latest code
      if (resolvedTaskProject) {
        try {
          const { execFileSync } = require("child_process");
          execFileSync("/usr/bin/git", ["pull", "--ff-only", "--no-edit"], {
            cwd: resolvedTaskProject,
            encoding: "utf-8",
            timeout: 15_000,
          });
        } catch { /* not a git repo or no remote — skip */ }
      }

      // Conflict guard: warn about files locked or recently edited by other agents
      let conflictWarning = "";
      const activeLocks = this.lockManager.getLocksExcluding(target.id);
      if (activeLocks.length > 0) {
        const taskNeedle = basename(resolvedTaskProject || task.project || "");
        const lockLines = activeLocks
          .filter(l => !taskNeedle || l.path.includes(taskNeedle))
          .map(l => `  - ${l.path} (locked by ${l.tty || l.workerId})`)
          .slice(0, 5);
        if (lockLines.length > 0) {
          conflictWarning = `\n\n[Hive Conflict Guard] These files are currently locked by other agents — do NOT edit them:\n${lockLines.join("\n")}`;
        }
      }

      // Inject workflow handoff if previous steps completed
      let handoff = "";
      if (task.workflowId) {
        const steps = this.workflowHandoffs.get(task.workflowId);
        if (steps && steps.length > 0) {
          handoff = "\n\n" + steps.join("\n\n");
        }
      }

      const fullTask = task.task + handoff + conflictWarning + brief;

      const result = this.sendToWorker(target.id, fullTask, {
        source: "task-queue",
        queueIfBusy: false,
        lastAction: `Task queue: ${task.id}`,
        trackDispatch: true,
        taskBrief: `Queue ${task.id}: ${task.task.slice(0, 150)}`,
        taskId: task.id,
        workflowId: task.workflowId,
        verify: task.verify,
        maxVerifyAttempts: task.maxVerifyAttempts,
        autoCommit: task.autoCommit,
      });
      if (result.ok && !result.queued) {
        this.taskQueue.markRunning(task.id, target.id);
        console.log(`[task-queue] Dispatched ${task.id} to ${target.tty} (${this.taskQueue.length} remaining)`);

        // One task per worker per tick
        const targetIdx = allIdleWorkers.indexOf(target);
        if (targetIdx >= 0) allIdleWorkers.splice(targetIdx, 1);
        if (allIdleWorkers.length === 0) break;
      }
    }
  }

  // --- Scratchpad facade ---

  getScratchpad(key: string): ScratchpadEntry | undefined {
    return this.scratchpad.get(key);
  }

  getAllScratchpad(): Record<string, ScratchpadEntry> {
    return this.scratchpad.getAll();
  }

  setScratchpad(key: string, value: string, setBy: string): ScratchpadEntry {
    return this.scratchpad.set(key, value, setBy);
  }

  deleteScratchpad(key: string): boolean {
    return this.scratchpad.delete(key);
  }

  // --- Review store facade ---

  addReview(
    summary: string,
    workerId: string,
    projectName: string,
    opts?: { url?: string; type?: ReviewItem["type"]; quadrant?: number; artifacts?: Array<{ path: string; action: string }> },
  ): ReviewItem {
    const quadrant = opts?.quadrant ?? this.quadrantAssignments.get(workerId);
    const review = this.reviewStore.add(summary, workerId, projectName, { ...opts, quadrant });
    // Notify WS listeners
    for (const listener of this.reviewListeners) {
      listener(review);
    }
    return review;
  }

  getReviews(): ReviewItem[] {
    return this.reviewStore.getAll();
  }

  getUnseenReviews(): ReviewItem[] {
    return this.reviewStore.getUnseen();
  }

  markReviewSeen(id: string): boolean {
    return this.reviewStore.markSeen(id);
  }

  markAllReviewsSeen(): number {
    return this.reviewStore.markAllSeen();
  }

  dismissReview(id: string): boolean {
    return this.reviewStore.dismiss(id);
  }

  clearAllReviews(): number {
    return this.reviewStore.clearAll();
  }

  onReviewAdded(listener: (review: ReviewItem) => void): void {
    this.reviewListeners.push(listener);
  }

  /** Resolve current git branch from a worker's project path */
  private resolveGitBranch(worker: WorkerState): string | undefined {
    try {
      const { execFileSync } = require("child_process");
      return execFileSync("/usr/bin/git", ["symbolic-ref", "--short", "HEAD"], {
        cwd: worker.project,
        encoding: "utf-8",
        timeout: 3000,
      }).trim() || undefined;
    } catch {
      return undefined;
    }
  }

  /** Resolve GitHub URL from a worker's project path */
  private resolveGitUrl(worker: WorkerState): string | undefined {
    try {
      const { execFileSync } = require("child_process");
      const remote = execFileSync("/usr/bin/git", ["remote", "get-url", "origin"], {
        cwd: worker.project,
        encoding: "utf-8",
        timeout: 3000,
      }).trim();
      // Convert git@github.com:User/Repo.git or https://github.com/User/Repo.git to https://github.com/User/Repo
      if (remote.startsWith("git@github.com:")) {
        return "https://github.com/" + remote.slice(15).replace(/\.git$/, "");
      }
      if (remote.includes("github.com")) {
        return remote.replace(/\.git$/, "");
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  /** Resolve the git repo name from a worker's project path (e.g., "hive" from the repo root) */
  private resolveGitRepoName(worker: WorkerState): string {
    try {
      const { execFileSync } = require("child_process");
      const root = execFileSync("/usr/bin/git", ["rev-parse", "--show-toplevel"], {
        cwd: worker.project,
        encoding: "utf-8",
        timeout: 3000,
      }).trim();
      const name = root.split("/").pop();
      if (name && name !== "unknown") return name;
    } catch { /* not a git repo at this cwd */ }
    // Fallback: derive from project path (last non-empty segment)
    const segments = worker.project.replace(/\/+$/, "").split("/").filter(Boolean);
    const last = segments[segments.length - 1];
    if (last && last !== "unknown" && last !== process.env.USER) return last;
    return worker.projectName !== "unknown" ? worker.projectName : "agent";
  }

  /** Build a rich review summary with quadrant, project, and branch context */
  private buildReviewSummary(action: string, worker: WorkerState, repoName: string, branch?: string): string {
    const q = this.quadrantAssignments.get(worker.id);
    const qLabel = q ? `Q${q}` : (worker.tty || "agent");
    const branchSuffix = branch ? ` (${branch})` : "";
    return `${qLabel} ${action} ${repoName}${branchSuffix}`;
  }

  /** Get recent artifacts formatted for review attachment */
  private getReviewArtifacts(workerId: string): Array<{ path: string; action: string }> | undefined {
    const arts = this.getRecentArtifacts(workerId, 5);
    if (arts.length === 0) return undefined;
    return arts.map(a => ({
      path: a.path.split("/").slice(-2).join("/"),
      action: a.action,
    }));
  }

  /** Dedup: track last review per worker to prevent duplicates from chained commands */
  private lastReviewByWorker = new Map<string, { type: string; ts: number }>();

  private isDuplicateReview(workerId: string, type: string): boolean {
    const last = this.lastReviewByWorker.get(workerId);
    if (last && last.type === type && Date.now() - last.ts < 30_000) return true;
    this.lastReviewByWorker.set(workerId, { type, ts: Date.now() });
    return false;
  }

  /**
   * Extract the effective working directory from a bash command.
   * Handles patterns like `cd /path/to/repo && git push`.
   */
  private extractCommandCwd(command: string, fallback: string): string {
    // Match: cd /path && ..., cd "/path" && ..., cd '/path' && ...
    const cdMatch = command.match(/\bcd\s+["']?([^"'&;|\n]+?)["']?\s*(?:&&|;)/);
    if (cdMatch) {
      let dir = cdMatch[1].trim();
      // Expand ~ to home
      if (dir.startsWith("~/") || dir === "~") {
        const home = process.env.HOME || `/Users/${process.env.USER}`;
        dir = dir.replace(/^~/, home);
      }
      try {
        const { statSync } = require("fs");
        if (statSync(dir).isDirectory()) return dir;
      } catch { /* path doesn't exist, use fallback */ }
    }
    return fallback;
  }

  /** Auto-detect reviewable actions from Bash tool_input */
  private autoDetectReview(
    workerId: string,
    worker: WorkerState,
    toolInput: Record<string, unknown>,
  ): void {
    const command = (toolInput.command || toolInput.description || "") as string;
    if (!command) return;

    const cmdLower = command.toLowerCase();

    // Resolve git context from the actual command cwd, not the worker's launch directory.
    // Agents often run `cd /other/repo && git push` from a different project.
    const effectiveCwd = this.extractCommandCwd(command, worker.project);
    const effectiveWorker = effectiveCwd !== worker.project
      ? { ...worker, project: effectiveCwd }
      : worker;

    const gitUrl = this.resolveGitUrl(effectiveWorker);
    const branch = this.resolveGitBranch(effectiveWorker);
    const repoName = this.resolveGitRepoName(effectiveWorker);
    const artifacts = this.getReviewArtifacts(workerId);

    // npm run build + git push in same command chain (check before individual patterns)
    if (/\bgit\s+commit\b/.test(cmdLower) && /\bgit\s+push\b/.test(cmdLower)) {
      if (this.isDuplicateReview(workerId, "push")) return;
      const summary = this.buildReviewSummary("committed and pushed", worker, repoName, branch);
      this.addReview(summary, workerId, repoName, { type: "push", url: gitUrl, artifacts });
      return;
    }

    // git push
    if (/\bgit\s+push\b/.test(cmdLower)) {
      if (this.isDuplicateReview(workerId, "push")) return;
      const summary = this.buildReviewSummary("pushed", worker, repoName, branch);
      console.log(`[review] Auto-detected push by ${worker.tty || workerId} in ${repoName}`);
      this.addReview(summary, workerId, repoName, { type: "push", url: gitUrl, artifacts });
      // Auto-update satellites when the hive repo itself is pushed
      if (repoName === "hive" && this.satelliteUpdateFn) {
        console.log(`[satellite-update] Hive repo pushed — triggering satellite updates`);
        this.satelliteUpdateFn();
      }
      return;
    }

    // gh pr create
    if (/\bgh\s+pr\s+create\b/.test(cmdLower)) {
      if (this.isDuplicateReview(workerId, "pr")) return;
      const summary = this.buildReviewSummary("created PR in", worker, repoName, branch);
      console.log(`[review] Auto-detected PR by ${worker.tty || workerId} in ${repoName}`);
      this.addReview(summary, workerId, repoName, { type: "pr", url: gitUrl ? `${gitUrl}/pulls` : undefined, artifacts });
      return;
    }

    // vercel deploy (or npx vercel)
    if (/\bvercel\b/.test(cmdLower) && (/\bdeploy\b/.test(cmdLower) || /\bnpx\s+vercel\b/.test(cmdLower) || /^vercel(\s|$)/.test(cmdLower.trim()))) {
      if (this.isDuplicateReview(workerId, "deploy")) return;
      const summary = this.buildReviewSummary("deployed", worker, repoName, branch);
      this.addReview(summary, workerId, repoName, { type: "deploy", artifacts });
      return;
    }
  }

  // --- Lock manager facade ---

  acquireLock(filePath: string, workerId: string): { acquired: boolean; holder?: { workerId: string; tty?: string; lockedAt: number } } {
    return this.lockManager.acquire(filePath, workerId);
  }

  releaseLock(filePath: string, workerId: string): boolean {
    return this.lockManager.release(filePath, workerId);
  }

  releaseAllLocks(workerId: string): number {
    return this.lockManager.releaseAll(workerId);
  }

  getAllLocks(): Array<{ path: string; workerId: string; tty?: string; lockedAt: number }> {
    return this.lockManager.getAll();
  }

  // --- Debug state ---

  getDebugState(discovery: ProcessDiscovery): Record<string, unknown> {
    const sessions: Record<string, string> = {};
    for (const [sid, wid] of this.sessionToWorker) {
      sessions[sid] = wid;
    }
    const hooks: Record<string, number> = {};
    for (const w of this.getAll()) {
      hooks[w.id] = this.lastHookTime.get(w.id) || 0;
    }
    const pendingHookQueue: Record<string, number> = {};
    for (const [sid, queue] of this.pendingHooks) {
      pendingHookQueue[sid.slice(0, 8)] = queue.length;
    }
    return {
      sessionToWorker: sessions,
      sessionFiles: discovery.getSessionFiles(),
      lastHookTime: hooks,
      signalCounts: Object.fromEntries(
        [...this.signals.entries()].map(([k, v]) => [k, v.length])
      ),
      pendingHookQueue,
    };
  }

  // --- Hook handling ---

  private handleHook(body: Record<string, unknown>): { decision: string; reason: string } | undefined {
    const sessionId = body.session_id as string | undefined;
    const eventName = body.hook_event_name as string | undefined;
    const toolName = body.tool_name as string | undefined;
    const toolInput = body.tool_input as Record<string, unknown> | undefined;
    const cwd = body.cwd as string | undefined;

    if (!sessionId || !eventName) return undefined;

    let workerId = this.sessionToWorker.get(sessionId);

    if (!workerId && cwd) {
      const candidates: Array<{ id: string; pathLen: number }> = [];
      for (const w of this.workers.values()) {
        if (w.project === cwd || cwd.startsWith(w.project + "/")) {
          candidates.push({ id: w.id, pathLen: w.project.length });
        }
      }
      if (candidates.length >= 1) {
        candidates.sort((a, b) => b.pathLen - a.pathLen);
        const best = candidates[0];
        const tied = candidates.filter(c => c.pathLen === best.pathLen);
        if (tied.length === 1) {
          workerId = best.id;
        } else {
          this.enqueueHook(sessionId, body);
          return undefined;
        }
      }
    }

    if (!workerId) {
      this.enqueueHook(sessionId, body);
      return undefined;
    }

    return this.processHook(workerId, body, sessionId, eventName, toolName, toolInput, cwd);
  }

  private processHook(
    workerId: string,
    body: Record<string, unknown>,
    sessionId: string,
    eventName: string,
    toolName: string | undefined,
    toolInput: Record<string, unknown> | undefined,
    cwd: string | undefined,
  ): { decision: string; reason: string } | undefined {
    const worker = this.workers.get(workerId);
    if (!worker) return;

    // Only Claude fires these hooks. If a hook routes to a non-Claude worker
    // (via CWD fallback or session ID collision), ignore it — applying Claude
    // hook state (PreToolUse/PostToolUse) to Gemini/Codex/OpenClaw workers
    // causes phantom green (status set to "working" by cross-contaminated hooks).
    if (worker.model && worker.model !== "claude") return;

    const now = Date.now();
    this.lastHookTime.set(workerId, now);
    worker.lastActionAt = now;

    if (cwd) {
      const name = cwd.split("/").pop();
      const homeBase = HOME.split("/").pop();
      if (name && name !== homeBase && name !== "/") {
        worker.project = cwd;
        worker.projectName = name;
      }
    }

    switch (eventName) {
      case "PreToolUse": {
        if (toolName === "AskUserQuestion") {
          worker.status = "stuck";
          this.toolInFlight.set(workerId, null);
          worker.currentAction = "Asking a question";
          worker.stuckMessage = formatAskQuestion(toolInput);
          worker.lastAction = worker.currentAction;
          this.recordSignal(workerId, "PreToolUse", `AskUserQuestion → stuck`);
          break;
        }
        if (toolName === "EnterPlanMode" || toolName === "ExitPlanMode") {
          worker.status = "stuck";
          this.toolInFlight.set(workerId, null);
          worker.currentAction = toolName;
          worker.stuckMessage = toolName === "ExitPlanMode"
            ? "Claude Code needs your approval for the plan"
            : "Claude Code wants to enter plan mode";
          worker.lastAction = toolName;
          this.recordSignal(workerId, "PreToolUse", `${toolName} → stuck`);
          break;
        }
        worker.status = "working";
        worker.stuckMessage = undefined;
        this.toolInFlight.set(workerId, { tool: toolName || "unknown", since: Date.now() });
        this.idleConfirmed.set(workerId, false);
        const action = describeAction(toolName, toolInput);
        worker.currentAction = action;
        worker.lastAction = action;
        this.recordSignal(workerId, "PreToolUse", action);

        // Auto-detect reviewable actions from Bash commands (PreToolUse has guaranteed tool_input)
        if (toolName === "Bash" && toolInput) {
          this.autoDetectReview(workerId, worker, toolInput);
        }

        // File lock enforcement: block Edit/Write if another agent holds the lock
        if ((toolName === "Edit" || toolName === "Write" || toolName === "NotebookEdit") && toolInput) {
          const filePath = (toolInput.file_path || toolInput.notebook_path) as string | undefined;
          if (filePath) {
            const lockResult = this.lockManager.acquire(filePath, workerId);
            if (!lockResult.acquired) {
              const holderName = lockResult.holder?.tty || lockResult.holder?.workerId || "another agent";
              const reason = `File locked by ${holderName}. They are actively editing this file. Wait for them to finish or coordinate via scratchpad.`;
              this.recordSignal(workerId, "PreToolUse", `BLOCKED: ${filePath} locked by ${holderName}`);
              console.log(`[lock-enforce] Blocked ${worker.tty || workerId} from writing ${filePath} (held by ${holderName})`);
              this.collector?.record(workerId, sessionId, body);
              this.notify(worker);
              return { decision: "block", reason };
            }
          }
        }
        break;
      }

      case "PostToolUse": {
        worker.status = "working";
        worker.stuckMessage = undefined;
        this.toolInFlight.set(workerId, null);
        this.idleConfirmed.set(workerId, false);
        worker.currentAction = null;
        const postAction = describeAction(toolName, toolInput);
        worker.lastAction = postAction;
        this.recordSignal(workerId, "PostToolUse", postAction);
        if (toolName && toolInput) {
          const filePath = (toolInput.file_path || toolInput.notebook_path) as string | undefined;
          if (filePath && (toolName === "Edit" || toolName === "Write" || toolName === "NotebookEdit")) {
            this.recordArtifact(workerId, filePath, toolName === "Edit" ? "edited" : "created");
            // Auto-acquire lock on successful write
            this.lockManager.acquire(filePath, workerId);
          }
          // Review detection moved to PreToolUse (guaranteed tool_input)
        }
        break;
      }

      case "Notification": {
        this.toolInFlight.set(workerId, null);
        const notifType = body.notification_type as string | undefined;
        const message = body.message as string | undefined;

        if (notifType === "idle_prompt") {
          this.idleConfirmed.set(workerId, true);
          worker.status = "idle";
          worker.currentAction = null;
          worker.stuckMessage = undefined;
          worker.lastAction = "Waiting for input";
          this.lockManager.releaseAll(workerId);
          this.generateSuggestions(worker);
          this.recordSignal(workerId, "idle_prompt", "done");
          break;
        }

        worker.status = "stuck";
        if (notifType === "permission_prompt") {
          if (toolName) {
            const desc = describeAction(toolName, toolInput);
            worker.currentAction = `Allow? ${desc}`;
          } else {
            worker.currentAction = "Waiting for permission";
          }
        } else {
          worker.currentAction = "Needs your attention";
        }

        worker.stuckMessage = message || undefined;
        worker.lastAction = worker.currentAction;
        break;
      }

      case "Stop":
      case "SessionEnd": {
        worker.status = "idle";
        worker.stuckMessage = undefined;
        this.toolInFlight.set(workerId, null);
        this.idleConfirmed.set(workerId, true);
        worker.currentAction = null;
        worker.lastAction = "Session ended";
        this.generateSuggestions(worker);
        break;
      }

      case "SessionStart": {
        worker.status = "working";
        worker.stuckMessage = undefined;
        this.idleConfirmed.set(workerId, false);
        worker.currentAction = null;
        worker.lastAction = "Session started";
        break;
      }

      case "UserPromptSubmit": {
        worker.status = "working";
        worker.stuckMessage = undefined;
        this.idleConfirmed.set(workerId, false);
        this.markInputSent(workerId, "user-prompt");
        worker.currentAction = "Thinking...";
        worker.lastAction = "Received prompt";
        this.recordSignal(workerId, "UserPromptSubmit", "prompt received");
        break;
      }
    }

    this.collector?.record(workerId, sessionId, body);
    this.notify(worker);
    return undefined;
  }

  // --- Pending hook queue ---

  private enqueueHook(sessionId: string, body: Record<string, unknown>): void {
    if (!this.pendingHooks.has(sessionId)) {
      this.pendingHooks.set(sessionId, []);
    }
    const queue = this.pendingHooks.get(sessionId)!;
    if (queue.length >= TelemetryReceiver.HOOK_QUEUE_MAX_PER_SESSION) {
      queue.shift();
    }
    queue.push({ body, receivedAt: Date.now() });
    this.recordSignal("_pending", "hook_queued", `session=${sessionId.slice(0, 8)} queue=${queue.length}`);
  }

  replayPendingHooks(sessionId: string, workerId: string): void {
    const queue = this.pendingHooks.get(sessionId);
    if (!queue || queue.length === 0) return;
    this.pendingHooks.delete(sessionId);

    const now = Date.now();
    let replayed = 0;
    for (const entry of queue) {
      if (now - entry.receivedAt > TelemetryReceiver.HOOK_QUEUE_TTL) continue;

      const b = entry.body;
      const eventName = b.hook_event_name as string | undefined;
      const toolName = b.tool_name as string | undefined;
      const toolInput = b.tool_input as Record<string, unknown> | undefined;
      const cwd = b.cwd as string | undefined;
      if (!eventName) continue;

      this.processHook(workerId, b, sessionId, eventName, toolName, toolInput, cwd);
      replayed++;
    }

    if (replayed > 0) {
      this.recordSignal(workerId, "hooks_replayed", `session=${sessionId.slice(0, 8)} count=${replayed}`);
      console.log(`[hooks] Replayed ${replayed} queued hook(s) for ${workerId} (session ${sessionId.slice(0, 8)})`);
    }
  }

  private expirePendingHooks(): void {
    const now = Date.now();
    for (const [sessionId, queue] of this.pendingHooks) {
      const filtered = queue.filter(e => now - e.receivedAt <= TelemetryReceiver.HOOK_QUEUE_TTL);
      if (filtered.length === 0) {
        this.pendingHooks.delete(sessionId);
      } else if (filtered.length < queue.length) {
        this.pendingHooks.set(sessionId, filtered);
      }
    }
  }

  // --- Original telemetry events ---

  private handleEvent(event: TelemetryEvent): void {
    const worker = this.workers.get(event.worker_id);
    if (!worker) return;

    // Only Claude fires telemetry events. Cross-contaminated events from
    // other sessions must not change non-Claude worker status.
    if (worker.model && worker.model !== "claude") return;

    const now = event.timestamp || Date.now();
    worker.lastActionAt = now;

    switch (event.event) {
      case "SessionStart":
        worker.status = "working";
        worker.errorCount = 0;
        worker.lastAction = "session started";
        worker.currentAction = null;
        break;

      case "UserPromptSubmit":
        worker.status = "working";
        this.idleConfirmed.set(event.worker_id, false);
        worker.currentAction = "Thinking...";
        worker.lastAction = "Received prompt";
        break;

      case "PreToolUse":
        worker.status = "working";
        this.toolInFlight.set(event.worker_id, { tool: event.tool_name || "unknown", since: Date.now() });
        worker.currentAction = event.tool_name || "working";
        worker.lastAction = `using ${event.tool_name || "tool"}`;
        break;

      case "PostToolUse":
        worker.status = "working";
        this.toolInFlight.set(event.worker_id, null);
        worker.currentAction = null;
        worker.lastAction = event.summary || `completed ${event.tool_name || "tool"}`;
        break;

      case "Stop":
        worker.status = "idle";
        this.toolInFlight.set(event.worker_id, null);
        this.idleConfirmed.set(event.worker_id, true);
        worker.currentAction = null;
        this.generateSuggestions(worker);
        worker.lastAction = event.summary || "stopped";
        break;

      case "SubagentStart":
        worker.status = "working";
        worker.currentAction = "running subagent";
        worker.lastAction = "subagent started";
        break;

      case "SubagentStop":
        worker.lastAction = "subagent completed";
        break;
    }

    this.notify(worker);
  }

  private notify(worker: WorkerState): void {
    // Clear LLM suggestions when agent starts working
    if (worker.status === "working" || worker.status === "stuck") {
      this.clearSuggestions(worker.id);
    }
    for (const listener of this.listeners) {
      listener(worker.id, worker);
    }
  }

  // --- State persistence ---

  exportState(): DaemonSnapshot {
    const workers = this.getAll().map(w => ({
      id: w.id, pid: w.pid, project: w.project, projectName: w.projectName,
      status: w.status, lastAction: w.lastAction, lastActionAt: w.lastActionAt,
      errorCount: w.errorCount, startedAt: w.startedAt, task: w.task,
      managed: w.managed, tty: w.tty,
    }));

    const messageQueue: Record<string, QueuedMessage[]> = {};
    for (const [wid, queue] of this.messageQueue) {
      if (queue.length > 0) messageQueue[wid] = [...queue];
    }

    const dispatchedTasks: Record<string, { task: string; project: string; sentAt: number; taskId?: string; workflowId?: string; fromWorkerId?: string }> = {};
    for (const [wid, dt] of this.dispatchedTasks) {
      dispatchedTasks[wid] = { ...dt };
    }

    const workflowHandoffs: Record<string, string[]> = {};
    for (const [wfId, steps] of this.workflowHandoffs) {
      workflowHandoffs[wfId] = [...steps];
    }

    // Build TTY → session_id map from pinned sessions (ground truth from identity.sh)
    const ttySessionMap: Record<string, string> = {};
    for (const [sessionId, workerId] of this.pinnedSessions) {
      const worker = this.workers.get(workerId);
      if (worker?.tty) {
        ttySessionMap[worker.tty] = sessionId;
      }
    }

    // Persist quadrant assignments so slots are sticky across daemon restarts
    const quadrantAssignments: Record<string, number> = {};
    for (const [id, q] of this.quadrantAssignments) {
      quadrantAssignments[id] = q;
    }

    return {
      savedAt: Date.now(),
      workers,
      messageQueue,
      messageIdCounter: this.messageIdCounter,
      locks: this.lockManager.getAll(),
      dispatchedTasks,
      workflowHandoffs,
      ttySessionMap,
      quadrantAssignments,
    };
  }

  importState(snapshot: DaemonSnapshot): void {
    let workerCount = 0;
    for (const w of snapshot.workers) {
      const restored: WorkerState = {
        id: w.id, pid: w.pid, project: w.project, projectName: w.projectName,
        status: "idle", currentAction: null, lastAction: w.lastAction,
        lastActionAt: w.lastActionAt, errorCount: w.errorCount,
        startedAt: w.startedAt, task: w.task, managed: w.managed, tty: w.tty,
      };
      this.workers.set(w.id, restored);
      workerCount++;
    }

    for (const [wid, queue] of Object.entries(snapshot.messageQueue)) {
      if (queue.length > 0) this.messageQueue.set(wid, [...queue]);
    }

    this.messageIdCounter = snapshot.messageIdCounter;

    for (const lock of snapshot.locks) {
      this.lockManager.acquire(lock.path, lock.workerId);
    }

    for (const [wid, dt] of Object.entries(snapshot.dispatchedTasks)) {
      this.dispatchedTasks.set(wid, { ...dt });
    }

    if (snapshot.workflowHandoffs) {
      for (const [wfId, steps] of Object.entries(snapshot.workflowHandoffs)) {
        this.workflowHandoffs.set(wfId, [...steps]);
      }
    }

    // Restore TTY → session_id mappings so session files are correct immediately
    // on daemon restart, without waiting for identity.sh to fire.
    if (snapshot.ttySessionMap) {
      for (const [tty, sessionId] of Object.entries(snapshot.ttySessionMap)) {
        this.pendingTtyRegistrations.set(tty, sessionId);
      }
      console.log(`[state-store] Restored ${Object.keys(snapshot.ttySessionMap).length} TTY→session mapping(s)`);
    }

    // Don't restore quadrant assignments — let position detection re-assign
    // based on actual window positions. This ensures swapped/moved windows
    // get correct quadrants after a daemon restart.
    console.log(`[state-store] Skipping quadrant restore — will re-detect from window positions`);

    console.log(`[state-store] Restored ${workerCount} worker(s), ${Object.keys(snapshot.messageQueue).length} queue(s), ${snapshot.locks.length} lock(s)`);
  }
}

function formatAskQuestion(toolInput: Record<string, unknown> | undefined): string {
  if (!toolInput) return "Waiting for your answer";

  const questions = toolInput.questions as Array<{
    question?: string;
    options?: Array<{ label?: string; description?: string }>;
  }> | undefined;

  if (!questions || questions.length === 0) return "Waiting for your answer";

  const q = questions[0];
  const questionText = q.question || "Choose an option:";
  const options = q.options || [];

  if (options.length === 0) return questionText;

  const numbered = options
    .map((opt, i) => `${i + 1}. ${opt.label || `Option ${i + 1}`}`)
    .join("\n");

  return `${questionText}\n${numbered}`;
}
