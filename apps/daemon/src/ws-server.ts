import { WebSocketServer, WebSocket } from "ws";
import { URL } from "url";
import { homedir } from "os";
import { realpathSync } from "fs";
import type { TelemetryReceiver } from "./telemetry.js";
import type { ProcessManager } from "./process-mgr.js";
import type { SessionStreamer } from "./session-stream.js";
import { sendInputToTty, sendSelectionToTty } from "./tty-input.js";
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

    this.telemetry.onRemoval(() => {
      this.broadcast({
        type: "workers",
        workers: this.telemetry.getAll(),
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
      // Send current workers list — viewers get this too (the whole point)
      this.send(ws, { type: "workers", workers: this.telemetry.getAll() });

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

        // Send chat history
        const history = this.streamer.readHistory(workerId);
        if (history.length > 0) {
          this.send(ws, { type: "chat_history", workerId, messages: history });
        }

        // Start streaming new messages
        const subKey = workerId + "_" + this.clientId(ws);
        this.streamer.subscribe(subKey, workerId, (entries) => {
          if (ws.readyState === WebSocket.OPEN) {
            this.send(ws, { type: "chat_history", workerId, messages: entries });
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
        if (!msg.project) {
          this.send(ws, { type: "error", error: "Missing project path" });
          return;
        }
        // Resolve ~ to home directory
        const home = homedir();
        const projectPath = msg.project.startsWith("~/")
          ? msg.project.replace("~", home)
          : msg.project;
        // Path traversal guard: real path (symlinks resolved) must be under home dir
        let real: string;
        try {
          real = realpathSync(projectPath);
        } catch {
          this.send(ws, { type: "error", error: "Invalid project path" });
          return;
        }
        if (!real.startsWith(home + "/")) {
          this.send(ws, { type: "error", error: "Invalid project path" });
          return;
        }
        const workerId = this.procMgr.spawn(real, msg.task || null);
        this.send(ws, {
          type: "workers",
          workers: this.telemetry.getAll(),
        });
        console.log(`Spawned worker ${workerId} for ${msg.project}`);
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

        // For managed workers: send via process stdin
        const sent = this.procMgr.sendMessage(msg.workerId, msg.content);
        if (sent) {
          // Instant green for managed workers too
          const managed = this.telemetry.get(msg.workerId);
          if (managed) {
            managed.status = "working";
            managed.currentAction = "Thinking...";
            managed.lastAction = "Received message";
            managed.lastActionAt = Date.now();
            managed.stuckMessage = undefined;
            this.telemetry.notifyExternal(managed);
          }
          // Rapid-poll the session file so the response shows up fast
          this.streamer.nudge(msg.workerId);
          break;
        }

        // For discovered workers: type into Terminal.app via AppleScript
        const worker = this.telemetry.get(msg.workerId);
        if (worker?.tty) {
          // Dashboard messages always send immediately — the user is intentionally
          // typing into the terminal regardless of agent status.
          const result = sendInputToTty(worker.tty, msg.content);
          if (result.ok) {
            worker.status = "working";
            worker.currentAction = "Thinking...";
            worker.lastAction = "Received message";
            worker.lastActionAt = Date.now();
            worker.stuckMessage = undefined;
            this.telemetry.markDashboardInput(msg.workerId);
            this.telemetry.markInputSent(msg.workerId, "dashboard");
            this.telemetry.notifyExternal(worker);
            // Rapid-poll the session file so the response shows up fast
            this.streamer.nudge(msg.workerId);
            console.log(`Typed into ${worker.tty}: ${msg.content.slice(0, 50)}`);
          } else {
            this.send(ws, {
              type: "error",
              error: result.error || `Failed to send to ${worker.tty}`,
            });
          }
        } else {
          this.send(ws, {
            type: "error",
            error: `Worker ${msg.workerId} not found or no TTY`,
          });
        }
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
        // Guard: only send if still stuck (prevents double-send if auto-pilot already handled it)
        if (selWorker.status !== "stuck") {
          this.send(ws, { type: "error", error: "Already handled" });
          return;
        }
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
