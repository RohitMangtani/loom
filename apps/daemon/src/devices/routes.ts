/**
 * Device API Routes
 *
 * Mounts on the existing Express app via registerRoutes().
 * All routes under /api/devices/*.
 *
 * Endpoints:
 *   POST /api/devices/register   — device announces itself
 *   DELETE /api/devices/:id       — unregister a device
 *   POST /api/devices/data        — device pushes data (image, metric, event, audio)
 *   GET  /api/devices             — list all registered devices
 *   GET  /api/devices/:id         — get single device
 *   GET  /api/devices/:id/events  — recent events for a device
 *   GET  /api/devices/events/all  — recent events across all devices
 *   POST /api/devices/:id/hitboxes — update hitbox config for a device
 */

import type { Request, Response, NextFunction } from "express";
import type express from "express";
import { DeviceRegistry } from "./registry.js";
import { DeviceIngest } from "./ingest.js";
import type { DeviceRegistration, DeviceDataPayload, DeviceEvent, Hitbox } from "./types.js";

/** Express 5 params are string | string[]. Extract the first string. */
function paramStr(v: string | string[]): string {
  return Array.isArray(v) ? v[0] : v;
}

export class DeviceLayer {
  readonly registry: DeviceRegistry;
  readonly ingest: DeviceIngest;

  /** Callback: fires when an event should become a task in the agent queue. */
  private taskBridge: ((event: DeviceEvent) => void) | null = null;

  /** Callback: pushes device state/events to all connected WebSocket clients. */
  private wsBroadcast: ((msg: Record<string, unknown>) => void) | null = null;

  constructor() {
    this.registry = new DeviceRegistry();
    this.ingest = new DeviceIngest(this.registry);

    // Wire ingest events → task bridge + WS broadcast
    this.ingest.setEventHandler((event) => {
      this.taskBridge?.(event);
      this.wsBroadcast?.({ type: "device_event", deviceEvent: event });
    });
  }

  /**
   * Set a callback that creates a task in the daemon's queue when a
   * device event is interesting enough for agent analysis.
   *
   * Example usage from index.ts:
   *   deviceLayer.setTaskBridge((event) => {
   *     taskQueue.add({
   *       task: `Analyze device event: ${event.summary}`,
   *       project: "hive",
   *       priority: event.type === "motion" ? 2 : 1,
   *     });
   *   });
   */
  setTaskBridge(handler: (event: DeviceEvent) => void): void {
    this.taskBridge = handler;
  }

  /**
   * Set a broadcast function so device events push to all WS clients.
   * The WsServer exposes a broadcast method — pass it here.
   */
  setBroadcast(fn: (msg: Record<string, unknown>) => void): void {
    this.wsBroadcast = fn;
  }

  /** Push full device list to all WS clients. */
  broadcastDevices(): void {
    this.wsBroadcast?.({ type: "devices", devices: this.registry.getAll() });
  }

  /** Run in the daemon's 3s tick loop. */
  tick(): void {
    this.registry.tick();
  }

  /** Mount all device routes on the Express app. */
  registerRoutes(
    app: ReturnType<typeof express>,
    requireAuth: (req: Request, res: Response, next: NextFunction) => void,
  ): void {

    // ── Registration ────────────────────────────────────────────────

    app.post("/api/devices/register", requireAuth, (req: Request, res: Response) => {
      const body = req.body as DeviceRegistration | undefined;
      if (!body?.id || !body.type) {
        res.status(400).json({ error: "Missing id or type" });
        return;
      }

      const allowed: string[] = ["camera", "sensor", "compute", "actuator"];
      if (!allowed.includes(body.type)) {
        res.status(400).json({ error: `Invalid type. Must be one of: ${allowed.join(", ")}` });
        return;
      }

      const device = this.registry.register(body);
      this.broadcastDevices();
      res.json({ ok: true, device });
    });

    app.delete("/api/devices/:id", requireAuth, (req: Request, res: Response) => {
      const deleted = this.registry.unregister(paramStr(req.params.id));
      if (deleted) this.broadcastDevices();
      res.json({ ok: deleted });
    });

    // ── Data ingest ─────────────────────────────────────────────────

    app.post("/api/devices/data", requireAuth, (req: Request, res: Response) => {
      const body = req.body as DeviceDataPayload | undefined;
      if (!body?.deviceId || !body.type) {
        res.status(400).json({ error: "Missing deviceId or type" });
        return;
      }

      const device = this.registry.get(body.deviceId);
      if (!device) {
        res.status(404).json({ error: `Device ${body.deviceId} not registered` });
        return;
      }

      const result = this.ingest.ingest(body);
      res.json(result);
    });

    // ── Queries ─────────────────────────────────────────────────────

    app.get("/api/devices", requireAuth, (_req: Request, res: Response) => {
      res.json(this.registry.getAll());
    });

    app.get("/api/devices/events/all", requireAuth, (req: Request, res: Response) => {
      const limit = parseInt(req.query.limit as string) || 100;
      res.json(this.ingest.getAllRecentEvents(limit));
    });

    app.get("/api/devices/:id", requireAuth, (req: Request, res: Response) => {
      const id = paramStr(req.params.id);
      const device = this.registry.get(id);
      if (!device) {
        res.status(404).json({ error: "Device not found" });
        return;
      }
      res.json(device);
    });

    app.get("/api/devices/:id/events", requireAuth, (req: Request, res: Response) => {
      const id = paramStr(req.params.id);
      const device = this.registry.get(id);
      if (!device) {
        res.status(404).json({ error: "Device not found" });
        return;
      }
      const limit = parseInt(req.query.limit as string) || 50;
      res.json(this.ingest.getRecentEvents(id, limit));
    });

    // ── Hitbox config ───────────────────────────────────────────────

    app.post("/api/devices/:id/hitboxes", requireAuth, (req: Request, res: Response) => {
      const id = paramStr(req.params.id);
      const device = this.registry.get(id);
      if (!device) {
        res.status(404).json({ error: "Device not found" });
        return;
      }

      const hitboxes = req.body?.hitboxes as Hitbox[] | undefined;
      if (!Array.isArray(hitboxes)) {
        res.status(400).json({ error: "hitboxes must be an array" });
        return;
      }

      // Re-register with updated hitboxes
      this.registry.register({ ...device, hitboxes });
      res.json({ ok: true, hitboxes });
    });
  }
}
