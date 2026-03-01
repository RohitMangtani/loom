import express from "express";
import type { Request, Response, NextFunction } from "express";
import { basename, join } from "path";
import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync } from "fs";
import type { Server } from "http";
import { validateToken } from "./auth.js";
import { sendInputToTty } from "./tty-input.js";
import type { ProcessManager } from "./process-mgr.js";
import type { ProcessDiscovery } from "./discovery.js";
import type { WorkerState, TelemetryEvent } from "./types.js";

const IDLE_THRESHOLD = 30_000; // 30 seconds without activity → idle
const HOME = process.env.HOME || `/Users/${process.env.USER}`;
const QUEUE_PATH = join(HOME, ".hive", "queue.json");

export interface QueuedTask {
  id: string;
  task: string;
  project?: string;  // optional: prefer agents on this project
  priority: number;   // lower = higher priority (0 = urgent, 10 = default)
  createdAt: number;
  blockedBy?: string; // ID of another queued task that must complete first
}

export class TelemetryReceiver {
  private workers = new Map<string, WorkerState>();
  private listeners: Array<(workerId: string, state: WorkerState) => void> = [];
  private server: Server | null = null;
  private port: number;
  private app: ReturnType<typeof express> | null = null;
  private requireAuth: ((req: Request, res: Response, next: NextFunction) => void) | null = null;

  // Hook support: session_id → worker_id
  private sessionToWorker = new Map<string, string>();
  // Track last hook event time per worker (discovery defers when hooks are fresh)
  private lastHookTime = new Map<string, number>();
  // True while a tool is mid-execution (between PreToolUse and PostToolUse).
  // Prevents idle timeout during long-running commands (Bash scripts, builds).
  private toolInFlight = new Map<string, boolean>();
  // True when Claude Code sends idle_prompt notification — confirmed done, waiting for input.
  // Cleared by any PreToolUse/PostToolUse hook (means Claude started working again).
  // Discovery uses this to decide grace period: if idleConfirmed → RED fast, else → extended grace.
  private idleConfirmed = new Map<string, boolean>();
  // Track last time a message was sent FROM the dashboard (website) to a worker.
  // Auto-pilot uses this to know if the user is actively interacting.
  private lastDashboardInput = new Map<string, number>();
  // Track last time ANY external input was sent to a worker (dashboard or auto-pilot).
  // Discovery uses this to avoid flipping working→idle before JSONL catches up.
  private lastInputSent = new Map<string, number>();
  // Track recent file modifications per worker (for cross-agent artifact reading).
  // Each entry: { path, action, timestamp }
  private artifacts = new Map<string, Array<{ path: string; action: string; ts: number }>>();
  private static readonly MAX_ARTIFACTS = 50;
  // Track dispatched tasks — when a worker finishes a dispatch, auto-write a learning.
  private dispatchedTasks = new Map<string, { task: string; project: string; sentAt: number }>();
  // Signal timeline — ring buffer per worker for compound debugging.
  // Every status-affecting event is recorded: hooks, JSONL decisions, input sent, idle_prompt.
  // Exposed via GET /api/signals for live diagnosis.
  private signals = new Map<string, Array<{ ts: number; signal: string; detail: string }>>();
  private static readonly MAX_SIGNALS = 50;
  // Message queue: when a worker is busy, queue messages and drain when idle.
  // Each entry has the content to send and the source (api, watchdog, etc).
  private messageQueue = new Map<string, Array<{ content: string; source: string; queuedAt: number }>>();
  // Pending hook queue: hooks waiting for session registration.
  // Keyed by session_id. When registerSession() is called, queued hooks replay.
  private pendingHooks = new Map<string, Array<{ body: Record<string, unknown>; receivedAt: number }>>();
  private static readonly HOOK_QUEUE_TTL = 10_000;
  private static readonly HOOK_QUEUE_MAX_PER_SESSION = 20;
  // Global task queue: tasks picked up by any idle agent. Persisted to disk.
  private taskQueue: QueuedTask[] = [];
  private completedTaskIds = new Set<string>();
  private static readonly QUEUE_COUNTER_KEY = "queue_next_id";
  private queueNextId = 1;

  private token: string;

  constructor(port: number, token: string) {
    this.port = port;
    this.token = token;
    this.loadQueue();
  }

