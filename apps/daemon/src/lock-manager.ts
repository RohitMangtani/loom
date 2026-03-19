export class LockManager {
  private locks = new Map<string, { workerId: string; tty?: string; lockedAt: number }>();
  private static readonly LOCK_TTL = 5 * 60 * 1000; // 5 minutes auto-expire

  /** Check if a worker still exists. Injected to avoid circular dependency. */
  private isWorkerAlive: (workerId: string) => boolean;
  private getWorkerTty: (workerId: string) => string | undefined;

  constructor(
    isWorkerAlive: (workerId: string) => boolean,
    getWorkerTty: (workerId: string) => string | undefined,
  ) {
    this.isWorkerAlive = isWorkerAlive;
    this.getWorkerTty = getWorkerTty;
  }

  /** Check if a lock is expired (older than TTL) */
  private isExpired(lock: { lockedAt: number }): boolean {
    return Date.now() - lock.lockedAt > LockManager.LOCK_TTL;
  }

  acquire(filePath: string, workerId: string): { acquired: boolean; holder?: { workerId: string; tty?: string; lockedAt: number } } {
    const existing = this.locks.get(filePath);
    if (existing && existing.workerId !== workerId) {
      // Release if holder is dead OR lock expired (agent forgot to release)
      if (this.isWorkerAlive(existing.workerId) && !this.isExpired(existing)) {
        return { acquired: false, holder: existing };
      }
      this.locks.delete(filePath);
    }
    this.locks.set(filePath, { workerId, tty: this.getWorkerTty(workerId), lockedAt: Date.now() });
    return { acquired: true };
  }

  release(filePath: string, workerId: string): boolean {
    const existing = this.locks.get(filePath);
    if (!existing || existing.workerId !== workerId) return false;
    this.locks.delete(filePath);
    return true;
  }

  releaseAll(workerId: string): number {
    let released = 0;
    for (const [path, lock] of this.locks) {
      if (lock.workerId === workerId) {
        this.locks.delete(path);
        released++;
      }
    }
    return released;
  }

  getAll(): Array<{ path: string; workerId: string; tty?: string; lockedAt: number }> {
    this.expireStale();
    return [...this.locks.entries()].map(([path, lock]) => ({
      path, ...lock,
    }));
  }

  getLocksExcluding(excludeWorkerId: string): Array<{ path: string; workerId: string; tty?: string; lockedAt: number }> {
    this.expireStale();
    return [...this.locks.entries()]
      .filter(([, lock]) => lock.workerId !== excludeWorkerId && this.isWorkerAlive(lock.workerId))
      .map(([path, lock]) => ({ path, ...lock }));
  }

  /** Remove expired and dead-worker locks */
  private expireStale(): void {
    for (const [path, lock] of this.locks) {
      if (this.isExpired(lock) || !this.isWorkerAlive(lock.workerId)) {
        this.locks.delete(path);
      }
    }
  }
}
