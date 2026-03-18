import { WebSocketServer, WebSocket } from "ws";
import { URL } from "url";
import { homedir } from "os";
import { realpathSync, unlinkSync } from "fs";
import { join } from "path";
import type { TelemetryReceiver } from "./telemetry.js";
import type { ProcessManager } from "./process-mgr.js";
import type { SessionStreamer } from "./session-stream.js";
import { sendSelectionToTty, sendEnterToTty } from "./tty-input.js";
import { spawnTerminalWindow, closeTerminalWindow } from "./arrange-windows.js";
import { validateToken } from "./auth.js";
import { ProcessDiscovery } from "./discovery.js";
import type { DaemonMessage, DaemonResponse } from "./types.js";
import type { WebPushManager } from "./web-push.js";

export class WsServer {
  private wss: WebSocketServer | null = null;
  private telemetry: TelemetryReceiver;
  private procMgr: ProcessManager;
  private streamer: SessionStreamer;
  private discovery: ProcessDiscovery | null = null;
  private port: number;
  private token: string;
  private viewerToken: string;
  private clients = new Set<WebSocket>();
  private readOnlyClients = new Set<WebSocket>();
  // Track which worker each client is subscribed to
  private clientSubs = new Map<WebSocket, string>();
  private lastWorkersSnapshot: string | null = null;
  private lastModelsSnapshot: string | null = null;
  private pushMgr: WebPushManager | null = null;

  constructor(
    telemetry: TelemetryReceiver,
    procMgr: ProcessManager,
    streamer: SessionStreamer,
    port: number,
    token: string,
    viewerToken: string
  ) {
    this.telemetry = telemetry;
    this.procMgr = procMgr;
    this.streamer = streamer;
    this.port = port;
    this.token = token;
    this.viewerToken = viewerToken;

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

    this.telemetry.onRemoval(() => {
      const workers = this.telemetry.getAll();
      this.lastWorkersSnapshot = JSON.stringify(workers);
      this.broadcast({
        type: "workers",
        workers,
      });
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

  /** Push full worker list to all clients. Call from the main tick loop
   *  so the dashboard stays current even when status changes come from
   *  discovery (JSONL/CPU analysis) instead of hooks. */
  pushState(): void {
    if (this.clients.size === 0) return;
    const workers = this.telemetry.getAll();
    const snapshot = JSON.stringify(workers);
    if (snapshot !== this.lastWorkersSnapshot) {
      this.lastWorkersSnapshot = snapshot;
      this.broadcast({ type: "workers", workers });
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
  }

  start(): void {
    this.wss = new WebSocketServer({ port: this.port, host: "127.0.0.1" });

    console.log(`  WebSocket server listening on 127.0.0.1:${this.port}`);

    this.wss.on("connection", (ws, req) => {
      // Auth: admin token = full access, no token / wrong token = view-only
      const reqUrl = new URL(req.url || "/", "http://localhost");
      const candidate = reqUrl.searchParams.get("token") || "";
      const isAdmin = candidate ? validateToken(candidate, this.token) : false;

      this.clients.add(ws);
      if (!isAdmin) this.readOnlyClients.add(ws);
      // Send current workers list — quadrants are already stamped by the 3s tick loop.
      const workers = this.telemetry.getAll();
      this.lastWorkersSnapshot = JSON.stringify(workers);
      this.send(ws, { type: "workers", workers });
      this.send(ws, { type: "auth", admin: isAdmin });
      // Send full review list on connect (hosted dashboard can't reach REST on port 3001)
      this.send(ws, { type: "reviews", reviews: this.telemetry.getReviews() });
      // Send available agent models for spawn dialog
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "models", models: this.getAvailableModels() }));
      }
      // Send VAPID public key for Web Push subscription
      if (this.pushMgr) {
        this.send(ws, { type: "vapid_key", vapidKey: this.pushMgr.getPublicKey() });
      }

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
      this.clientSubs.delete(ws);
    }
    this.clients.delete(ws);
    this.readOnlyClients.delete(ws);
  }

  private clientId(ws: WebSocket): string {
    // Use object identity as a simple unique key
    return String((ws as unknown as { _socket?: { remotePort?: number } })._socket?.remotePort || Math.random());
  }

  private handleMessage(ws: WebSocket, msg: DaemonMessage): void {
    // Read-only viewers can only request the worker list or manage push subscriptions
    if (this.readOnlyClients.has(ws) && msg.type !== "list" && msg.type !== "push_subscribe" && msg.type !== "push_unsubscribe") {
      this.send(ws, { type: "error", error: "Read-only access" });
      return;
    }

    // Reject oversized identifier fields (not content — messages must always send)
    if ((msg.project && msg.project.length > 1024) ||
        (msg.workerId && msg.workerId.length > 128) ||
        (msg.task && msg.task.length > 4096)) {
      this.send(ws, { type: "error", error: "Field too large" });
      return;
    }

    switch (msg.type) {
      case "subscribe": {
        if (!msg.workerId) {
          this.send(ws, { type: "error", error: "Missing workerId" });
          return;
        }

        // Unsubscribe from previous
        const prevSub = this.clientSubs.get(ws);
        if (prevSub) {
          this.streamer.unsubscribe(prevSub + "_" + this.clientId(ws));
        }

        const workerId = msg.workerId;
        this.clientSubs.set(ws, workerId);

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

        // Also register the session file mapping in the streamer
        // (discovery already does this, but just in case)
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
        const termResult = spawnTerminalWindow(real, model, openQ, initMessage, this.telemetry.getAll().length);
        if (!termResult.ok) {
          this.send(ws, { type: "error", error: termResult.error || "Failed to spawn terminal" });
          return;
        }

        // Mark TTY as freshly spawned so discovery skips heuristic session
        // file resolution — new agents start with blank chat history.
        if (termResult.tty) {
          this.telemetry.markSpawn(termResult.tty);
        }

        // Create an immediate placeholder worker so the dashboard tile
        // shows content before the 3-second discovery scan picks it up.
        if (termResult.tty) {
          const spawnTty = termResult.tty;
          const projectName = real.split("/").pop() || real;
          const placeholderId = `spawning_${spawnTty.replace(/\//g, "_")}`;
          const placeholder = {
            id: placeholderId,
            pid: 0,
            project: real,
            projectName,
            status: "waiting" as const,
            currentAction: "Starting...",
            lastAction: "Spawning terminal",
            lastActionAt: Date.now(),
            errorCount: 0,
            startedAt: Date.now(),
            task: null,
            managed: false,
            tty: spawnTty,
            model,
            terminalPreview: undefined,
          };
          this.telemetry.registerDiscovered(placeholderId, placeholder);

          // Poll terminal content every 1.5s until discovery replaces the
          // placeholder or 20s elapse — whichever comes first.
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
              // Detect "command not found" — CLI isn't installed
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
              const prompt = this.discovery.detectPrompt(spawnTty);
              if (prompt) {
                current.status = "waiting";
                current.promptType = prompt.type;
                current.promptMessage = prompt.message;
                current.currentAction = prompt.message;
                current.terminalPreview = prompt.content.split("\n").filter((l: string) => l.trim()).slice(-15).join("\n").trim().slice(0, 500) || undefined;
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
        break;
      }

      case "kill": {
        if (!msg.workerId) {
          this.send(ws, { type: "error", error: "Missing workerId" });
          return;
        }
        // Grab PID and TTY BEFORE any removal (procMgr.kill removes from telemetry)
        const killWorker = this.telemetry.get(msg.workerId);
        const killPid = killWorker?.pid;
        const killTty = killWorker?.tty;

        // Try ProcessManager first (for managed/spawned workers)
        this.procMgr.kill(msg.workerId);

        // SIGKILL immediately — process must be dead before we close the
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
            const result = closeTerminalWindow(killTty);
            if (!result.ok) {
              console.log(`[kill] Failed to close terminal ${killTty}: ${result.error}`);
            }
          }, 500);
        }
        console.log(`Killed worker ${msg.workerId} (pid=${killPid}, tty=${killTty})`);
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

        const extra = msg as DaemonMessage & {
          from?: string;
          contextWorkerIds?: string[];
          includeSenderContext?: boolean;
        };
        // Async send — does NOT block the event loop. Dashboard stays responsive.
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
        });
        break;
      }

