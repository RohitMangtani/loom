import { execSync } from "child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import type { TelemetryReceiver } from "./telemetry.js";
import type { WorkerState } from "./types.js";
import type { WebPushManager } from "./web-push.js";

const HOME = process.env.HOME || `/Users/${process.env.USER}`;
const CONFIG_PATH = join(HOME, ".hive", "notifications.json");
const DEFAULT_COOLDOWN = 60_000;
const DEFAULT_ERROR_THRESHOLD = 3;
// Shorter cooldown for push  --  user wants to know each time an agent finishes
const PUSH_COOLDOWN = 15_000;

interface NotificationConfig {
  enabled: boolean;
  cooldownMs: number;
  errorThreshold: number;
  sound: boolean;
  /** Push notifications for green→red transitions. Default true. */
  pushOnComplete: boolean;
}

const DEFAULT_CONFIG: NotificationConfig = {
  enabled: true,
  cooldownMs: DEFAULT_COOLDOWN,
  errorThreshold: DEFAULT_ERROR_THRESHOLD,
  sound: true,
  pushOnComplete: true,
};

export class NotificationManager {
  private config: NotificationConfig;
  private lastNotified = new Map<string, number>();
  private lastPushed = new Map<string, number>();
  private previousStatus = new Map<string, string>();
  private completionCache = new Map<string, { action: string; ts: number }>();
  private pushMgr: WebPushManager | null = null;
  private telemetryRef: TelemetryReceiver | null = null;
  // Debounce: pending completion notifications. Only fire if agent is STILL idle after delay.
  private pendingCompletions = new Map<string, ReturnType<typeof setTimeout>>();

  constructor() {
    this.config = this.loadConfig();
  }

  /** Wire up a WebPushManager for push notifications */
  setPushManager(mgr: WebPushManager): void {
    this.pushMgr = mgr;
  }

  register(telemetry: TelemetryReceiver): void {
    this.telemetryRef = telemetry;
    telemetry.onUpdate((workerId, state) => {
      this.handleUpdate(workerId, state);
    });

    telemetry.onRemoval((workerId) => {
      this.lastNotified.delete(workerId);
      this.lastPushed.delete(workerId);
      this.previousStatus.delete(workerId);
      this.completionCache.delete(workerId);
      const pending = this.pendingCompletions.get(workerId);
      if (pending) { clearTimeout(pending); this.pendingCompletions.delete(workerId); }
    });

    console.log(`  Notifications: ${this.config.enabled ? "enabled" : "disabled"} (config: ${CONFIG_PATH})`);
  }

  getConfig(): NotificationConfig {
    return { ...this.config };
  }

  /** Handle a satellite worker status change. Called by ws-server when a
   *  satellite worker transitions between states. Same logic as local workers
   *  but fed from the satellite status pipeline instead of telemetry.onUpdate(). */
  handleSatelliteStatusChange(workerId: string, state: WorkerState, prevStatus: string): void {
    if (!this.config.enabled) return;

    // Stuck → macOS desktop notification
    if (state.status === "stuck" && prevStatus !== "stuck") {
      this.notify(workerId, state);
      return;
    }

    if (this.config.pushOnComplete && this.isCompletionTransition(workerId, state, prevStatus)) {
      this.pushComplete(workerId, state);
    }
  }

  private handleUpdate(workerId: string, state: WorkerState): void {
    if (!this.config.enabled) return;

    const prev = this.previousStatus.get(workerId);
    this.previousStatus.set(workerId, state.status);

    // If agent went back to working, cancel any pending completion notification.
    // This prevents false "done" notifications from brief idle flickers.
    if (state.status === "working") {
      const pending = this.pendingCompletions.get(workerId);
      if (pending) {
        clearTimeout(pending);
        this.pendingCompletions.delete(workerId);
      }
    }

    // Stuck → macOS desktop notification (existing behavior)
    if (state.status === "stuck" && prev !== "stuck") {
      this.notify(workerId, state);
      return;
    }

    if (state.errorCount >= this.config.errorThreshold && prev !== "stuck") {
      this.notify(workerId, state);
    }

    // Working → Idle (green → red) → debounced push notification.
    // Wait 6 seconds and verify the agent is STILL idle before notifying.
    // Prevents false "done" notifications from transient idle flickers
    // between tool calls or during CPU dips.
    if (this.config.pushOnComplete && this.isCompletionTransition(workerId, state, prev)) {
      if (!this.pendingCompletions.has(workerId)) {
        const snapshot = { ...state };
        this.pendingCompletions.set(workerId, setTimeout(() => {
          this.pendingCompletions.delete(workerId);
          // Re-check: is the agent still idle?
          const current = this.telemetryRef?.get(workerId);
          if (current && current.status === "idle") {
            this.pushComplete(workerId, current);
          }
        }, 6_000));
      }
    }
  }

