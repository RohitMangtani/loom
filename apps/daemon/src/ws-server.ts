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
import type { ChatEntry, DaemonMessage, DaemonResponse, WorkerState, ConnectedMachine } from "./types.js";
import type { WebPushManager } from "./web-push.js";

/** Satellite connection state */
interface SatelliteConnection {
  ws: WebSocket;
  machineId: string;
  hostname: string;
  workers: WorkerState[];
  connectedAt: number;
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
  private clients = new Set<WebSocket>();
  private readOnlyClients = new Set<WebSocket>();
  // Track which worker each client is subscribed to
  private clientSubs = new Map<WebSocket, string>();
  private lastWorkersSnapshot: string | null = null;
  private lastModelsSnapshot: string | null = null;
  private lastMachinesSnapshot: string | null = null;
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
        // Optimistic update
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

  /** Get all workers: local + satellite, merged into one list. */
  private getAllWorkers(): WorkerState[] {
    const local = this.telemetry.getAll();
    const remote: WorkerState[] = [];
    for (const sat of this.satellites.values()) {
      for (const w of sat.workers) {
        remote.push({
          ...w,
          // Prefix ID to ensure global uniqueness
          id: `${sat.machineId}:${w.id}`,
          machine: sat.machineId,
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
  getSatelliteDiagnostics(): Array<{ machineId: string; hostname: string; workerCount: number; connectedAt: number; wsState: number }> {
    const diag: Array<{ machineId: string; hostname: string; workerCount: number; connectedAt: number; wsState: number }> = [];
    for (const sat of this.satellites.values()) {
      diag.push({
        machineId: sat.machineId,
        hostname: sat.hostname,
        workerCount: sat.workers.length,
        connectedAt: sat.connectedAt,
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
      });
    }
    return machines;
  }

  /** Broadcast connected machines list to all dashboard clients. */
  private broadcastMachines(): void {
    const machines = this.getConnectedMachines();
    this.broadcast({ type: "machines", machines });
  }

  /** Forward a command to a satellite. */
  private sendToSatellite(sat: SatelliteConnection, msg: Record<string, unknown>): void {
    if (sat.ws.readyState === WebSocket.OPEN) {
      sat.ws.send(JSON.stringify(msg));
    }
  }

  /** Handle messages from a satellite connection. */
  private handleSatelliteMessage(ws: WebSocket, machineId: string, msg: Record<string, unknown>): void {
    if (msg.type !== "satellite_workers") {
      console.log(`[satellite] Message from "${machineId}": ${msg.type}`);
    }
    switch (msg.type) {
      case "satellite_hello": {
        const sat: SatelliteConnection = {
          ws,
          machineId,
          hostname: (msg.hostname as string) || machineId,
          workers: [],
          connectedAt: Date.now(),
        };
        this.satellites.set(machineId, sat);
        console.log(`[satellite] "${machineId}" registered (hostname: ${sat.hostname})`);
        // Notify dashboard clients about the new satellite
        this.broadcastMachines();
        break;
      }

      case "satellite_workers": {
        const sat = this.satellites.get(machineId);
        if (!sat) {
          console.log(`[satellite] Workers from unknown satellite "${machineId}" — hello not received yet`);
          return;
        }
        const prevCount = sat.workers.length;
        const incoming = (msg.workers as WorkerState[]) || [];

        // Apply overrides: after dashboard approves/selects a satellite worker,
        // suppress stale promptType from the satellite for a cooldown period.
        const now = Date.now();
        for (const w of incoming) {
          const key = `${machineId}:${w.id}`;
          const override = this.satelliteOverrides.get(key);
          if (override) {
            if (now < override.until) {
              // Override still active — clear prompt state and apply dashboard state
              w.promptType = null;
              w.promptMessage = undefined;
              w.status = override.status as WorkerState["status"];
              w.currentAction = override.currentAction;
              w.lastAction = override.lastAction;
            } else {
              // Expired — satellite should have caught up by now
              this.satelliteOverrides.delete(key);
            }
          }
        }

        sat.workers = incoming;
        if (sat.workers.length !== prevCount) {
          console.log(`[satellite] "${machineId}" workers: ${prevCount} → ${sat.workers.length}`);
        }
        // Force state push on next tick
        this.lastWorkersSnapshot = null;
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
        // Command results — currently fire-and-forget, logged for debugging
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
          this.sendToSatellite(sat, { type: "satellite_api_response", requestId, data: result });
        } catch (err) {
          this.sendToSatellite(sat, { type: "satellite_api_response", requestId, data: { error: err instanceof Error ? err.message : "Unknown error" } });
        }
        break;
      }
    }
  }

  /** Handle a relayed API request from a satellite.
   *  Executes the same logic as the primary's REST API. */
  private handleApiRelay(method: string, path: string, body: Record<string, unknown> | undefined, fromMachine: string): unknown {
    // Parse path and query
    const [basePath, queryStr] = path.split("?");
    const query = new URLSearchParams(queryStr || "");

    switch (basePath) {
      case "/api/workers":
        return this.getAllWorkers();

      case "/api/message": {
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
        const result = this.telemetry.sendToWorker(workerId, content, {
          source: `satellite:${fromMachine}`,
          queueIfBusy: false,
          markDashboardInput: false,
        });
        return result;
      }

      case "/api/queue": {
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
        );
        return { ok: true, task: queued, remaining: this.telemetry.getTaskQueueLength() };
      }

      case "/api/scratchpad": {
        if (method === "POST" && body) {
          this.telemetry.setScratchpad(
            body.key as string,
            body.value as string,
            body.setBy as string || fromMachine,
          );
          return { ok: true };
        }
        // GET
        const key = query.get("key") || "";
        if (key) {
          return this.telemetry.getScratchpad(key) || null;
        }
        return this.telemetry.getAllScratchpad();
      }

      case "/api/learning": {
        if (body?.project && body?.lesson) {
          this.telemetry.writeLearning(body.project as string, body.lesson as string);
          return { ok: true };
        }
        return { error: "Missing project or lesson" };
      }

      case "/api/reviews": {
        if (method === "POST" && body?.summary) {
          this.telemetry.addReview(
            body.summary as string,
            fromMachine,
            "satellite",
            { url: body.url as string | undefined, type: body.type as "push" | "deploy" | "commit" | "pr" | "review-needed" | "general" | undefined },
          );
          return { ok: true };
        }
        return this.telemetry.getReviews();
      }

      case "/api/artifacts": {
        const wid = query.get("workerId") || "";
        return this.telemetry.getArtifacts(wid);
      }

      case "/api/locks": {
        if (method === "POST" && body) {
          const lockResult = this.telemetry.acquireLock(body.path as string, body.workerId as string);
          return lockResult;
        }
        return { error: "Missing body" };
      }

      case "/api/conflicts": {
        const conflictPath = query.get("path") || "";
        const exclude = query.get("excludeWorker") || "";
        return this.telemetry.checkConflicts(conflictPath, exclude);
      }

      default:
        return { error: `Unknown API path: ${basePath}` };
    }
  }

  /** Push full worker list to all clients. Call from the main tick loop
   *  so the dashboard stays current even when status changes come from
   *  discovery (JSONL/CPU analysis) instead of hooks. */
  pushState(): void {
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
              model: w.model || "claude", machine: sat.machineId,
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
      const satSlots: Array<{ quadrant: number; id: string; pid: number; tty?: string; project: string; projectName: string; status: string; currentAction: string | null; lastAction: string; startedAt: number; model: string; machine?: string }> = [];
      let nextSatSlot = 5; // Satellite workers get slots 5-8 (primary uses 1-4)
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
      const isAdmin = candidate ? validateToken(candidate, this.token) : false;
      const satelliteId = reqUrl.searchParams.get("satellite") || "";

      console.log(`[ws] New connection: satellite=${satelliteId || "none"} admin=${isAdmin} url=${req.url?.slice(0, 80)}`);

      // ── Satellite connection ──────────────────────────────────
      if (satelliteId && isAdmin) {
        console.log(`[satellite] "${satelliteId}" connected`);
        this.satelliteWs.set(ws, satelliteId);

        ws.on("message", (raw) => {
          try {
            const msg = JSON.parse(raw.toString());
            this.handleSatelliteMessage(ws, satelliteId, msg);
          } catch { /* malformed */ }
        });

        ws.on("close", () => {
          console.log(`[satellite] "${satelliteId}" disconnected`);
          this.satellites.delete(satelliteId);
          this.satelliteWs.delete(ws);
          // Force a state push so dashboard drops the satellite's workers
          this.lastWorkersSnapshot = null;
          this.pushState();
          // Notify dashboard clients that satellite list changed
          this.broadcastMachines();
        });

        ws.on("error", () => ws.close());
        return;
      }

      // ── Dashboard / viewer connection ─────────────────────────
      this.clients.add(ws);
      if (!isAdmin) this.readOnlyClients.add(ws);
      // Send current workers list (local + satellite merged)
      const workers = this.getAllWorkers();
      this.lastWorkersSnapshot = JSON.stringify(workers);
      this.send(ws, { type: "workers", workers });
      this.send(ws, { type: "auth", admin: isAdmin });
      // Send full review list on connect (hosted dashboard can't reach REST on port 3001)
      this.send(ws, { type: "reviews", reviews: this.telemetry.getReviews() });
      // Send available agent models for spawn dialog
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "models", models: this.getAvailableModels() }));
      }
      // Send connected satellite machines for spawn dialog machine picker
      this.send(ws, { type: "machines", machines: this.getConnectedMachines() });
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
          this.sendToSatellite(targetSat, {
            type: "satellite_spawn",
            requestId: `spawn_${Date.now()}`,
            project: msg.project || "~",
            model: msg.model || "claude",
            initialMessage: msg.task?.trim() || undefined,
          });
          console.log(`Spawn routed to satellite "${msg.machine}" (model=${msg.model || "claude"})`);
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
          // Optimistic update: show working state immediately
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
            approveRemote.status = "working";
            approveRemote.currentAction = "Thinking...";
            approveRemote.lastAction = "Prompt approved from dashboard";
            approveRemote.lastActionAt = Date.now();
            this.lastWorkersSnapshot = null;
            this.satelliteOverrides.set(`${approveSat.machineId}:${parsed.localId}`, {
              until: Date.now() + 25_000,
              status: "working",
              currentAction: "Thinking...",
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