      case "selection": {
        if (!msg.workerId) {
          this.send(ws, { type: "error", error: "Missing workerId" });
          return;
        }
        const selWorker = this.telemetry.get(msg.workerId);
        if (!selWorker?.tty) {
          this.send(ws, { type: "error", error: `Worker ${msg.workerId} not found or no TTY` });
          return;
        }
        // Allow selection if worker is stuck OR if it was recently stuck
        // (auto-pilot may have changed status to "working" but the prompt
        // is still displayed in the terminal waiting for input)
        const selResult = sendSelectionToTty(selWorker.tty, msg.optionIndex || 0);
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
        const promptWorker = this.telemetry.get(msg.workerId);
        if (!promptWorker?.tty) {
          this.send(ws, { type: "error", error: `Worker ${msg.workerId} not found or no TTY` });
          return;
        }
        if (!promptWorker.promptType) {
          this.send(ws, { type: "error", error: "No pending prompt" });
          return;
        }

        // Send Enter keystroke to approve the prompt (default option is pre-selected)
        const approveResult = sendEnterToTty(promptWorker.tty);
        if (approveResult.ok) {
          promptWorker.promptType = null;
          promptWorker.promptMessage = undefined;
          promptWorker.status = "idle";
          promptWorker.currentAction = "Starting...";
          promptWorker.lastAction = "Prompt approved from dashboard";
          promptWorker.lastActionAt = Date.now();
          if (this.discovery) {
            this.discovery.clearPromptCache(promptWorker.tty);
          }
          this.telemetry.notifyExternal(promptWorker);
          console.log(`Prompt approved for ${promptWorker.tty}`);
        } else {
          this.send(ws, { type: "error", error: approveResult.error || "Failed to approve prompt" });
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
}
