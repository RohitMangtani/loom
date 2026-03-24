/**
 * Device layer types.
 *
 * Devices are non-LLM sensor/actuator nodes that push data into Hive.
 * They live alongside workers but never become workers.
 */

// ── Registration ────────────────────────────────────────────────────────

export type DeviceType = "camera" | "sensor" | "compute" | "actuator";

export interface Hitbox {
  name: string;
  /** [x, y, width, height] in pixels relative to the device's frame size */
  rect: [number, number, number, number];
  priority: "high" | "medium" | "low";
}

export interface DeviceRegistration {
  id: string;
  type: DeviceType;
  capabilities: string[];
  location?: string;
  /** How often the device pushes data (ms). Informational only. */
  pushIntervalMs?: number;
  /** Named regions of interest (camera devices). */
  hitboxes?: Hitbox[];
  /** Arbitrary metadata the device wants to store. */
  meta?: Record<string, unknown>;
}

export interface RegisteredDevice extends DeviceRegistration {
  registeredAt: number;
  lastSeenAt: number;
  online: boolean;
}

// ── Data ingest ─────────────────────────────────────────────────────────

export type DataType = "image" | "metric" | "event" | "audio";

export interface DeviceDataPayload {
  deviceId: string;
  timestamp?: number;
  type: DataType;
  /** Flexible per device type:
   *  image:  { base64, width?, height?, format? }
   *  metric: { temperature?: number, humidity?: number, [key]: number }
   *  event:  { kind: string, region?: string, confidence?: number, description?: string }
   *  audio:  { base64, durationMs?, format? }
   */
  payload: Record<string, unknown>;
}

// ── Events (derived from data, stored long-term) ────────────────────────

export interface DeviceEvent {
  id: string;
  deviceId: string;
  timestamp: number;
  type: "change" | "motion" | "anomaly" | "threshold" | "custom";
  /** Human-readable summary (filled by diff engine or agent). */
  summary: string;
  /** Confidence score 0-1 (from diff engine). */
  confidence?: number;
  /** Which hitbox triggered this event. */
  region?: string;
  /** Path to the frame that triggered this event (camera devices). */
  framePath?: string;
  /** Raw metric values at time of event (sensor devices). */
  metrics?: Record<string, number>;
}
