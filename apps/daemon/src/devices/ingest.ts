/**
 * Device Data Ingest
 *
 * Receives data pushes from devices, stores raw data, and runs lightweight
 * change detection. When something interesting happens, queues a task for
 * an agent to analyze.
 *
 * Storage layout:
 *   ~/hive-data/devices/<device_id>/
 *     frames/YYYY-MM-DD/HH-MM-SS.jpg     (camera)
 *     metrics.jsonl                        (sensor)
 *     events.jsonl                         (all — the permanent asset)
 */

import { existsSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { randomBytes } from "crypto";
import type { DeviceRegistry } from "./registry.js";
import type { DeviceDataPayload, DeviceEvent } from "./types.js";

const HOME = process.env.HOME || `/Users/${process.env.USER}`;
const DATA_ROOT = join(HOME, "hive-data", "devices");

/** Pixel-diff threshold (0-1). Above this = "something changed". */
const CHANGE_THRESHOLD = 0.05;

/** Max events to keep in memory per device (ring buffer for dashboard). */
const MAX_EVENTS_IN_MEMORY = 200;

export interface IngestResult {
  stored: boolean;
  path?: string;
  event?: DeviceEvent;
}

export class DeviceIngest {
  private registry: DeviceRegistry;

  /** In-memory ring buffer of recent events per device. */
  private recentEvents = new Map<string, DeviceEvent[]>();

  /** Last frame bytes per device — used for simple change detection. */
  private lastFrameSize = new Map<string, number>();

  /** Callback: fires when an event worth agent analysis is detected. */
  private onEvent: ((event: DeviceEvent) => void) | null = null;

  constructor(registry: DeviceRegistry) {
    this.registry = registry;
  }

  setEventHandler(handler: (event: DeviceEvent) => void): void {
    this.onEvent = handler;
  }

  // ── Ingest entry point ──────────────────────────────────────────────

  ingest(data: DeviceDataPayload): IngestResult {
    const device = this.registry.get(data.deviceId);
    if (!device) {
      return { stored: false };
    }

    // Update liveness
    this.registry.touch(data.deviceId);

    const ts = data.timestamp ?? Date.now();

    switch (data.type) {
      case "image":
        return this.ingestImage(data.deviceId, ts, data.payload);
      case "metric":
        return this.ingestMetric(data.deviceId, ts, data.payload);
      case "event":
        return this.ingestEvent(data.deviceId, ts, data.payload);
      case "audio":
        return this.ingestAudio(data.deviceId, ts, data.payload);
      default:
        return { stored: false };
    }
  }

  /** Get recent events for a device (for dashboard). */
  getRecentEvents(deviceId: string, limit = 50): DeviceEvent[] {
    const events = this.recentEvents.get(deviceId) ?? [];
    return events.slice(-limit);
  }

  /** Get all recent events across all devices. */
  getAllRecentEvents(limit = 100): DeviceEvent[] {
    const all: DeviceEvent[] = [];
    for (const events of this.recentEvents.values()) {
      all.push(...events);
    }
    all.sort((a, b) => b.timestamp - a.timestamp);
    return all.slice(0, limit);
  }

  // ── Image ingest ────────────────────────────────────────────────────

  private ingestImage(
    deviceId: string,
    ts: number,
    payload: Record<string, unknown>,
  ): IngestResult {
    const base64 = payload.base64 as string | undefined;
    if (!base64) return { stored: false };

    const date = new Date(ts);
    const dateStr = date.toISOString().slice(0, 10); // YYYY-MM-DD
    const timeStr = date.toISOString().slice(11, 19).replace(/:/g, "-"); // HH-MM-SS
    const format = (payload.format as string) || "jpg";

    const dir = join(DATA_ROOT, deviceId, "frames", dateStr);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const filePath = join(dir, `${timeStr}.${format}`);
    const buffer = Buffer.from(base64, "base64");
    writeFileSync(filePath, buffer);

    // Simple change detection: compare buffer size to last frame.
    // A proper implementation would compare pixel data, but size delta
    // catches most real-world changes (person appears, car moves, etc.)
    // and costs zero CPU. Vision model handles the rest.
    const lastSize = this.lastFrameSize.get(deviceId) ?? 0;
    this.lastFrameSize.set(deviceId, buffer.length);

    let event: DeviceEvent | undefined;
    if (lastSize > 0) {
      const delta = Math.abs(buffer.length - lastSize) / lastSize;
      if (delta > CHANGE_THRESHOLD) {
        event = {
          id: randomBytes(8).toString("hex"),
          deviceId,
          timestamp: ts,
          type: "change",
          summary: `Frame size changed by ${(delta * 100).toFixed(1)}%`,
          confidence: Math.min(delta * 2, 1),
          framePath: filePath,
        };
        this.pushEvent(event);
      }
    }

    return { stored: true, path: filePath, event };
  }

  // ── Metric ingest ───────────────────────────────────────────────────

  private ingestMetric(
    deviceId: string,
    ts: number,
    payload: Record<string, unknown>,
  ): IngestResult {
    const dir = join(DATA_ROOT, deviceId);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const line = JSON.stringify({ ts, ...payload });
    appendFileSync(join(dir, "metrics.jsonl"), line + "\n");

    return { stored: true };
  }

  // ── Event ingest (pre-processed by device) ──────────────────────────

  private ingestEvent(
    deviceId: string,
    ts: number,
    payload: Record<string, unknown>,
  ): IngestResult {
    const event: DeviceEvent = {
      id: randomBytes(8).toString("hex"),
      deviceId,
      timestamp: ts,
      type: (payload.kind as string) === "motion" ? "motion" : "custom",
      summary: (payload.description as string) || `Event: ${payload.kind}`,
      confidence: (payload.confidence as number) ?? undefined,
      region: payload.region as string | undefined,
    };

    this.pushEvent(event);
    return { stored: true, event };
  }

  // ── Audio ingest ────────────────────────────────────────────────────

  private ingestAudio(
    deviceId: string,
    ts: number,
    payload: Record<string, unknown>,
  ): IngestResult {
    const base64 = payload.base64 as string | undefined;
    if (!base64) return { stored: false };

    const date = new Date(ts);
    const dateStr = date.toISOString().slice(0, 10);
    const timeStr = date.toISOString().slice(11, 19).replace(/:/g, "-");
    const format = (payload.format as string) || "wav";

    const dir = join(DATA_ROOT, deviceId, "audio", dateStr);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const filePath = join(dir, `${timeStr}.${format}`);
    writeFileSync(filePath, Buffer.from(base64, "base64"));

    return { stored: true, path: filePath };
  }

  // ── Internal helpers ────────────────────────────────────────────────

  private pushEvent(event: DeviceEvent): void {
    // Persist to JSONL
    const dir = join(DATA_ROOT, event.deviceId);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "events.jsonl"), JSON.stringify(event) + "\n");

    // In-memory ring buffer
    let events = this.recentEvents.get(event.deviceId);
    if (!events) {
      events = [];
      this.recentEvents.set(event.deviceId, events);
    }
    events.push(event);
    if (events.length > MAX_EVENTS_IN_MEMORY) {
      events.splice(0, events.length - MAX_EVENTS_IN_MEMORY);
    }

    // Notify handler (routes.ts bridges this to the task queue)
    this.onEvent?.(event);
  }
}
