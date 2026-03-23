import { Scratchpad } from "./scratchpad.js";
import type { ScratchpadEntry } from "./scratchpad.js";
import { LockManager } from "./lock-manager.js";

export type { ScratchpadEntry } from "./scratchpad.js";

/**
 * CoordinationLayer: owns the three multi-agent coordination primitives
 * (scratchpad, locks, artifacts) that were previously inlined in TelemetryReceiver.
 *
 * Extracted to reduce god-class coupling. TelemetryReceiver delegates here.
 */

const MAX_ARTIFACTS = 50;

/** Narrow dependency interface — avoids circular dependency on TelemetryReceiver. */
export interface CoordinationDeps {
  isWorkerAlive(workerId: string): boolean;
  getWorkerTty(workerId: string): string | undefined;
}

export class CoordinationLayer {
  private scratchpad: Scratchpad;
  private lockManager: LockManager;
  private artifacts = new Map<string, Array<{ path: string; action: string; ts: number }>>();

  constructor(deps: CoordinationDeps) {
    this.scratchpad = new Scratchpad();
    this.lockManager = new LockManager(
      (id) => deps.isWorkerAlive(id),
      (id) => deps.getWorkerTty(id),
    );
  }

  // ── Scratchpad ──────────────────────────────────────────────────────

  getScratchpad(key: string): ScratchpadEntry | undefined {
    return this.scratchpad.get(key);
  }

  getAllScratchpad(): Record<string, ScratchpadEntry> {
    return this.scratchpad.getAll();
  }

  setScratchpad(key: string, value: string, setBy: string): ScratchpadEntry {
    return this.scratchpad.set(key, value, setBy);
  }

  deleteScratchpad(key: string): boolean {
    return this.scratchpad.delete(key);
  }

  expireScratchpad(): void {
    this.scratchpad.expire();
  }

  // ── Locks ───────────────────────────────────────────────────────────

  acquireLock(filePath: string, workerId: string): { acquired: boolean; holder?: { workerId: string; tty?: string; lockedAt: number } } {
    return this.lockManager.acquire(filePath, workerId);
  }

  releaseLock(filePath: string, workerId: string): boolean {
    return this.lockManager.release(filePath, workerId);
  }

  releaseAllLocks(workerId: string): number {
    return this.lockManager.releaseAll(workerId);
  }

  getAllLocks(): Array<{ path: string; workerId: string; tty?: string; lockedAt: number }> {
    return this.lockManager.getAll();
  }

  getLocksExcluding(workerId: string): Array<{ path: string; workerId: string; tty?: string; lockedAt: number }> {
    return this.lockManager.getLocksExcluding(workerId);
  }

  // ── Artifacts ───────────────────────────────────────────────────────

  recordArtifact(workerId: string, filePath: string, action: string): void {
    if (!this.artifacts.has(workerId)) {
      this.artifacts.set(workerId, []);
    }
    const list = this.artifacts.get(workerId)!;
    const existing = list.find(a => a.path === filePath);
    if (existing) {
      existing.action = action;
      existing.ts = Date.now();
    } else {
      list.push({ path: filePath, action, ts: Date.now() });
      if (list.length > MAX_ARTIFACTS) {
        list.shift();
      }
    }
  }

  getArtifacts(workerId: string): Array<{ path: string; action: string; ts: number }> {
    return this.artifacts.get(workerId) || [];
  }

  getRecentArtifacts(workerId: string, limit = 5): Array<{ path: string; action: string; ts: number }> {
    return this.getArtifacts(workerId)
      .filter((artifact) => Date.now() - artifact.ts < 30 * 60 * 1000)
      .slice(-limit);
  }

  checkConflicts(
    filePath: string,
    excludeWorkerId?: string,
    maxAgeMs = 30 * 60 * 1000,
    getWorkerTty?: (wid: string) => string | undefined,
  ): Array<{ workerId: string; tty?: string; action: string; ts: number }> {
    const results: Array<{ workerId: string; tty?: string; action: string; ts: number }> = [];
    const now = Date.now();
    for (const [wid, arts] of this.artifacts) {
      if (wid === excludeWorkerId) continue;
      for (const art of arts) {
        if (art.path === filePath && now - art.ts < maxAgeMs) {
          results.push({ workerId: wid, tty: getWorkerTty?.(wid), action: art.action, ts: art.ts });
        }
      }
    }
    return results;
  }

  /** Get all artifact entries (for iteration in export/debug). */
  getAllArtifactEntries(): Map<string, Array<{ path: string; action: string; ts: number }>> {
    return this.artifacts;
  }

  // ── State persistence ───────────────────────────────────────────────

  exportLocks(): Array<{ path: string; workerId: string; tty?: string; lockedAt: number }> {
    return this.lockManager.getAll();
  }

  importLocks(locks: Array<{ path: string; workerId: string }>): void {
    for (const lock of locks) {
      this.lockManager.acquire(lock.path, lock.workerId);
    }
  }
}
