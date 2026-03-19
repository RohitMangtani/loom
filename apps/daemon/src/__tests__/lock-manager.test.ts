import { describe, it, expect, beforeEach } from "vitest";
import { LockManager } from "../lock-manager.js";

describe("LockManager", () => {
  let locks: LockManager;
  let aliveWorkers: Set<string>;

  beforeEach(() => {
    aliveWorkers = new Set(["w1", "w2", "w3"]);
    locks = new LockManager(
      (id) => aliveWorkers.has(id),
      (id) => id === "w1" ? "ttys001" : undefined,
    );
  });

  it("acquires a lock on an unlocked file", () => {
    const result = locks.acquire("/src/index.ts", "w1");
    expect(result.acquired).toBe(true);
  });

  it("blocks a second worker from the same file", () => {
    locks.acquire("/src/index.ts", "w1");
    const result = locks.acquire("/src/index.ts", "w2");
    expect(result.acquired).toBe(false);
    expect(result.holder?.workerId).toBe("w1");
  });

  it("allows the same worker to re-acquire", () => {
    locks.acquire("/src/index.ts", "w1");
    const result = locks.acquire("/src/index.ts", "w1");
    expect(result.acquired).toBe(true);
  });

  it("reclaims lock from dead worker", () => {
    locks.acquire("/src/index.ts", "w1");
    aliveWorkers.delete("w1"); // worker dies
    const result = locks.acquire("/src/index.ts", "w2");
    expect(result.acquired).toBe(true);
  });

  it("releases a lock", () => {
    locks.acquire("/src/index.ts", "w1");
    expect(locks.release("/src/index.ts", "w1")).toBe(true);
    const result = locks.acquire("/src/index.ts", "w2");
    expect(result.acquired).toBe(true);
  });

  it("returns false when releasing someone else's lock", () => {
    locks.acquire("/src/index.ts", "w1");
    expect(locks.release("/src/index.ts", "w2")).toBe(false);
  });

  it("releases all locks for a worker", () => {
    locks.acquire("/src/a.ts", "w1");
    locks.acquire("/src/b.ts", "w1");
    locks.acquire("/src/c.ts", "w2");

    const count = locks.releaseAll("w1");
    expect(count).toBe(2);

    const all = locks.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].workerId).toBe("w2");
  });

  it("lists all active locks", () => {
    locks.acquire("/a.ts", "w1");
    locks.acquire("/b.ts", "w2");
    const all = locks.getAll();
    expect(all).toHaveLength(2);
    expect(all.map(l => l.path).sort()).toEqual(["/a.ts", "/b.ts"]);
  });

  it("includes TTY in lock info", () => {
    locks.acquire("/a.ts", "w1");
    const all = locks.getAll();
    expect(all[0].tty).toBe("ttys001");
  });
});
