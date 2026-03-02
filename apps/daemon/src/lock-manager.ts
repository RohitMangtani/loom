export class LockManager {
  private locks = new Map<string, { workerId: string; tty?: string; lockedAt: number }>();

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

  acquire(filePath: string, workerId: string): { acquired: boolean; holder?: { workerId: string; tty?: string; lockedAt: number } } {
    const existing = this.locks.get(filePath);
    if (existing && existing.workerId !== workerId) {
      if (this.isWorkerAlive(existing.workerId)) {
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
    return [...this.locks.entries()].map(([path, lock]) => ({
      path, ...lock,
    }));
  }
}
