import type { Request, Response, NextFunction } from "express";
import type express from "express";
import { join } from "path";
import { existsSync, mkdirSync, appendFileSync, readFileSync, readdirSync, statSync, realpathSync } from "fs";
import { sendInputToTty } from "./tty-input.js";
import type { ProcessManager } from "./process-mgr.js";
import type { ProcessDiscovery } from "./discovery.js";
import type { TelemetryReceiver } from "./telemetry.js";

export function registerApiRoutes(
  app: ReturnType<typeof express>,
  requireAuth: (req: Request, res: Response, next: NextFunction) => void,
  receiver: TelemetryReceiver,
  procMgr: ProcessManager,
  discovery: ProcessDiscovery,
): void {

  // GET /api/workers
  app.get("/api/workers", requireAuth, (_req, res) => {
    res.json(receiver.getAll());
  });

  // POST /api/message
  app.post("/api/message", requireAuth, (req, res) => {
    const { workerId, content } = req.body as { workerId?: string; content?: string };
    if (!workerId || !content) {
      res.status(400).json({ error: "Missing workerId or content" });
      return;
    }

    const sent = procMgr.sendMessage(workerId, content);
    if (sent) {
      const managed = receiver.get(workerId);
      if (managed) {
        managed.status = "working";
        managed.currentAction = "Thinking...";
        managed.lastAction = "Received message";
        managed.lastActionAt = Date.now();
        managed.stuckMessage = undefined;
        receiver.notifyExternal(managed);
      }
      receiver.trackDispatch(workerId, content.slice(0, 200));
      res.json({ ok: true });
      return;
    }

    const worker = receiver.get(workerId);
    if (!worker?.tty) {
      res.status(404).json({ error: `Worker ${workerId} not found or no TTY` });
      return;
    }

    if (worker.status === "working") {
      const msgId = receiver.enqueueMessage(workerId, content, "api:message");
      const queue = receiver.getMessageQueueSize(workerId);
      console.log(`[queue] ${worker.tty}: queued ${msgId} (${queue} pending, worker ${worker.status})`);
      res.json({ ok: true, queued: true, id: msgId, position: queue });
      return;
    }

    const result = sendInputToTty(worker.tty, content);
    if (result.ok) {
      worker.status = "working";
      worker.currentAction = "Thinking...";
      worker.lastAction = "Received message";
      worker.lastActionAt = Date.now();
      worker.stuckMessage = undefined;
      receiver.setIdleConfirmed(workerId, false);
      receiver.markInputSent(workerId, "api:message");
      receiver.trackDispatch(workerId, content.slice(0, 200));
      receiver.notifyExternal(worker);
      res.json({ ok: true });
    } else {
      res.status(500).json({ error: result.error || `Failed to send to ${worker.tty}` });
    }
  });

  // GET /api/message-queue
  app.get("/api/message-queue", requireAuth, (_req, res) => {
    res.json(receiver.getMessageQueueDetails());
  });

  // DELETE /api/message-queue/:id
  app.delete("/api/message-queue/:id", requireAuth, (req, res) => {
    const cancelled = receiver.cancelMessage(req.params.id as string);
    if (cancelled) {
      res.json({ ok: true, cancelled: req.params.id });
    } else {
      res.status(404).json({ error: `Message ${req.params.id} not found in queue` });
    }
  });

  // GET /api/queue
  app.get("/api/queue", requireAuth, (_req, res) => {
    res.json(receiver.getTaskQueue());
  });

  // POST /api/queue
  app.post("/api/queue", requireAuth, (req, res) => {
    const { task, project, priority, blockedBy, workflowId } = req.body as {
      task?: string; project?: string; priority?: number; blockedBy?: string; workflowId?: string;
    };
    if (!task) {
      res.status(400).json({ error: "Missing task" });
      return;
    }
    const queued = receiver.pushTask(task, project, priority ?? 10, blockedBy, workflowId);
    res.json({ ok: true, task: queued, remaining: receiver.getTaskQueueLength() });
  });

  // DELETE /api/queue/:id
  app.delete("/api/queue/:id", requireAuth, (req, res) => {
    const removed = receiver.removeTask(req.params.id as string);
    if (removed) {
      res.json({ ok: true, remaining: receiver.getTaskQueueLength() });
    } else {
      res.status(404).json({ error: `Task ${req.params.id} not found in queue` });
    }
  });

  // GET /api/audit
  app.get("/api/audit", requireAuth, (req, res) => {
    const tty = req.query.tty as string | undefined;
    res.json(discovery.getAuditLog(tty));
  });

  // GET /api/artifacts
  app.get("/api/artifacts", requireAuth, (req, res) => {
    const workerId = req.query.workerId as string | undefined;
    if (workerId) {
      res.json(receiver.getArtifacts(workerId));
    } else {
      const all: Record<string, Array<{ path: string; action: string; ts: number }>> = {};
      for (const w of receiver.getAll()) {
        const arts = receiver.getArtifacts(w.id);
        if (arts.length > 0) all[w.id] = arts;
      }
      res.json(all);
    }
  });

  // GET /api/conflicts
  app.get("/api/conflicts", requireAuth, (req, res) => {
    const path = req.query.path as string | undefined;
    const exclude = req.query.excludeWorker as string | undefined;
    if (!path) {
      res.status(400).json({ error: "Missing path query parameter" });
      return;
    }
    const conflicts = receiver.checkConflicts(path, exclude);
    res.json({ path, conflicts, hasConflict: conflicts.length > 0 });
  });

  // POST /api/learning
  app.post("/api/learning", requireAuth, (req, res) => {
    const { project, lesson } = req.body as { project?: string; lesson?: string };
    if (!project || !lesson) {
      res.status(400).json({ error: "Missing project or lesson" });
      return;
    }

    const claudeDir = join(project, ".claude");
    const learningFile = join(claudeDir, "hive-learnings.md");

    try {
      if (!existsSync(claudeDir)) {
        mkdirSync(claudeDir, { recursive: true });
      }

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

  // GET /api/signals
  app.get("/api/signals", requireAuth, (req, res) => {
    const workerId = req.query.workerId as string | undefined;
    res.json(receiver.getSignals(workerId));
  });

  // GET /api/locks
  app.get("/api/locks", requireAuth, (_req, res) => {
    res.json(receiver.getAllLocks());
  });

  // POST /api/locks
  app.post("/api/locks", requireAuth, (req, res) => {
    const { workerId, path } = req.body as { workerId?: string; path?: string };
    if (!workerId || !path) {
      res.status(400).json({ error: "Missing workerId or path" });
      return;
    }
    const result = receiver.acquireLock(path, workerId);
    if (result.acquired) {
      res.json({ ok: true, locked: path });
    } else {
      res.status(409).json({
        error: `File locked by ${result.holder?.tty || result.holder?.workerId}`,
        holder: result.holder,
      });
    }
  });

  // DELETE /api/locks
  app.delete("/api/locks", requireAuth, (req, res) => {
    const workerId = req.query.workerId as string | undefined;
    const path = req.query.path as string | undefined;
    if (!workerId) {
      res.status(400).json({ error: "Missing workerId query parameter" });
      return;
    }
    if (path) {
      const released = receiver.releaseLock(path, workerId);
      res.json({ ok: true, released });
    } else {
      const count = receiver.releaseAllLocks(workerId);
      res.json({ ok: true, releasedCount: count });
    }
  });

  // POST /api/scratchpad
  app.post("/api/scratchpad", requireAuth, (req, res) => {
    const { key, value, setBy } = req.body as { key?: string; value?: string; setBy?: string };
    if (!key || value === undefined) {
      res.status(400).json({ error: "Missing key or value" });
      return;
    }
    const entry = receiver.setScratchpad(key, value, setBy || "unknown");
    res.json({ ok: true, entry });
  });

  // GET /api/scratchpad
  app.get("/api/scratchpad", requireAuth, (req, res) => {
    const key = req.query.key as string | undefined;
    if (key) {
      const entry = receiver.getScratchpad(key);
      if (entry) {
        res.json(entry);
      } else {
        res.status(404).json({ error: `Key "${key}" not found` });
      }
      return;
    }
    res.json(receiver.getAllScratchpad());
  });

  // DELETE /api/scratchpad
  app.delete("/api/scratchpad", requireAuth, (req, res) => {
    const key = req.query.key as string | undefined;
    if (!key) {
      res.status(400).json({ error: "Missing key query parameter" });
      return;
    }
    const deleted = receiver.deleteScratchpad(key);
    res.json({ ok: true, deleted });
  });

  // GET /api/debug
  app.get("/api/debug", requireAuth, (_req, res) => {
    res.json(receiver.getDebugState(discovery));
  });

  // POST /api/spawn
  app.post("/api/spawn", requireAuth, (req, res) => {
    const { project, task } = req.body as { project?: string; task?: string };
    if (!project) {
      res.status(400).json({ error: "Missing project" });
      return;
    }

    const HOME = process.env.HOME || `/Users/${process.env.USER}`;
    const resolved = project.startsWith("~/") ? join(HOME, project.slice(2)) : project;

    let realPath: string;
    try {
      realPath = realpathSync(resolved);
    } catch {
      res.status(400).json({ error: `Project path does not exist: ${resolved}` });
      return;
    }

    if (!realPath.startsWith(HOME)) {
      res.status(403).json({ error: "Project path must be under home directory" });
      return;
    }

    if (receiver.getAll().length >= 4) {
      res.status(409).json({ error: "All 4 slots are occupied" });
      return;
    }

    const workerId = procMgr.spawn(realPath, task || null);
    res.json({ ok: true, workerId });
  });

  // GET /api/projects
  app.get("/api/projects", requireAuth, (_req, res) => {
    const HOME = process.env.HOME || `/Users/${process.env.USER}`;
    const projectsDir = join(HOME, "factory", "projects");
    try {
      const entries = readdirSync(projectsDir);
      const projects = entries
        .filter(name => {
          try {
            return statSync(join(projectsDir, name)).isDirectory();
          } catch { return false; }
        })
        .map(name => ({ name, path: join(projectsDir, name) }));
      res.json({ projects });
    } catch {
      res.json({ projects: [] });
    }
  });

  // GET /api/notifications/config
  app.get("/api/notifications/config", requireAuth, (_req, res) => {
    const HOME = process.env.HOME || `/Users/${process.env.USER}`;
    const configPath = join(HOME, ".hive", "notifications.json");
    try {
      if (existsSync(configPath)) {
        const config = JSON.parse(readFileSync(configPath, "utf-8"));
        res.json(config);
      } else {
        res.json({ enabled: true, cooldownMs: 60000, errorThreshold: 3, sound: true });
      }
    } catch {
      res.status(500).json({ error: "Failed to read notification config" });
    }
  });

  console.log("  Dispatch API registered: /api/workers, /api/message, /api/message-queue, /api/queue, /api/locks, /api/conflicts, /api/scratchpad, /api/audit, /api/artifacts, /api/learning, /api/signals, /api/debug, /api/spawn, /api/projects, /api/notifications/config");
}
