import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "crypto";
import type { TelemetryReceiver } from "./telemetry.js";
import type { ProcessManager } from "./process-mgr.js";
import type { DaemonMessage, DaemonResponse } from "./types.js";

export class WsServer {
  private wss: WebSocketServer | null = null;
  private telemetry: TelemetryReceiver;
  private procMgr: ProcessManager;
  private port: number;
  private token: string;
  private authenticated = new Set<WebSocket>();

  constructor(
    telemetry: TelemetryReceiver,
    procMgr: ProcessManager,
    port: number
  ) {
    this.telemetry = telemetry;
    this.procMgr = procMgr;
    this.port = port;
    this.token = randomUUID();

    // Forward telemetry updates to all connected clients
    this.telemetry.onUpdate((worker) => {
      this.broadcast({
        type: "worker_update",
        worker,
        workerId: worker.id,
      });
    });

    // Forward worker stdout to all clients
    this.procMgr.setOutputHandler((workerId, data) => {
      this.broadcast({
        type: "chat",
        workerId,
        content: data,
      });
    });
  }

  start(): void {
    this.wss = new WebSocketServer({ port: this.port });

    console.log(`  WebSocket server listening on port ${this.port}`);
    console.log(`  Auth token: ${this.token}`);

    this.wss.on("connection", (ws) => {
      // First message must be auth
      let isFirstMessage = true;

      ws.on("message", (raw) => {
        let msg: DaemonMessage;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          ws.send(
            JSON.stringify({ type: "error", error: "Invalid JSON" } satisfies DaemonResponse)
          );
          return;
        }

        // Auth check on first message
        if (isFirstMessage) {
          isFirstMessage = false;
          if (msg.token !== this.token) {
            ws.close(4001, "Unauthorized");
            return;
          }
          this.authenticated.add(ws);
        } else if (!this.authenticated.has(ws)) {
          ws.close(4001, "Unauthorized");
          return;
        }

        // Verify token on every message
        if (msg.token !== this.token) {
          ws.send(
            JSON.stringify({
              type: "error",
              error: "Invalid token",
            } satisfies DaemonResponse)
          );
          return;
        }

        this.handleMessage(ws, msg);
      });

      ws.on("close", () => {
        this.authenticated.delete(ws);
      });

      ws.on("error", () => {
        this.authenticated.delete(ws);
      });
    });
  }

  private handleMessage(ws: WebSocket, msg: DaemonMessage): void {
    switch (msg.type) {
      case "spawn": {
        if (!msg.project) {
          this.send(ws, { type: "error", error: "Missing project path" });
          return;
        }
        const workerId = this.procMgr.spawn(msg.project, msg.task || null);
        // Send back updated workers list
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
        const sent = this.procMgr.sendMessage(msg.workerId, msg.content);
        if (!sent) {
          this.send(ws, {
            type: "error",
            error: `Worker ${msg.workerId} not found or stdin not writable`,
          });
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
        // Placeholder for orchestrator messages
        this.send(ws, {
          type: "orchestrator",
          content: "Orchestrator not yet implemented",
        });
        break;
      }

      default:
        this.send(ws, { type: "error", error: `Unknown message type` });
    }
  }

  private send(ws: WebSocket, response: DaemonResponse): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(response));
    }
  }

  private broadcast(response: DaemonResponse): void {
    const data = JSON.stringify(response);
    for (const client of this.authenticated) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  }
}
