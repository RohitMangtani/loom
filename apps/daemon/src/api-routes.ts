import type { Request, Response, NextFunction } from "express";
import type express from "express";
import { join } from "path";
import { existsSync, mkdirSync, appendFileSync, readFileSync, readdirSync, statSync, realpathSync } from "fs";
import type { ProcessManager } from "./process-mgr.js";
import { ProcessDiscovery } from "./discovery.js";
import type { TelemetryReceiver } from "./telemetry.js";
import { getControlPlaneAuditPath, readControlPlaneAudit } from "./control-plane-audit.js";
import {
  isSafeCommandField,
  isSafeMachineId,
  isSafeModelId,
  isSafePathField,
  isSafeTaskField,
  isSafeWorkerId,
  isValidQuadrant,
  isValidSatelliteAction,
} from "./control-plane-guards.js";

export function registerApiRoutes(
  app: ReturnType<typeof express>,
  requireAuth: (req: Request, res: Response, next: NextFunction) => void,
  receiver: TelemetryReceiver,
  procMgr: ProcessManager,
  discovery: ProcessDiscovery,
): void {

  // GET /api/workers  --  includes satellite workers when available
  app.get("/api/workers", requireAuth, (_req, res) => {
    res.json(receiver.getAllWorkersIncludingSatellites());
  });

  // POST /api/message  --  routes to satellite workers transparently
  app.post("/api/message", requireAuth, async (req, res) => {
    const {
      workerId,
      content,
      from,
      contextWorkerIds,
      includeSenderContext,
    } = req.body as {
      workerId?: string;
      content?: string;
      from?: string;
      contextWorkerIds?: string[];
      includeSenderContext?: boolean;
    };
    if (!workerId || !content) {
      res.status(400).json({ error: "Missing workerId or content" });
      return;
    }
    if (!isSafeWorkerId(workerId)) {
      res.status(400).json({ error: "Invalid workerId" });
      return;
    }
    if (from && !isSafeWorkerId(from)) {
      res.status(400).json({ error: "Invalid from workerId" });
      return;
    }
    if (contextWorkerIds && contextWorkerIds.some((id) => !isSafeWorkerId(id))) {
      res.status(400).json({ error: "Invalid context workerId" });
      return;
    }

    // Try satellite relay first (workerId contains "machineId:localId")
    const satelliteResult = await receiver.relaySatelliteMessage(workerId, content, from);
    if (satelliteResult) {
      if (!satelliteResult.ok) {
        res.status(502).json({ error: satelliteResult.error });
      } else {
        res.json(satelliteResult);
      }
      return;
    }

    // Local worker
    const result = await receiver.sendToWorkerAsync(workerId, content, {
      source: from ? `api:message:from:${from}` : "api:message",
      withIdentity: true,
      trackDispatch: true,
      taskBrief: content.slice(0, 200),
      fromWorkerId: from,
      contextWorkerIds,
      includeSenderContext,
    });
    if (!result.ok) {
      const worker = receiver.get(workerId);
      res.status(worker ? 500 : 404).json({ error: result.error });
      return;
    }
    res.json(result);
  });

  // GET /api/context  --  transparently queries satellite workers
  app.get("/api/context", requireAuth, async (req, res) => {
    const workerId = req.query.workerId as string | undefined;
    const workerIds = typeof req.query.workerIds === "string"
      ? req.query.workerIds.split(",").map((id) => id.trim()).filter(Boolean)
      : undefined;
    const history = req.query.history === "1" || req.query.history === "true";
    const historyLimit = Number(req.query.historyLimit || 6);
    const options = {
      includeHistory: history,
      historyLimit: Number.isFinite(historyLimit) ? Math.max(1, Math.min(12, historyLimit)) : 6,
    };

    if (workerId) {
      // Try local first, then relay to satellite if needed
      const context = await receiver.getWorkerContextAsync(workerId, options);
      if (!context) {
        res.status(404).json({ error: `Worker ${workerId} not found` });
        return;
      }
      res.json(context);
      return;
    }

    res.json(receiver.getWorkerContexts({
      ...options,
      ...(workerIds ? { workerIds } : {}),
    }));
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
    const { task, project, priority, blockedBy, workflowId, verify, maxVerifyAttempts, autoCommit, requires, preferMachine, model } = req.body as {
      task?: string; project?: string; priority?: number; blockedBy?: string; workflowId?: string;
      verify?: boolean; maxVerifyAttempts?: number; autoCommit?: boolean;
      requires?: string[]; preferMachine?: string; model?: string;
    };
    if (!task) {
      res.status(400).json({ error: "Missing task" });
      return;
    }
    const queued = receiver.pushTask(task, project, priority ?? 10, blockedBy, workflowId, verify, maxVerifyAttempts, autoCommit, requires, preferMachine, model);
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

  // GET /api/learnings?q=keyword&project=/path/to/project&limit=5
  // Search learnings by keyword. Returns the most relevant entries instead
  // of forcing the agent to read the entire file and waste context window.
  app.get("/api/learnings", requireAuth, (req, res) => {
    const query = ((req.query.q || req.query.query || "") as string).toLowerCase().trim();
    const projectPath = req.query.project as string | undefined;
    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 5, 1), 20);

    // Collect learnings from all known projects (or a specific one)
    const results: Array<{ project: string; entry: string; score: number }> = [];
    const searchTerms = query.split(/\s+/).filter(Boolean);

    const scanProject = (projPath: string) => {
      const file = join(projPath, ".claude", "hive-learnings.md");
      if (!existsSync(file)) return;
      try {
        const content = readFileSync(file, "utf-8");
        const lines = content.split("\n").filter(l => l.startsWith("- ["));
        const projName = projPath.split("/").pop() || projPath;
        for (const line of lines) {
          const lower = line.toLowerCase();
          if (!query) {
            // No query = return latest entries
            results.push({ project: projName, entry: line, score: 0 });
          } else {
            // Score by how many search terms match
            let score = 0;
            for (const term of searchTerms) {
              if (lower.includes(term)) score++;
            }
            if (score > 0) {
              results.push({ project: projName, entry: line, score });
            }
          }
        }
      } catch { /* skip unreadable */ }
    };

    if (projectPath) {
      scanProject(projectPath);
    } else {
      // Scan all projects that have learnings
      const workers = receiver.getAll();
      const scanned = new Set<string>();
      for (const w of workers) {
        if (!scanned.has(w.project)) {
          scanned.add(w.project);
          scanProject(w.project);
        }
      }
    }

    // Sort: by score (descending), then by recency (latest first)
    results.sort((a, b) => b.score - a.score);
    const top = query ? results.slice(0, limit) : results.slice(-limit).reverse();
    res.json({ query: query || null, count: top.length, total: results.length, results: top });
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

  // POST /api/update-satellites  --  tell all satellites to pull and restart
  app.post("/api/update-satellites", requireAuth, (_req, res) => {
    receiver.updateSatellites();
    res.json({ ok: true });
  });

  // POST /api/spawn
  app.post("/api/spawn", requireAuth, (req, res) => {
    const { project, model, task, targetQuadrant, machine } = req.body as {
      project?: string;
      model?: string;
      task?: string;
      targetQuadrant?: number;
      machine?: string;
    };
    if (project && !isSafePathField(project)) {
      res.status(400).json({ error: "Invalid project path" });
      return;
    }
    if (model && !isSafeModelId(model)) {
      res.status(400).json({ error: "Invalid model" });
      return;
    }
    if (task && !isSafeTaskField(task)) {
      res.status(400).json({ error: "Invalid task" });
      return;
    }
    if (machine && !isSafeMachineId(machine)) {
      res.status(400).json({ error: "Invalid machine" });
      return;
    }
    if (!isValidQuadrant(targetQuadrant)) {
      res.status(400).json({ error: "Invalid targetQuadrant" });
      return;
    }
    const result = receiver.spawnViaSwarm({ project, model, task, targetQuadrant, machine });
    if (!result.ok) {
      const message = typeof result.error === "string" ? result.error : "Failed to spawn worker";
      const status = message.includes("not connected") ? 404
        : message.includes("Invalid project path") ? 400
          : message.includes("All 8 slots") ? 409
            : 500;
      res.status(status).json({ error: message });
      return;
    }
    res.json(result);
  });

  // POST /api/kill
  app.post("/api/kill", requireAuth, (req, res) => {
    const { workerId } = req.body as { workerId?: string };
    if (!workerId) {
      res.status(400).json({ error: "Missing workerId" });
      return;
    }
    if (!isSafeWorkerId(workerId)) {
      res.status(400).json({ error: "Invalid workerId" });
      return;
    }
    const result = receiver.killViaSwarm(workerId);
    if (!result.ok) {
      const message = typeof result.error === "string" ? result.error : `Worker ${workerId} not found`;
      res.status(message.includes("not found") ? 404 : 500).json({ error: message });
      return;
    }
    res.json(result);
  });

  // POST /api/satellites/repair
  app.post("/api/satellites/repair", requireAuth, (req, res) => {
    const { machine, action } = req.body as { machine?: string; action?: string };
    if (!machine) {
      res.status(400).json({ error: "Missing machine" });
      return;
    }
    if (!isSafeMachineId(machine)) {
      res.status(400).json({ error: "Invalid machine" });
      return;
    }
    if (!isValidSatelliteAction(action)) {
      res.status(400).json({ error: "Invalid action" });
      return;
    }
    const result = receiver.maintainSatelliteViaSwarm(machine, action);
    if (!result.ok) {
      const message = typeof result.error === "string" ? result.error : `Machine ${machine} not found`;
      res.status(message.includes("not connected") || message.includes("not found") ? 404 : 500).json({ error: message });
      return;
    }
    res.json(result);
  });

  // POST /api/exec
  app.post("/api/exec", requireAuth, async (req, res) => {
    const { command, cwd, timeoutMs, machine } = req.body as {
      command?: string;
      cwd?: string;
      timeoutMs?: number;
      machine?: string;
    };
    if (!command?.trim()) {
      res.status(400).json({ error: "Missing command" });
      return;
    }
    if (!isSafeCommandField(command)) {
      res.status(400).json({ error: "Invalid command" });
      return;
    }
    if (cwd && !isSafePathField(cwd)) {
      res.status(400).json({ error: "Invalid working directory" });
      return;
    }
    if (machine && !isSafeMachineId(machine)) {
      res.status(400).json({ error: "Invalid machine" });
      return;
    }
    const result = await receiver.execViaSwarm({
      command,
      cwd,
      timeoutMs,
      machine,
    });
    if (result.error && result.exitCode == null) {
      const message = result.error;
      const status = result.timedOut ? 408
        : message.includes("not connected") ? 404
        : message.includes("Working directory not found") ? 400
          : 500;
      res.status(status).json(result);
      return;
    }
    res.json(result);
  });

  // GET /api/control-plane-audit
  app.get("/api/control-plane-audit", requireAuth, (req, res) => {
    const limit = Number(req.query.limit || 100);
    res.json({
      path: getControlPlaneAuditPath(),
      entries: readControlPlaneAudit(limit),
    });
  });

  // GET /api/models  --  returns built-in + custom agent types for spawn dialog
  app.get("/api/models", requireAuth, (_req, res) => {
    const builtIn = [
      { id: "claude", label: "Claude" },
      { id: "codex", label: "Codex" },
      { id: "openclaw", label: "OpenClaw" },
    ];
    const custom = ProcessDiscovery.getCustomAgents().map(a => ({
      id: a.id,
      label: a.label,
    }));
    res.json([...builtIn, ...custom]);
  });

  // GET /api/projects  --  auto-detect git repos in common directories
  app.get("/api/projects", requireAuth, (_req, res) => {
    res.json(receiver.getSwarmProjects());
  });

  // GET /api/reviews
  app.get("/api/reviews", requireAuth, (req, res) => {
    const unseen = req.query.unseen === "1" || req.query.unseen === "true";
    res.json(unseen ? receiver.getUnseenReviews() : receiver.getReviews());
  });

  // POST /api/reviews  --  agent self-reporting
  app.post("/api/reviews", requireAuth, (req, res) => {
    const { summary, url, type, workerId } = req.body as {
      summary?: string; url?: string; type?: string; workerId?: string;
    };
    if (!summary) {
      res.status(400).json({ error: "Missing summary" });
      return;
    }
    // Resolve worker and project name
    const worker = workerId ? receiver.get(workerId) : undefined;
    const projectName = worker?.projectName || "unknown";
    const resolvedWorkerId = workerId || "api";
    const reviewType = (type || "general") as "deploy" | "commit" | "pr" | "push" | "review-needed" | "general";
    const review = receiver.addReview(summary, resolvedWorkerId, projectName, { url, type: reviewType });
    res.json({ ok: true, review });
  });

  // PATCH /api/reviews/:id  --  mark as seen
  app.patch("/api/reviews/:id", requireAuth, (req, res) => {
    const action = req.body?.action as string | undefined;
    if (action === "seen") {
      const ok = receiver.markReviewSeen(req.params.id as string);
      res.json({ ok });
    } else {
      res.status(400).json({ error: "Unknown action" });
    }
  });

  // PATCH /api/reviews  --  mark all seen
  app.patch("/api/reviews", requireAuth, (_req, res) => {
    const count = receiver.markAllReviewsSeen();
    res.json({ ok: true, marked: count });
  });

  // DELETE /api/reviews/:id
  app.delete("/api/reviews/:id", requireAuth, (req, res) => {
    const dismissed = receiver.dismissReview(req.params.id as string);
    if (dismissed) {
      res.json({ ok: true });
    } else {
      res.status(404).json({ error: `Review ${req.params.id} not found` });
    }
  });

  // DELETE /api/reviews  --  clear all reviews
  app.delete("/api/reviews", requireAuth, (_req, res) => {
    const count = receiver.clearAllReviews();
    res.json({ ok: true, cleared: count });
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

  // POST /api/rearrange  --  force rearrange terminal windows
  app.post("/api/rearrange", requireAuth, (_req, res) => {
    receiver.forceRearrange();
    res.json({ ok: true });
  });

  // GET /api/capabilities  --  list all machine capabilities across the swarm
  app.get("/api/capabilities", requireAuth, (_req, res) => {
    res.json(receiver.getSwarmCapabilities());
  });

  console.log("  Dispatch API registered: /api/workers, /api/context, /api/message, /api/message-queue, /api/queue, /api/locks, /api/conflicts, /api/scratchpad, /api/audit, /api/artifacts, /api/learning, /api/signals, /api/debug, /api/spawn, /api/kill, /api/satellites/repair, /api/exec, /api/projects, /api/reviews, /api/notifications/config, /api/rearrange, /api/capabilities, /api/control-plane-audit");
}