  /** macOS desktop notification for stuck agents */
  private notify(workerId: string, state: WorkerState): void {
    const now = Date.now();
    const last = this.lastNotified.get(workerId) || 0;
    if (now - last < this.config.cooldownMs) return;

    this.lastNotified.set(workerId, now);

    const slot = state.quadrant ? `Q${state.quadrant}` : (state.tty || workerId.slice(0, 10));
    const machine = state.machineLabel || state.machine || "";
    // Shorten hostname: "Rohits-MacBook-Air.local" → "MacBook-Air"
    const shortMachine = machine.replace(/\.local$/, "").replace(/^[^-]*-/, "");
    const project = state.projectName || "unknown";
    const action = state.stuckMessage?.split("\n")[0]?.slice(0, 80) || state.currentAction || "Needs attention";
    const title = `${slot} stuck${shortMachine ? ` (${shortMachine})` : ""}`;
    const body = `${project}  --  ${action}`;

    try {
      const soundClause = this.config.sound ? ' sound name "Funk"' : "";
      const script = `display notification "${escapeAppleScript(body)}" with title "${escapeAppleScript(title)}"${soundClause}`;
      execSync(`osascript -e '${script}'`, { timeout: 3000, stdio: "ignore" });
      console.log(`[notify] ${slot}: ${action.slice(0, 60)}`);
    } catch {
      // Non-critical
    }
  }

  private isCompletionTransition(workerId: string, state: WorkerState, prevStatus?: string): boolean {
    if (prevStatus !== "working" || state.status !== "idle") return false;
    if (state.currentAction) return false;
    const lastAction = state.lastAction?.trim();
    if (!lastAction) return false;
    const action = lastAction;
    const now = Date.now();
    const record = this.completionCache.get(workerId);
    if (record && record.action === action && now - record.ts < 30_000) {
      return false;
    }
    this.completionCache.set(workerId, { action, ts: now });
    return true;
  }

  /** Web Push notification when an agent finishes (green → red) */
  private pushComplete(workerId: string, state: WorkerState): void {
    if (!this.pushMgr || this.pushMgr.getSubscriptionCount() === 0) return;

    const now = Date.now();
    const last = this.lastPushed.get(workerId) || 0;
    if (now - last < PUSH_COOLDOWN) return;

    this.lastPushed.set(workerId, now);

    const slot = state.quadrant ? `Q${state.quadrant}` : (state.tty || workerId.slice(0, 8));
    const machine = state.machineLabel || state.machine || "";
    // Shorten hostname: "Rohits-MacBook-Air.local" → "MacBook-Air"
    const shortMachine = machine.replace(/\.local$/, "").replace(/^[^-]*-/, "");
    const project = state.projectName || "unknown";
    const action = state.lastAction?.slice(0, 100) || "Task complete";
    const title = `${slot} done${shortMachine ? ` (${shortMachine})` : ""}`;
    const body = `${project}  --  ${action}`;

    this.pushMgr
      .sendToAll(title, body, {
        tag: `hive-complete-${workerId}`,
        data: { workerId, quadrant: state.quadrant },
      })
      .then(({ sent, failed }) => {
        if (sent > 0) console.log(`[push] ${slot}: ${body.slice(0, 60)}`);
        if (failed > 0) console.log(`[push] ${failed} delivery failure(s)`);
      })
      .catch(() => {});
  }

  private loadConfig(): NotificationConfig {
    try {
      if (existsSync(CONFIG_PATH)) {
        const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
        return { ...DEFAULT_CONFIG, ...raw };
      }
    } catch { /* use defaults */ }

    try {
      const dir = join(HOME, ".hive");
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n");
    } catch { /* non-critical */ }

    return { ...DEFAULT_CONFIG };
  }
}

function escapeAppleScript(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
