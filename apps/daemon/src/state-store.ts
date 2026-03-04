import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const HOME = process.env.HOME || `/Users/${process.env.USER}`;
const STATE_PATH = join(HOME, ".hive", "daemon-state.json");
const SAVE_INTERVAL = 30_000;
const MAX_AGE = 10 * 60 * 1000;

export interface DaemonSnapshot {
  savedAt: number;
  workers: Array<{
    id: string;
    pid: number;
    project: string;
    projectName: string;
    status: string;
    lastAction: string;
    lastActionAt: number;
    errorCount: number;
    startedAt: number;
    task: string | null;
    managed: boolean;
    tty?: string;
  }>;
  messageQueue: Record<string, Array<{ id: string; content: string; source: string; queuedAt: number }>>;
  messageIdCounter: number;
  locks: Array<{ path: string; workerId: string; tty?: string; lockedAt: number }>;
  dispatchedTasks: Record<string, { task: string; project: string; sentAt: number; taskId?: string; workflowId?: string }>;
  workflowHandoffs?: Record<string, string[]>;
}

export class StateStore {
  private timer: ReturnType<typeof setInterval> | null = null;
  private exporter: (() => DaemonSnapshot) | null = null;

  static load(): DaemonSnapshot | null {
    try {
      if (!existsSync(STATE_PATH)) return null;
      const raw = readFileSync(STATE_PATH, "utf-8");
      const snapshot = JSON.parse(raw) as DaemonSnapshot;
      if (Date.now() - snapshot.savedAt > MAX_AGE) {
        console.log(`[state-store] Snapshot too old (${Math.round((Date.now() - snapshot.savedAt) / 60000)}m), discarding`);
        return null;
      }
      return snapshot;
    } catch (err) {
      console.log(`[state-store] Failed to load snapshot: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  startPeriodicSave(exporter: () => DaemonSnapshot): void {
    this.exporter = exporter;
    this.timer = setInterval(() => this.save(), SAVE_INTERVAL);
    this.timer.unref();
  }

  save(): void {
    if (!this.exporter) return;
    try {
      const snapshot = this.exporter();
      const dir = join(HOME, ".hive");
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(STATE_PATH, JSON.stringify(snapshot, null, 2) + "\n");
    } catch (err) {
      console.log(`[state-store] Save failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
