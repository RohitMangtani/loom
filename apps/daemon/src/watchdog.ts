import { readFileSync, existsSync, appendFileSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import type { TelemetryReceiver } from "./telemetry.js";

/**
 * Self-diagnostic watchdog: reads the audit log, detects anomalies,
 * and dispatches fix-it tasks to idle agents via TTY input.
 *
 * Three-layer loop:
 * 1. DIAGNOSE: read audit log, detect anomalies
 * 2. DISPATCH: send focused task to an idle hive agent (with learnings context)
 * 3. VERIFY: on next scan, check if the anomaly resolved. If not, increment
 *    attempt counter. After MAX_ATTEMPTS, escalate to dashboard as stuck.
 *
 * Runs every SCAN_INTERVAL_MS (5 minutes). The human watches the dashboard.
 * Agents fix the system. Learnings compound.
 */

const HOME = process.env.HOME || `/Users/${process.env.USER}`;
const SCAN_INTERVAL_MS = 5 * 60 * 1000;
const AUDIT_LOG_PATH = join(HOME, ".hive", "quadrant-audit.log");
const MAX_ATTEMPTS = 3;
// Derive project root from this file's location: apps/daemon/src/watchdog.ts → ../../..
const HIVE_PROJECT = process.env.HIVE_PROJECT || join(import.meta.dirname, "..", "..", "..");
const ADAPTIVE_STATE_PATH = join(HOME, ".hive", "watchdog-adaptive.json");
const SUPPRESS_AFTER = 3;
const DECAY_MS = 24 * 60 * 60 * 1000;

interface AuditEntry {
  ts: string;
  tty: string;
  from: string;
  to: string;
  reason: string;
  context: Record<string, unknown>;
}

interface Anomaly {
  type: string;
  severity: "info" | "warn" | "error";
  description: string;
  data: Record<string, unknown>;
}

interface TrackedAnomaly {
  anomaly: Anomaly;
  attempts: number;
  lastDispatched: number;
  escalated: boolean;
  dispatchedTo?: string; // worker ID of last dispatched agent
}

interface AdaptiveEntry {
  baseType: string;
  consecutiveFP: number;
  lastSeen: number;
  suppressed: boolean;
}

export class Watchdog {
  private telemetry: TelemetryReceiver;
  private lastScan = 0;
  private tracked = new Map<string, TrackedAnomaly>();
  private adaptive = new Map<string, AdaptiveEntry>();
  private allIdleSince = 0;
  private idleAlertSent = false;

  constructor(telemetry: TelemetryReceiver) {
    this.telemetry = telemetry;
    this.loadAdaptive();
  }

  tick(): void {
    const now = Date.now();
    if (now - this.lastScan < SCAN_INTERVAL_MS) return;
    this.lastScan = now;

    const anomalies = this.diagnose();

    // --- VERIFY: check which previously tracked anomalies resolved ---
    for (const [type, tracked] of this.tracked) {
      const stillPresent = anomalies.some(a => a.type === type);
      if (!stillPresent) {
        console.log(`[watchdog] Anomaly resolved: ${type} (after ${tracked.attempts} attempt(s))`);
        this.recordResolution(type, tracked);
        this.autoLearn(tracked);
        this.tracked.delete(type);
      }
    }

    if (anomalies.length === 0) return;

    // --- DISPATCH or ESCALATE ---
    for (const anomaly of anomalies) {
      let tracked = this.tracked.get(anomaly.type);

      if (!tracked) {
        // New anomaly  --  start tracking
        tracked = { anomaly, attempts: 0, lastDispatched: 0, escalated: false };
        this.tracked.set(anomaly.type, tracked);
      } else {
        // Update with latest data
        tracked.anomaly = anomaly;
      }

      // Adaptive suppression: skip dispatch for known false-positive patterns
      if (this.isSuppressed(anomaly.type)) {
        const base = this.baseType(anomaly.type);
        const entry = this.adaptive.get(base);
        if (entry) entry.lastSeen = Date.now();
        continue; // Still tracked for VERIFY, but no dispatch
      }

      // Cooldown: don't re-dispatch within one scan interval
      if (now - tracked.lastDispatched < SCAN_INTERVAL_MS) continue;

      // --- ESCALATE: after MAX_ATTEMPTS, show on dashboard ---
      if (tracked.attempts >= MAX_ATTEMPTS && !tracked.escalated) {
        this.escalate(tracked);
        continue;
      }

      if (tracked.escalated) continue; // Already escalated, waiting for human

      // Log-only: watchdog diagnoses but never auto-sends messages to agents.
      // The human decides when and how to act on anomalies via the dashboard.
      if (tracked.attempts === 0) {
        tracked.attempts = 1;
        tracked.lastDispatched = now;
        console.log(`[watchdog] Detected ${anomaly.type}: ${anomaly.description.slice(0, 150)}`);
      }
    }

    // --- IDLE FLEET ALERT: notify if all agents idle >10 minutes ---
    this.checkIdleFleet(now);
  }

  /** Alert if all discovered agents have been idle for >10 minutes. */
  private checkIdleFleet(now: number): void {
    const workers = this.telemetry.getAll();
    if (workers.length === 0) return;
    const allIdle = workers.every(w => w.status === "idle");

    if (!allIdle) {
      this.allIdleSince = 0;
      this.idleAlertSent = false;
      return;
    }

    if (this.allIdleSince === 0) {
      this.allIdleSince = now;
      return;
    }

    if (now - this.allIdleSince > 10 * 60 * 1000 && !this.idleAlertSent) {
      this.idleAlertSent = true;
      const mins = Math.round((now - this.allIdleSince) / 60_000);
      this.notify("Hive Fleet Idle", `All ${workers.length} agents idle for ${mins}+ minutes`);
      console.log(`[watchdog] Fleet idle alert: all ${workers.length} agents idle for ${mins}+ minutes`);
    }
  }

  /**
   * Escalate to dashboard: create a pseudo-stuck state on the first
   * hive worker so the human sees it as a yellow card.
   */
  private escalate(tracked: TrackedAnomaly): void {
    tracked.escalated = true;
    const hiveWorker = this.telemetry.getAll().find(
      w => w.project.includes("hive")
    );

    if (hiveWorker) {
      // Don't override if already working on something
      if (hiveWorker.status === "working") return;

      hiveWorker.status = "stuck";
      hiveWorker.currentAction = `Watchdog: ${tracked.anomaly.type}`;
      hiveWorker.stuckMessage = `[Escalated after ${tracked.attempts} failed auto-fix attempts] ${tracked.anomaly.description}`;
      hiveWorker.lastAction = "Watchdog escalation";
      hiveWorker.lastActionAt = Date.now();
      this.telemetry.notifyExternal(hiveWorker);
    }

    // Human intervention = true positive → reset adaptive suppression
    const base = this.baseType(tracked.anomaly.type);
    const entry = this.adaptive.get(base);
    if (entry) {
      entry.consecutiveFP = 0;
      entry.suppressed = false;
      this.saveAdaptive();
    }

    console.log(`[watchdog] ESCALATED: ${tracked.anomaly.type} after ${tracked.attempts} attempts  --  shown on dashboard`);
    this.notify("Hive Watchdog Escalation", `${tracked.anomaly.type}  --  ${tracked.attempts} failed auto-fix attempts`);
  }

  /** Fire a system notification. */
  private notify(title: string, message: string): void {
    if (process.platform !== "darwin") return;
    try {
      const t = title.replace(/"/g, '\\"');
      const m = message.replace(/"/g, '\\"').slice(0, 200);
      execSync(`osascript -e 'display notification "${m}" with title "${t}"'`, { timeout: 3000 });
    } catch { /* best-effort */ }
  }

  /** Auto-write a learning when an anomaly resolves. Includes artifacts if an agent was dispatched. */
  private autoLearn(tracked: TrackedAnomaly): void {
    const a = tracked.anomaly;
    let artifactSuffix = "";
    if (tracked.dispatchedTo && tracked.attempts > 0) {
      const artifacts = this.telemetry.getArtifacts(tracked.dispatchedTo);
      if (artifacts.length > 0) {
        const fileNames = artifacts.map(art => {
          const parts = art.path.split("/");
          return `${parts[parts.length - 1]} (${art.action})`;
        });
        artifactSuffix = ` Fix: ${fileNames.join(", ")}`;
      }
    }
    const resolution = tracked.attempts === 0 ? "self-resolved" : `resolved after ${tracked.attempts} attempt(s)`;
    const lesson = `${a.type}: ${a.description.slice(0, 150)} (${resolution})${artifactSuffix}`;
    const claudeDir = join(HIVE_PROJECT, ".claude");
    const learningsPath = join(claudeDir, "hive-learnings.md");
    try {
      if (!existsSync(claudeDir)) mkdirSync(claudeDir, { recursive: true });
      const header = !existsSync(learningsPath)
        ? "# Hive Learnings\n\nLessons captured automatically. Every agent in this project reads this file.\n\n"
        : "";
      const timestamp = new Date().toISOString().split("T")[0];
      appendFileSync(learningsPath, `${header}- [${timestamp}] ${lesson}\n`);
      console.log(`[watchdog] Auto-learned: ${a.type}${artifactSuffix ? " (with artifacts)" : ""}`);
    } catch {
      console.log(`[watchdog] Failed to auto-learn: ${a.type}`);
    }
  }

  /** Extract base anomaly type: "flapping_ttys002" → "flapping", "agent_loop_ttys003" → "agent_loop". Others pass through. */
  private baseType(type: string): string {
    return type.replace(/_tty\w+$/, "");
  }

  /** Load adaptive state from disk on construction. */
  private loadAdaptive(): void {
    try {
      if (existsSync(ADAPTIVE_STATE_PATH)) {
        const raw = JSON.parse(readFileSync(ADAPTIVE_STATE_PATH, "utf-8")) as AdaptiveEntry[];
        for (const entry of raw) this.adaptive.set(entry.baseType, entry);
      }
    } catch {
      // Corrupt file  --  start fresh
      this.adaptive.clear();
    }
  }

  /** Persist adaptive state to disk. */
  private saveAdaptive(): void {
    try {
      const dir = ADAPTIVE_STATE_PATH.replace(/\/[^/]+$/, "");
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(ADAPTIVE_STATE_PATH, JSON.stringify([...this.adaptive.values()], null, 2));
    } catch { /* best-effort */ }
  }

  /** Check if an anomaly type is currently suppressed. Includes 24h decay. */
  private isSuppressed(anomalyType: string): boolean {
    const base = this.baseType(anomalyType);
    const entry = this.adaptive.get(base);
    if (!entry || !entry.suppressed) return false;
    // Decay: if not seen in 24h, reset suppression
    if (Date.now() - entry.lastSeen > DECAY_MS) {
      entry.consecutiveFP = 0;
      entry.suppressed = false;
      this.saveAdaptive();
      console.log(`[watchdog] Adaptive: "${base}" suppression decayed (>24h since last seen)`);
      return false;
    }
    return true;
  }

  /** Record how an anomaly resolved  --  self-resolved (FP) or agent-dispatched (TP). */
  private recordResolution(type: string, tracked: TrackedAnomaly): void {
    const base = this.baseType(type);
    let entry = this.adaptive.get(base);
    if (!entry) {
      entry = { baseType: base, consecutiveFP: 0, lastSeen: Date.now(), suppressed: false };
      this.adaptive.set(base, entry);
    }
    entry.lastSeen = Date.now();

    if (tracked.attempts === 0) {
      // Self-resolved  --  no agent was dispatched → likely false positive
      entry.consecutiveFP++;
      if (entry.consecutiveFP >= SUPPRESS_AFTER && !entry.suppressed) {
        entry.suppressed = true;
        console.log(`[watchdog] Adaptive: suppressing "${base}" after ${entry.consecutiveFP} consecutive self-resolutions`);
      }
    } else {
      // Agent was dispatched → treat as true positive, reset
      entry.consecutiveFP = 0;
      entry.suppressed = false;
    }
    this.saveAdaptive();
  }

  /** Read audit log and detect anomalies. */
  private diagnose(): Anomaly[] {
    if (!existsSync(AUDIT_LOG_PATH)) return [];

    let entries: AuditEntry[];
    try {
      const raw = readFileSync(AUDIT_LOG_PATH, "utf-8");
      entries = raw
        .split("\n")
        .filter(Boolean)
        .map(l => JSON.parse(l) as AuditEntry);
    } catch {
      return [];
    }

    if (entries.length === 0) return [];

    const anomalies: Anomaly[] = [];
    const now = Date.now();

    // Only analyze last 15 minutes of entries
    const recent = entries.filter(e => {
      const ts = new Date(e.ts).getTime();
      return now - ts < 15 * 60 * 1000;
    });

    if (recent.length === 0) return [];

    // --- Anomaly 1: Bogus hookAge after restart ---
    const bogusHook = recent.filter(e => {
      const hookAge = (e.context.hookAgeMs as number) || 0;
      return hookAge > 86_400_000; // > 24 hours = clearly wrong
    });
    if (bogusHook.length >= 3) {
      anomalies.push({
        type: "bogus_hook_age",
        severity: "warn",
        description: `${bogusHook.length} audit entries have hookAge > 24hrs. This happens after daemon restart because lastHookTime defaults to 0. The discovery logic should initialize lastHookTime to Date.now() for existing workers on first scan.`,
        data: { count: bogusHook.length, ttys: [...new Set(bogusHook.map(e => e.tty))] },
      });
    }

    // --- Anomaly 2: Excessive flapping (>30 transitions per TTY in 15min) ---
    // Threshold: 30 (not 10). An active agent doing rapid-fire tasks (search,
    // check, think, respond) legitimately produces 10-20 transitions in 15min.
    // Real flapping (status oscillation with no real work) is 30+.
    // Exclude "unknown → *" transitions  --  daemon startup/restart artifacts.
    const transitionsPerTty = new Map<string, number>();
    for (const e of recent) {
      if (e.from === "unknown") continue;
      transitionsPerTty.set(e.tty, (transitionsPerTty.get(e.tty) || 0) + 1);
    }
    for (const [tty, count] of transitionsPerTty) {
      if (count > 30) {
        anomalies.push({
          type: `flapping_${tty}`,
          severity: "info",
          description: `${tty} had ${count} status transitions in 15 minutes. Consider adding hysteresis (require 2 consecutive idle checks before transitioning) in discovery.ts.`,
          data: { tty, count },
        });
      }
    }

    // --- Anomaly 3: Stale file false positive on active worker ---
    const staleFP = recent.filter(e =>
      e.reason.includes("stale file") &&
      e.from === "working"
    );
    if (staleFP.length > 0) {
      anomalies.push({
        type: "stale_file_false_positive",
        severity: "warn",
        description: `${staleFP.length} workers were marked idle via "stale file" while status was "working". The JSONL file stops updating between user turns. Consider checking if idleConfirmed is true before applying the stale-file rule in discovery.ts.`,
        data: { entries: staleFP.map(e => ({ tty: e.tty, ts: e.ts })) },
      });
    }

    // --- Anomaly 4: Agent loop detection (repetitive tool calls) ---
    const allSignals = this.telemetry.getSignals();
    for (const worker of this.telemetry.getAll()) {
      if (worker.status !== "working") continue;
      const sigs = allSignals[worker.id];
      if (!sigs || sigs.length < 5) continue;

      // Look at last 20 PreToolUse signals
      const recentTools = sigs
        .filter(s => s.signal === "PreToolUse")
        .slice(-20);
      if (recentTools.length < 5) continue;

      // Count max consecutive identical tool actions from the tail
      let consecutive = 1;
      for (let i = recentTools.length - 2; i >= 0; i--) {
        if (recentTools[i].detail === recentTools[recentTools.length - 1].detail) {
          consecutive++;
        } else {
          break;
        }
      }

      if (consecutive >= 5) {
        const tty = worker.tty || worker.id;
        anomalies.push({
          type: `agent_loop_${tty}`,
          severity: "warn",
          description: `${tty} has called "${recentTools[recentTools.length - 1].detail}" ${consecutive} times consecutively. The agent may be stuck in a retry loop. Consider sending it a message to try a different approach, or check the JSONL for context.`,
          data: { tty, action: recentTools[recentTools.length - 1].detail, consecutive },
        });
      }
    }

    return anomalies;
  }

}
