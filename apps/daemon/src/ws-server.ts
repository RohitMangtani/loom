import { WebSocketServer, WebSocket } from "ws";
import { URL } from "url";
import { homedir } from "os";
import { realpathSync } from "fs";
import type { TelemetryReceiver } from "./telemetry.js";
import type { ProcessManager } from "./process-mgr.js";
import type { SessionStreamer } from "./session-stream.js";
import { sendSelectionToTty } from "./tty-input.js";
import { spawnTerminalWindow } from "./arrange-windows.js";
import { validateToken } from "./auth.js";
import type { DaemonMessage, DaemonResponse } from "./types.js";

export class WsServer {
  private wss: WebSocketServer | null = null;
  private telemetry: TelemetryReceiver;
  private procMgr: ProcessManager;
  private streamer: SessionStreamer;
  private port: number;
  private token: string;
  private viewerToken: string;
  private clients = new Set<WebSocket>();
  private readOnlyClients = new Set<WebSocket>();
  // Track which worker each client is subscribed to
  private clientSubs = new Map<WebSocket, string>();
  private lastWorkersSnapshot: string | null = null;

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

  /** Push full worker list to all clients. Call from the main tick loop
   *  so the dashboard stays current even when status changes come from
   *  discovery (JSONL/CPU analysis) instead of hooks. */
  pushState(): void {
    if (this.clients.size === 0) return;
    const workers = this.telemetry.getAll();
    const snapshot = JSON.stringify(workers);
    if (snapshot === this.lastWorkersSnapshot) return;
    this.lastWorkersSnapshot = snapshot;
    this.broadcast({ type: "workers", workers });
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
    // Read-only viewers can only request the worker list
    if (this.readOnlyClients.has(ws) && msg.type !== "list") {
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
        // Use the requested quadrant if provided and available, otherwise first open
        const requestedQ = typeof msg.targetQuadrant === "number" && msg.targetQuadrant >= 1 && msg.targetQuadrant <= 4
          ? msg.targetQuadrant
          : undefined;
        const openQ = requestedQ ?? this.telemetry.getFirstOpenQuadrant();

        // Auto-send an init message after the agent starts (task or "hi")
        const initMessage = msg.task?.trim() || "hi";

        // Open a real Terminal window with the CLI, positioned in the target quadrant
        const termResult = spawnTerminalWindow(real, model, openQ, initMessage);
        if (!termResult.ok) {
          this.send(ws, { type: "error", error: termResult.error || "Failed to spawn terminal" });
          return;
        }

        // Discovery will detect the new process on its next scan cycle.
        // Send current workers back; the new one will appear after discovery runs.
        this.send(ws, {
          type: "workers",
          workers: this.telemetry.getAll(),
        });
        console.log(`Spawned ${model} terminal for ${msg.project}`);
        break;
      }

      case "kill": {
        if (!msg.workerId) {
          this.send(ws, { type: "error", error: "Missing workerId" });
          return;
        }
        this.procMgr.kill(msg.workerId);
        console.log(`Killed worker ${msg.workerId}`);
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

      case "orchestrator": {
        this.send(ws, {
          type: "orchestrator",
          content: "Orchestrator not yet implemented",
        });
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
