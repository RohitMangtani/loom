/**
 * Device Registry
 *
 * Manages device registration, heartbeat tracking, and persistence.
 * Devices register via HTTP, push data, and the registry tracks liveness.
 *
 * Storage: ~/.hive/devices.json (same pattern as workers.json)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import type { DeviceRegistration, RegisteredDevice } from "./types.js";

const HOME = process.env.HOME || `/Users/${process.env.USER}`;
const HIVE_DIR = join(HOME, ".hive");
const DEVICES_FILE = join(HIVE_DIR, "devices.json");

/** A device is offline if no data received for 3x its push interval (min 60s). */
const DEFAULT_OFFLINE_THRESHOLD = 60_000;
const OFFLINE_MULTIPLIER = 3;

export class DeviceRegistry {
  private devices = new Map<string, RegisteredDevice>();

  constructor() {
    this.load();
  }

  // ── Public API ──────────────────────────────────────────────────────

  register(reg: DeviceRegistration): RegisteredDevice {
    const now = Date.now();
    const existing = this.devices.get(reg.id);

    const device: RegisteredDevice = {
      ...reg,
      registeredAt: existing?.registeredAt ?? now,
      lastSeenAt: now,
      online: true,
    };

    this.devices.set(reg.id, device);
    this.save();
    return device;
  }

  unregister(id: string): boolean {
    const deleted = this.devices.delete(id);
    if (deleted) this.save();
    return deleted;
  }

  /** Called when a device pushes data — updates lastSeenAt. */
  touch(id: string): void {
    const device = this.devices.get(id);
    if (device) {
      device.lastSeenAt = Date.now();
      device.online = true;
    }
  }

  get(id: string): RegisteredDevice | undefined {
    return this.devices.get(id);
  }

  getAll(): RegisteredDevice[] {
    return Array.from(this.devices.values());
  }

  /** Periodic liveness check — marks devices offline if no heartbeat. */
  tick(): void {
    const now = Date.now();
    for (const device of this.devices.values()) {
      const threshold = Math.max(
        DEFAULT_OFFLINE_THRESHOLD,
        (device.pushIntervalMs ?? DEFAULT_OFFLINE_THRESHOLD) * OFFLINE_MULTIPLIER,
      );
      if (now - device.lastSeenAt > threshold) {
        device.online = false;
      }
    }
  }

  // ── Persistence ─────────────────────────────────────────────────────

  private load(): void {
    try {
      if (existsSync(DEVICES_FILE)) {
        const raw = JSON.parse(readFileSync(DEVICES_FILE, "utf-8"));
        if (Array.isArray(raw)) {
          for (const d of raw) {
            if (d.id) this.devices.set(d.id, { ...d, online: false });
          }
        }
      }
    } catch {
      // Corrupt file — start fresh
    }
  }

  private save(): void {
    if (!existsSync(HIVE_DIR)) mkdirSync(HIVE_DIR, { recursive: true });
    writeFileSync(DEVICES_FILE, JSON.stringify(this.getAll(), null, 2));
  }
}