  start(): void {
    const app = express();
    app.use(express.json());
    this.app = app;

    // Token middleware for protected routes.
    // Accepts either: Authorization: Bearer {token}  OR  ?token={token}
    // (HTTP hooks from Claude Code can't set custom headers, so query param is the fallback)
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

    // Health check stays open (liveness probe)
    app.get("/health", (_req, res) => {
      res.json({ ok: true });
    });

    // Original telemetry endpoint (for managed workers)
    app.post("/telemetry", requireAuth, (req, res) => {
      const event = req.body as TelemetryEvent;

      if (!event.worker_id || !event.event) {
        res.status(400).json({ error: "Missing worker_id or event" });
        return;
      }

      this.handleEvent(event);
      res.json({ ok: true });
    });

    // Claude Code hook endpoint — receives live tool events
    app.post("/hook", requireAuth, (req, res) => {
      this.handleHook(req.body);
      res.json({ ok: true });
    });

    this.server = app.listen(this.port, "127.0.0.1", () => {
      console.log(`  Telemetry receiver listening on 127.0.0.1:${this.port}`);
    });
  }

  /** Register REST API routes for inter-agent communication (dispatch API). */
  registerApi(procMgr: ProcessManager, discovery: ProcessDiscovery): void {
    const app = this.app;
    const requireAuth = this.requireAuth;
    if (!app || !requireAuth) {
      throw new Error("registerApi() called before start()");
    }

    // GET /api/workers — list all workers with status, TTY, project, actions
    app.get("/api/workers", requireAuth, (_req, res) => {
      res.json(this.getAll());
    });

    // POST /api/message — send a message to a worker
    app.post("/api/message", requireAuth, (req, res) => {
      const { workerId, content } = req.body as { workerId?: string; content?: string };
      if (!workerId || !content) {
        res.status(400).json({ error: "Missing workerId or content" });
        return;
      }

      // Try managed worker stdin first
      const sent = procMgr.sendMessage(workerId, content);
      if (sent) {
        const managed = this.get(workerId);
        if (managed) {
          managed.status = "working";
          managed.currentAction = "Thinking...";
          managed.lastAction = "Received message";
          managed.lastActionAt = Date.now();
          managed.stuckMessage = undefined;
          this.notifyExternal(managed);
        }
        this.trackDispatch(workerId, content.slice(0, 200));
        res.json({ ok: true });
        return;
      }

      // Fall back to TTY input for discovered workers
      const worker = this.get(workerId);
      if (!worker?.tty) {
        res.status(404).json({ error: `Worker ${workerId} not found or no TTY` });
        return;
      }

      // Queue if worker is busy — don't inject into active conversation
      if (worker.status === "working" || worker.status === "stuck") {
        this.enqueueMessage(workerId, content, "api:message");
        const queue = this.messageQueue.get(workerId) || [];
        console.log(`[queue] ${worker.tty}: queued message (${queue.length} pending, worker ${worker.status})`);
        res.json({ ok: true, queued: true, position: queue.length });
        return;
      }

      const result = sendInputToTty(worker.tty, content);
      if (result.ok) {
        worker.status = "working";
        worker.currentAction = "Thinking...";
        worker.lastAction = "Received message";
        worker.lastActionAt = Date.now();
        worker.stuckMessage = undefined;
        this.markInputSent(workerId, "api:message");
        this.trackDispatch(workerId, content.slice(0, 200));
        this.notifyExternal(worker);
        res.json({ ok: true });
      } else {
        res.status(500).json({ error: result.error || `Failed to send to ${worker.tty}` });
      }
    });

    // GET /api/message-queue — view queued per-worker messages (legacy)
    app.get("/api/message-queue", requireAuth, (_req, res) => {
      const result: Record<string, number> = {};
      for (const [id, queue] of this.messageQueue) {
        if (queue.length > 0) result[id] = queue.length;
      }
      res.json(result);
    });

    // GET /api/queue — view global task queue
    app.get("/api/queue", requireAuth, (_req, res) => {
      res.json(this.getTaskQueue());
    });

    // POST /api/queue — push a task to the global queue
    app.post("/api/queue", requireAuth, (req, res) => {
      const { task, project, priority, blockedBy } = req.body as {
        task?: string;
        project?: string;
        priority?: number;
        blockedBy?: string;
      };
      if (!task) {
        res.status(400).json({ error: "Missing task" });
        return;
      }
      const queued = this.pushTask(task, project, priority ?? 10, blockedBy);
      res.json({ ok: true, task: queued, remaining: this.taskQueue.length });
    });

    // DELETE /api/queue/:id — remove a task from the queue
    app.delete("/api/queue/:id", requireAuth, (req, res) => {
      const removed = this.removeTask(req.params.id as string);
      if (removed) {
        res.json({ ok: true, remaining: this.taskQueue.length });
      } else {
        res.status(404).json({ error: `Task ${req.params.id} not found in queue` });
      }
    });

    // GET /api/audit — quadrant status audit log
    app.get("/api/audit", requireAuth, (req, res) => {
      const tty = req.query.tty as string | undefined;
      res.json(discovery.getAuditLog(tty));
    });

    // GET /api/artifacts — recent file modifications by a worker
    app.get("/api/artifacts", requireAuth, (req, res) => {
      const workerId = req.query.workerId as string | undefined;
      if (workerId) {
        res.json(this.getArtifacts(workerId));
      } else {
        // Return all artifacts keyed by worker
        const all: Record<string, Array<{ path: string; action: string; ts: number }>> = {};
        for (const w of this.getAll()) {
          const arts = this.getArtifacts(w.id);
          if (arts.length > 0) all[w.id] = arts;
        }
        res.json(all);
      }
    });

    // GET /api/conflicts — check if a file was recently modified by another worker
    app.get("/api/conflicts", requireAuth, (req, res) => {
      const path = req.query.path as string | undefined;
      const exclude = req.query.excludeWorker as string | undefined;
      if (!path) {
        res.status(400).json({ error: "Missing path query parameter" });
        return;
      }
      const conflicts = this.checkConflicts(path, exclude);
      res.json({ path, conflicts, hasConflict: conflicts.length > 0 });
    });

    // POST /api/learning — append a lesson to a project's learning file
    app.post("/api/learning", requireAuth, (req, res) => {
      const { project, lesson } = req.body as { project?: string; lesson?: string };
      if (!project || !lesson) {
        res.status(400).json({ error: "Missing project or lesson" });
        return;
      }

      // Write to project's .claude/hive-learnings.md
      // Claude Code reads all .md files in .claude/ directory
      const claudeDir = join(project, ".claude");
      const learningFile = join(claudeDir, "hive-learnings.md");

      try {
        if (!existsSync(claudeDir)) {
          mkdirSync(claudeDir, { recursive: true });
        }

        // Create header if file is new
        const header = !existsSync(learningFile)
          ? "# Hive Learnings\n\nLessons captured from past sessions. Every agent in this project reads this file.\n\n"
          : "";

        const timestamp = new Date().toISOString().split("T")[0];
        const entry = `${header}- [${timestamp}] ${lesson.trim()}\n`;

        appendFileSync(learningFile, entry, "utf-8");
        res.json({ ok: true, file: learningFile });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: `Failed to write learning: ${msg.slice(0, 150)}` });
      }
    });

    // GET /api/signals — per-worker signal timeline (compound debugging)
    app.get("/api/signals", requireAuth, (req, res) => {
      const workerId = req.query.workerId as string | undefined;
      res.json(this.getSignals(workerId));
    });

    // GET /api/debug — session routing state (compound debugging)
    app.get("/api/debug", requireAuth, (_req, res) => {
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
      res.json({
        sessionToWorker: sessions,
        sessionFiles: discovery.getSessionFiles(),
        lastHookTime: hooks,
        signalCounts: Object.fromEntries(
          [...this.signals.entries()].map(([k, v]) => [k, v.length])
        ),
        pendingHookQueue,
      });
    });

    console.log("  Dispatch API registered: /api/workers, /api/message, /api/queue, /api/audit, /api/artifacts, /api/learning, /api/signals, /api/debug");
  }

  registerSession(sessionId: string, workerId: string): void {
    this.sessionToWorker.set(sessionId, workerId);
    this.replayPendingHooks(sessionId, workerId);
  }

  /** Check if a session UUID is registered to a DIFFERENT worker */
  isSessionOwnedByOther(sessionId: string, workerId: string): boolean {
    const owner = this.sessionToWorker.get(sessionId);
    return !!owner && owner !== workerId;
  }

  getLastHookTime(workerId: string): number | undefined {
    return this.lastHookTime.get(workerId);
  }

  isIdleConfirmed(workerId: string): boolean {
    return this.idleConfirmed.get(workerId) === true;
  }

  setIdleConfirmed(workerId: string, value: boolean): void {
    this.idleConfirmed.set(workerId, value);
  }

  isToolInFlight(workerId: string): boolean {
    return this.toolInFlight.get(workerId) === true;
  }

  /** Record that a message was sent from the dashboard to this worker */
  markDashboardInput(workerId: string): void {
    this.lastDashboardInput.set(workerId, Date.now());
  }

  /** Get the last time a dashboard message was sent to this worker */
  getLastDashboardInput(workerId: string): number {
    return this.lastDashboardInput.get(workerId) || 0;
  }

  /** Record that external input (dashboard or auto-pilot) was sent to this worker */
  markInputSent(workerId: string, source?: string): void {
    this.lastInputSent.set(workerId, Date.now());
    this.recordSignal(workerId, "input_sent", source ? `${source} → pending` : "external input → pending");
  }

  /** Get the last time external input was sent to this worker */
  getLastInputSent(workerId: string): number {
    return this.lastInputSent.get(workerId) || 0;
  }

  /** Record a file modification by a worker */
  recordArtifact(workerId: string, filePath: string, action: string): void {
    if (!this.artifacts.has(workerId)) {
      this.artifacts.set(workerId, []);
    }
    const list = this.artifacts.get(workerId)!;
    // Deduplicate: if same path was just modified, update timestamp
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

  /** Get recent file modifications by a worker */
  getArtifacts(workerId: string): Array<{ path: string; action: string; ts: number }> {
    return this.artifacts.get(workerId) || [];
  }

  /** Check if a file was recently modified by any OTHER worker. Returns conflicts. */
  checkConflicts(
    filePath: string,
    excludeWorkerId?: string,
    maxAgeMs = 30 * 60 * 1000, // 30 min default
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

  /** Track a dispatched task so auto-learning fires when the worker finishes. */
  trackDispatch(workerId: string, taskBrief: string): void {
    const worker = this.workers.get(workerId);
    const project = worker?.project || "";
    this.dispatchedTasks.set(workerId, {
      task: taskBrief.slice(0, 200),
      project,
      sentAt: Date.now(),
    });
  }

  /** Check dispatched tasks — auto-learn when agents finish. Called from tick(). */
  private checkCompletedDispatches(): void {
    for (const [workerId, dispatch] of this.dispatchedTasks) {
      const worker = this.workers.get(workerId);
      if (!worker) {
        this.dispatchedTasks.delete(workerId);
        continue;
      }

      // Worker finished (idle) and enough time passed for it to have done work
      if (worker.status === "idle" && Date.now() - dispatch.sentAt > 10_000) {
        const artifacts = this.getArtifacts(workerId);
        const fileList = artifacts.length > 0
          ? ` Files: ${artifacts.map(a => basename(a.path)).join(", ")}`
          : "";
        const lesson = `Completed: ${dispatch.task}${fileList}`;
        this.writeLearning(dispatch.project, lesson);
        this.dispatchedTasks.delete(workerId);
        continue;
      }

      // Cleanup stale dispatches (> 30 min without completion)
      if (Date.now() - dispatch.sentAt > 30 * 60 * 1000) {
        this.dispatchedTasks.delete(workerId);
      }
    }
  }

  /** Write a learning entry to a project's hive-learnings.md */
  private writeLearning(project: string, lesson: string): void {
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

  /** Record a signal in the per-worker timeline (ring buffer). */
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

  /** Get signal timeline for a worker (or all workers). */
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

  registerWorker(
    id: string,
    pid: number,
    project: string,
    task: string | null
  ): WorkerState {
    const projectName = project.split("/").pop() || project;
    const now = Date.now();
    const worker: WorkerState = {
      id,
      pid,
      project,
      projectName,
      status: "working",
      currentAction: null,
      lastAction: "spawned",
      lastActionAt: now,
      errorCount: 0,
      startedAt: now,
      task,
      managed: true,
    };
    this.workers.set(id, worker);
    this.notify(worker);
    return worker;
  }

  registerDiscovered(id: string, worker: WorkerState): void {
    this.workers.set(id, worker);
    // Initialize lastHookTime so hookAge doesn't default to Date.now()-0
    // (bogus_hook_age anomaly). Fresh workers start with "hooks just seen"
    // until a real hook arrives and overwrites this value.
    if (!this.lastHookTime.has(id)) {
      this.lastHookTime.set(id, Date.now());
    }
    this.notify(worker);
  }

  removeWorker(id: string): void {
    this.workers.delete(id);
    this.lastHookTime.delete(id);
    this.toolInFlight.delete(id);
    this.idleConfirmed.delete(id);
    this.lastInputSent.delete(id);
    // Clean up session mappings pointing to this worker
    for (const [sid, wid] of this.sessionToWorker) {
      if (wid === id) {
        this.sessionToWorker.delete(sid);
        // Also clean pending hooks for this session (edge case: session
        // registered then worker dies before replay completes)
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

  onUpdate(callback: (workerId: string, state: WorkerState) => void): void {
    this.listeners.push(callback);
  }

  tick(): void {
    const now = Date.now();
    for (const worker of this.workers.values()) {
      if (worker.status === "working" && now - worker.lastActionAt > IDLE_THRESHOLD) {
        // Check if process is alive before marking idle.
        // signal 0 doesn't kill — just checks existence.
        try {
          process.kill(worker.pid, 0);
          // Process alive — let discovery scan decide status via JSONL analysis.
          // Don't mark idle here; discovery's thinking detection handles the gap.
          continue;
        } catch {
          // Process confirmed dead — safe to mark idle
          this.toolInFlight.set(worker.id, false);
        }
        worker.status = "idle";
        worker.currentAction = null;
        this.notify(worker);
      }
    }
    // Auto-learn when dispatched tasks complete
    this.checkCompletedDispatches();
    // Drain queued messages to idle workers
    this.drainQueues();
    // Auto-dispatch from global task queue to idle agents
    this.dispatchFromQueue();
    // Expire stale pending hooks
    this.expirePendingHooks();
  }

  notifyExternal(worker: WorkerState): void {
    this.notify(worker);
  }

  /** Queue a message for a busy worker. Drained when worker goes idle. */
  enqueueMessage(workerId: string, content: string, source: string): void {
    if (!this.messageQueue.has(workerId)) {
      this.messageQueue.set(workerId, []);
    }
    this.messageQueue.get(workerId)!.push({ content, source, queuedAt: Date.now() });
  }

  /** Drain one queued message per idle worker per tick. */
  private drainQueues(): void {
    for (const [workerId, queue] of this.messageQueue) {
      if (queue.length === 0) continue;
      const worker = this.get(workerId);
      if (!worker?.tty || worker.status !== "idle") continue;
      // Don't drain during brief idle flickers — wait for stable idle (15s)
      if (Date.now() - worker.lastActionAt < 15_000) continue;

      const msg = queue.shift()!;
      // Drop messages queued over 30 minutes ago
      if (Date.now() - msg.queuedAt > 30 * 60 * 1000) {
        console.log(`[queue] ${worker.tty}: dropped stale message (queued ${Math.round((Date.now() - msg.queuedAt) / 60000)}m ago)`);
        continue;
      }

      const result = sendInputToTty(worker.tty, msg.content);
      if (result.ok) {
        worker.status = "working";
        worker.currentAction = "Thinking...";
        worker.lastAction = `Queued message (${msg.source})`;
        worker.lastActionAt = Date.now();
        worker.stuckMessage = undefined;
        this.markInputSent(workerId, msg.source);
        this.trackDispatch(workerId, msg.content.slice(0, 200));
        this.notifyExternal(worker);
        console.log(`[queue] ${worker.tty}: drained queued message (${queue.length} remaining)`);
      }
      // Only drain one per tick — let the worker process it before sending the next
      break;
    }
  }

  // --- Task queue (global work queue for idle agents) ---

  private loadQueue(): void {
    try {
      if (existsSync(QUEUE_PATH)) {
        const data = JSON.parse(readFileSync(QUEUE_PATH, "utf-8")) as {
          tasks: QueuedTask[];
          nextId: number;
          completedIds?: string[];
        };
        this.taskQueue = data.tasks || [];
        this.queueNextId = data.nextId || 1;
        for (const id of data.completedIds || []) this.completedTaskIds.add(id);
      }
    } catch {
      this.taskQueue = [];
    }
  }

  private saveQueue(): void {
    try {
      const dir = QUEUE_PATH.replace(/\/[^/]+$/, "");
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(QUEUE_PATH, JSON.stringify({
        tasks: this.taskQueue,
        nextId: this.queueNextId,
        completedIds: [...this.completedTaskIds].slice(-100), // keep last 100
      }, null, 2));
    } catch { /* best-effort */ }
  }

  pushTask(task: string, project?: string, priority = 10, blockedBy?: string): QueuedTask {
    const queued: QueuedTask = {
      id: `q${this.queueNextId++}`,
      task,
      project,
      priority,
      createdAt: Date.now(),
      blockedBy,
    };
    this.taskQueue.push(queued);
    this.taskQueue.sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt);
    this.saveQueue();
    console.log(`[task-queue] Added ${queued.id}: "${task.slice(0, 80)}..." (priority ${priority})`);
    return queued;
  }

  removeTask(taskId: string): boolean {
    const idx = this.taskQueue.findIndex(t => t.id === taskId);
    if (idx === -1) return false;
    this.taskQueue.splice(idx, 1);
    this.saveQueue();
    return true;
  }

  getTaskQueue(): QueuedTask[] {
    return [...this.taskQueue];
  }

  /** Auto-dispatch: pick the next eligible task and send to an idle agent. Called from tick(). */
  private dispatchFromQueue(): void {
    if (this.taskQueue.length === 0) return;

    // Find genuinely idle agents — must be idle AND not recently working.
    // The 15s cooldown prevents dispatching to agents that briefly flicker idle
    // during API thinking gaps (working→idle→working in 3-10 seconds).
    const now = Date.now();
    const idleWorkers = this.getAll().filter(w =>
      w.status === "idle" && w.tty && (now - w.lastActionAt > 15_000)
    );
    if (idleWorkers.length === 0) return;

    for (let i = 0; i < this.taskQueue.length; i++) {
      const task = this.taskQueue[i];

      // Check blockedBy: skip if the blocking task hasn't completed
      if (task.blockedBy && !this.completedTaskIds.has(task.blockedBy)) continue;

      // Find best idle worker: prefer project match, otherwise any idle agent
      let target = idleWorkers.find(w => task.project && w.project.includes(task.project));
      if (!target) target = idleWorkers[0];
      if (!target?.tty) continue;

      const result = sendInputToTty(target.tty, task.task);
      if (result.ok) {
        target.status = "working";
        target.currentAction = "Thinking...";
        target.lastAction = `Task queue: ${task.id}`;
        target.lastActionAt = Date.now();
        target.stuckMessage = undefined;
        this.markInputSent(target.id, "task-queue");
        this.trackDispatch(target.id, `Queue ${task.id}: ${task.task.slice(0, 150)}`);
        this.notifyExternal(target);

        // Remove from queue, mark completed
        this.taskQueue.splice(i, 1);
        this.completedTaskIds.add(task.id);
        this.saveQueue();
        console.log(`[task-queue] Dispatched ${task.id} to ${target.tty} (${this.taskQueue.length} remaining)`);

        // Remove this worker from candidates (one task per tick per worker)
        const targetIdx = idleWorkers.indexOf(target);
        if (targetIdx >= 0) idleWorkers.splice(targetIdx, 1);
        if (idleWorkers.length === 0) break;
        // Don't increment i — array shifted
        i--;
      }
    }
  }

  // --- Hook handling ---

  private handleHook(body: Record<string, unknown>): void {
    const sessionId = body.session_id as string | undefined;
    const eventName = body.hook_event_name as string | undefined;
    const toolName = body.tool_name as string | undefined;
    const toolInput = body.tool_input as Record<string, unknown> | undefined;
    const cwd = body.cwd as string | undefined;

    if (!sessionId || !eventName) return;

    // Find the worker this hook belongs to
    let workerId = this.sessionToWorker.get(sessionId);

    // Fallback: match by cwd. Prefer the most specific project match (longest path).
    // When multiple workers share the SAME project path → truly ambiguous → queue.
    // When one is a parent dir of another (e.g. ~ vs ~/factory/project) → pick the deeper one.
    if (!workerId && cwd) {
      const candidates: Array<{ id: string; pathLen: number }> = [];
      for (const w of this.workers.values()) {
        if (w.project === cwd || cwd.startsWith(w.project + "/")) {
          candidates.push({ id: w.id, pathLen: w.project.length });
        }
      }
      if (candidates.length >= 1) {
        // Sort by specificity (longest project path first)
        candidates.sort((a, b) => b.pathLen - a.pathLen);
        const best = candidates[0];
        // Check if there's a tie at the top (truly ambiguous — same project dir)
        const tied = candidates.filter(c => c.pathLen === best.pathLen);
        if (tied.length === 1) {
          workerId = best.id;
          // Don't cache — Discovery registers the canonical mapping.
        } else {
          // AMBIGUOUS — same project path, can't tell apart → queue for replay.
          this.enqueueHook(sessionId, body);
          return;
        }
      }
    }

    if (!workerId) {
      // No CWD match either — queue in case Discovery resolves it.
      this.enqueueHook(sessionId, body);
      return;
    }

    this.processHook(workerId, body, sessionId, eventName, toolName, toolInput, cwd);
  }

  /** Process a hook that has been resolved to a specific worker. */
  private processHook(
    workerId: string,
    body: Record<string, unknown>,
    sessionId: string,
    eventName: string,
    toolName: string | undefined,
    toolInput: Record<string, unknown> | undefined,
    cwd: string | undefined,
  ): void {
    const worker = this.workers.get(workerId);
    if (!worker) return;

    const now = Date.now();
    this.lastHookTime.set(workerId, now);
    worker.lastActionAt = now;

    // Update project from cwd if available (most accurate source)
    if (cwd) {
      const name = cwd.split("/").pop();
      if (name && name !== "rmgtni" && name !== "/") {
        worker.project = cwd;
        worker.projectName = name;
      }
    }

    switch (eventName) {
      case "PreToolUse": {
        // AskUserQuestion = Claude is asking the user to pick an option.
        // Treat as "stuck" so the dashboard shows the question + quick-reply buttons.
        if (toolName === "AskUserQuestion") {
          worker.status = "stuck";
          this.toolInFlight.set(workerId, false);
          worker.currentAction = "Asking a question";
          worker.stuckMessage = formatAskQuestion(toolInput);
          worker.lastAction = worker.currentAction;
          this.recordSignal(workerId, "PreToolUse", `AskUserQuestion → stuck`);
          break;
        }
        worker.status = "working";
        worker.stuckMessage = undefined;
        this.toolInFlight.set(workerId, true);
        this.idleConfirmed.set(workerId, false);
        const action = describeAction(toolName, toolInput);
        worker.currentAction = action;
        worker.lastAction = action;
        this.recordSignal(workerId, "PreToolUse", action);
        break;
      }

      case "PostToolUse": {
        worker.status = "working";
        worker.stuckMessage = undefined;
        this.toolInFlight.set(workerId, false);
        this.idleConfirmed.set(workerId, false);
        worker.currentAction = null;
        const postAction = describeAction(toolName, toolInput);
        worker.lastAction = postAction;
        this.recordSignal(workerId, "PostToolUse", postAction);
        // Track file modifications for cross-agent artifact reading
        if (toolName && toolInput) {
          const filePath = toolInput.file_path as string | undefined;
          if (filePath && (toolName === "Edit" || toolName === "Write")) {
            this.recordArtifact(workerId, filePath, toolName === "Edit" ? "edited" : "created");
          }
        }
        break;
      }

      case "Notification": {
        this.toolInFlight.set(workerId, false);
        const notifType = body.notification_type as string | undefined;
        const message = body.message as string | undefined;

        // idle_prompt = THE DONE SIGNAL. Claude finished its turn.
        // This is the definitive "I'm done" notification — set idle directly.
        // NOT stuck (auto-pilot ignores idle workers). Just done.
        if (notifType === "idle_prompt") {
          this.idleConfirmed.set(workerId, true);
          worker.status = "idle";
          worker.currentAction = null;
          worker.stuckMessage = undefined;
          worker.lastAction = "Waiting for input";
          this.recordSignal(workerId, "idle_prompt", "done");
          break;
        }

        worker.status = "stuck";
        if (notifType === "permission_prompt") {
          // Include tool context so dashboard shows WHAT needs permission
          if (toolName) {
            const desc = describeAction(toolName, toolInput);
            worker.currentAction = `Allow? ${desc}`;
          } else {
            worker.currentAction = "Waiting for permission";
          }
        } else {
          worker.currentAction = "Needs your attention";
        }

        // Store the actual prompt text so the dashboard can show real options
        worker.stuckMessage = message || undefined;
        worker.lastAction = worker.currentAction;
        break;
      }

      case "Stop":
      case "SessionEnd": {
        worker.status = "idle";
        worker.stuckMessage = undefined;
        this.toolInFlight.set(workerId, false);
        this.idleConfirmed.set(workerId, false);
        worker.currentAction = null;
        worker.lastAction = "Session ended";
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
    }

    this.notify(worker);
  }

  // --- Pending hook queue ---

  /** Queue a hook whose session_id isn't registered yet. */
  private enqueueHook(sessionId: string, body: Record<string, unknown>): void {
    if (!this.pendingHooks.has(sessionId)) {
      this.pendingHooks.set(sessionId, []);
    }
    const queue = this.pendingHooks.get(sessionId)!;
    if (queue.length >= TelemetryReceiver.HOOK_QUEUE_MAX_PER_SESSION) {
      queue.shift(); // Drop oldest to stay under cap
    }
    queue.push({ body, receivedAt: Date.now() });
    this.recordSignal("_pending", "hook_queued", `session=${sessionId.slice(0, 8)} queue=${queue.length}`);
  }

  /** Replay all queued hooks for a session that just got registered. */
  replayPendingHooks(sessionId: string, workerId: string): void {
    const queue = this.pendingHooks.get(sessionId);
    if (!queue || queue.length === 0) return;
    this.pendingHooks.delete(sessionId);

    const now = Date.now();
    let replayed = 0;
    for (const entry of queue) {
      // Skip expired hooks (process may have died before registration)
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

  /** Expire stale entries. Called from tick(). */
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

  // --- Original telemetry event handling ---

  private handleEvent(event: TelemetryEvent): void {
    const worker = this.workers.get(event.worker_id);
    if (!worker) return;

    const now = event.timestamp || Date.now();
    worker.lastActionAt = now;

    switch (event.event) {
      case "SessionStart":
        worker.status = "working";
        worker.errorCount = 0;
        worker.lastAction = "session started";
        worker.currentAction = null;
        break;

      case "PreToolUse":
        worker.status = "working";
        this.toolInFlight.set(event.worker_id, true);
        worker.currentAction = event.tool_name || "working";
        worker.lastAction = `using ${event.tool_name || "tool"}`;
        break;

      case "PostToolUse":
        worker.status = "working";
        this.toolInFlight.set(event.worker_id, false);
        worker.currentAction = null;
        worker.lastAction = event.summary || `completed ${event.tool_name || "tool"}`;
        break;

      case "Stop":
        worker.status = "idle";
        this.toolInFlight.set(event.worker_id, false);
        worker.currentAction = null;
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
    for (const listener of this.listeners) {
      listener(worker.id, worker);
    }
  }
}

/** Human-readable description of what a tool is doing */
function describeAction(
  toolName: string | undefined,
  toolInput: Record<string, unknown> | undefined
): string {
  if (!toolName) return "Working";

  const filePath = toolInput?.file_path as string | undefined;
  const fileName = filePath ? basename(filePath) : undefined;

  switch (toolName) {
    case "Bash":
      return (toolInput?.description as string) ||
        truncate(toolInput?.command as string, 50) ||
        "Running command";
    case "Edit":
      return fileName ? `Editing ${fileName}` : "Editing file";
    case "Write":
      return fileName ? `Writing ${fileName}` : "Writing file";
    case "Read":
      return fileName ? `Reading ${fileName}` : "Reading file";
    case "Grep":
      return toolInput?.pattern
        ? `Searching "${truncate(toolInput.pattern as string, 25)}"`
        : "Searching code";
    case "Glob":
      return toolInput?.pattern
        ? `Finding ${truncate(toolInput.pattern as string, 30)}`
        : "Finding files";
    case "WebFetch":
      return "Fetching web page";
    case "WebSearch":
      return `Searching web`;
    case "Task":
      return "Running subagent";
    default:
      return toolName.replace(/^mcp__\w+__/, "");
  }
}

function truncate(s: string | undefined, max: number): string {
  if (!s) return "";
  return s.length > max ? s.slice(0, max) + "..." : s;
}

/**
 * Format AskUserQuestion toolInput into a stuckMessage string
 * that the dashboard's quickButtons parser can read.
 *
 * Produces: "Question text?\n1. Option A\n2. Option B\n3. Option C"
 */
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
