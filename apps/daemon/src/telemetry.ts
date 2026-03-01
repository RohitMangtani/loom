import express from "express";
import type { Request, Response, NextFunction } from "express";
import { basename } from "path";
import type { Server } from "http";
import { validateToken } from "./auth.js";
import type { WorkerState, TelemetryEvent } from "./types.js";

const IDLE_THRESHOLD = 30_000; // 30 seconds without activity → idle

export class TelemetryReceiver {
  private workers = new Map<string, WorkerState>();
  private listeners: Array<(workerId: string, state: WorkerState) => void> = [];
  private server: Server | null = null;
  private port: number;

  // Hook support: session_id → worker_id
  private sessionToWorker = new Map<string, string>();
  // Track last hook event time per worker (discovery defers when hooks are fresh)
  private lastHookTime = new Map<string, number>();
  // True while a tool is mid-execution (between PreToolUse and PostToolUse).
  // Prevents idle timeout during long-running commands (Bash scripts, builds).
  private toolInFlight = new Map<string, boolean>();

  private token: string;

  constructor(port: number, token: string) {
    this.port = port;
    this.token = token;
  }

  start(): void {
    const app = express();
    app.use(express.json());

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

  registerSession(sessionId: string, workerId: string): void {
    this.sessionToWorker.set(sessionId, workerId);
  }

  getLastHookTime(workerId: string): number | undefined {
    return this.lastHookTime.get(workerId);
  }

  isToolInFlight(workerId: string): boolean {
    return this.toolInFlight.get(workerId) === true;
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
    this.notify(worker);
  }

  removeWorker(id: string): void {
    this.workers.delete(id);
    this.lastHookTime.delete(id);
    this.toolInFlight.delete(id);
    // Clean up session mappings pointing to this worker
    for (const [sid, wid] of this.sessionToWorker) {
      if (wid === id) this.sessionToWorker.delete(sid);
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
  }

  notifyExternal(worker: WorkerState): void {
    this.notify(worker);
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

    // Fallback: match by cwd
    if (!workerId && cwd) {
      for (const w of this.workers.values()) {
        if (w.project === cwd || cwd.startsWith(w.project + "/")) {
          workerId = w.id;
          this.sessionToWorker.set(sessionId, workerId);
          break;
        }
      }
    }

    if (!workerId) return;
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
        worker.status = "working";
        worker.stuckMessage = undefined;
        this.toolInFlight.set(workerId, true);
        const action = describeAction(toolName, toolInput);
        worker.currentAction = action;
        worker.lastAction = action;
        break;
      }

      case "PostToolUse": {
        worker.status = "working";
        worker.stuckMessage = undefined;
        this.toolInFlight.set(workerId, false);
        worker.currentAction = null;
        worker.lastAction = describeAction(toolName, toolInput);
        break;
      }

      case "Notification": {
        worker.status = "stuck";
        this.toolInFlight.set(workerId, false);
        const notifType = body.notification_type as string | undefined;
        const message = body.message as string | undefined;

        if (notifType === "permission_prompt") {
          // Include tool context so dashboard shows WHAT needs permission
          if (toolName) {
            const desc = describeAction(toolName, toolInput);
            worker.currentAction = `Allow? ${desc}`;
          } else {
            worker.currentAction = "Waiting for permission";
          }
        } else if (notifType === "idle_prompt") {
          worker.currentAction = "Waiting for input";
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
        worker.currentAction = null;
        worker.lastAction = "Session ended";
        break;
      }

      case "SessionStart": {
        worker.status = "working";
        worker.stuckMessage = undefined;
        worker.currentAction = null;
        worker.lastAction = "Session started";
        break;
      }
    }

    this.notify(worker);
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
