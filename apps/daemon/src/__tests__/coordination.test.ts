/**
 * Tests for CoordinationLayer  --  the extracted scratchpad, locks, and artifact
 * tracking module. Validates that multi-agent coordination primitives work
 * correctly in isolation.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { CoordinationLayer } from "../coordination.js";

function createCoordination() {
  return new CoordinationLayer({
    isWorkerAlive: (id) => id !== "dead_worker",
    getWorkerTty: (id) => id === "w1" ? "ttys001" : id === "w2" ? "ttys002" : undefined,
  });
}

describe("CoordinationLayer", () => {
  // ── Artifacts ──────────────────────────────────────────────────────

  describe("artifacts", () => {
    it("records and retrieves artifacts", () => {
      const coord = createCoordination();
      coord.recordArtifact("w1", "/src/app.ts", "edited");
      coord.recordArtifact("w1", "/src/test.ts", "created");

      const arts = coord.getArtifacts("w1");
      expect(arts).toHaveLength(2);
      expect(arts[0].path).toBe("/src/app.ts");
      expect(arts[0].action).toBe("edited");
      expect(arts[1].path).toBe("/src/test.ts");
    });

    it("returns empty array for unknown worker", () => {
      const coord = createCoordination();
      expect(coord.getArtifacts("unknown")).toEqual([]);
    });

    it("deduplicates by path (updates in place)", () => {
      const coord = createCoordination();
      coord.recordArtifact("w1", "/src/app.ts", "created");
      coord.recordArtifact("w1", "/src/app.ts", "edited");

      const arts = coord.getArtifacts("w1");
      expect(arts).toHaveLength(1);
      expect(arts[0].action).toBe("edited");
    });

    it("caps at 50 artifacts per worker (FIFO eviction)", () => {
      const coord = createCoordination();
      for (let i = 0; i < 55; i++) {
        coord.recordArtifact("w1", `/src/file${i}.ts`, "edited");
      }

      const arts = coord.getArtifacts("w1");
      expect(arts).toHaveLength(50);
      // First 5 should have been evicted
      expect(arts[0].path).toBe("/src/file5.ts");
    });

    it("getRecentArtifacts filters by age and limits", () => {
      const coord = createCoordination();
      coord.recordArtifact("w1", "/src/old.ts", "edited");
      // Backdate the first artifact
      coord.getArtifacts("w1")[0].ts = Date.now() - 60 * 60 * 1000; // 1 hour ago

      coord.recordArtifact("w1", "/src/new1.ts", "edited");
      coord.recordArtifact("w1", "/src/new2.ts", "created");
      coord.recordArtifact("w1", "/src/new3.ts", "edited");

      const recent = coord.getRecentArtifacts("w1", 2);
      expect(recent).toHaveLength(2);
      // Should not include the old one
      expect(recent.every(a => !a.path.includes("old"))).toBe(true);
    });
  });

  // ── Conflict detection ─────────────────────────────────────────────

  describe("checkConflicts", () => {
    it("detects when two workers edited the same file", () => {
      const coord = createCoordination();
      coord.recordArtifact("w1", "/src/shared.ts", "edited");
      coord.recordArtifact("w2", "/src/shared.ts", "edited");

      const conflicts = coord.checkConflicts("/src/shared.ts", "w2", 30 * 60 * 1000,
        (wid) => wid === "w1" ? "ttys001" : undefined);
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].workerId).toBe("w1");
      expect(conflicts[0].tty).toBe("ttys001");
    });

    it("excludes the requesting worker", () => {
      const coord = createCoordination();
      coord.recordArtifact("w1", "/src/mine.ts", "edited");

      const conflicts = coord.checkConflicts("/src/mine.ts", "w1");
      expect(conflicts).toHaveLength(0);
    });

    it("ignores old artifacts outside the time window", () => {
      const coord = createCoordination();
      coord.recordArtifact("w1", "/src/old.ts", "edited");
      coord.getArtifacts("w1")[0].ts = Date.now() - 60 * 60 * 1000;

      const conflicts = coord.checkConflicts("/src/old.ts", "w2", 30 * 60 * 1000);
      expect(conflicts).toHaveLength(0);
    });
  });

  // ── Locks ──────────────────────────────────────────────────────────

  describe("locks", () => {
    it("acquires and releases a lock", () => {
      const coord = createCoordination();
      const result = coord.acquireLock("/src/file.ts", "w1");
      expect(result.acquired).toBe(true);

      const all = coord.getAllLocks();
      expect(all).toHaveLength(1);
      expect(all[0].path).toBe("/src/file.ts");

      coord.releaseLock("/src/file.ts", "w1");
      expect(coord.getAllLocks()).toHaveLength(0);
    });

    it("blocks acquisition when another worker holds the lock", () => {
      const coord = createCoordination();
      coord.acquireLock("/src/file.ts", "w1");

      const result = coord.acquireLock("/src/file.ts", "w2");
      expect(result.acquired).toBe(false);
      expect(result.holder?.workerId).toBe("w1");
    });

    it("allows same worker to re-acquire their own lock", () => {
      const coord = createCoordination();
      coord.acquireLock("/src/file.ts", "w1");

      const result = coord.acquireLock("/src/file.ts", "w1");
      expect(result.acquired).toBe(true);
    });

    it("releaseAllLocks clears all locks for a worker", () => {
      const coord = createCoordination();
      coord.acquireLock("/src/a.ts", "w1");
      coord.acquireLock("/src/b.ts", "w1");
      coord.acquireLock("/src/c.ts", "w2");

      const released = coord.releaseAllLocks("w1");
      expect(released).toBe(2);
      expect(coord.getAllLocks()).toHaveLength(1);
      expect(coord.getAllLocks()[0].workerId).toBe("w2");
    });

    it("getLocksExcluding returns locks held by other workers", () => {
      const coord = createCoordination();
      coord.acquireLock("/src/mine.ts", "w1");
      coord.acquireLock("/src/theirs.ts", "w2");

      const others = coord.getLocksExcluding("w1");
      expect(others).toHaveLength(1);
      expect(others[0].path).toBe("/src/theirs.ts");
    });
  });

  // ── Scratchpad ─────────────────────────────────────────────────────

  describe("scratchpad", () => {
    it("sets and gets values", () => {
      const coord = createCoordination();
      coord.setScratchpad("key1", "value1", "w1");

      const entry = coord.getScratchpad("key1");
      expect(entry).toBeDefined();
      expect(entry!.value).toBe("value1");
      expect(entry!.setBy).toBe("w1");
    });

    it("returns undefined for missing keys", () => {
      const coord = createCoordination();
      expect(coord.getScratchpad("missing")).toBeUndefined();
    });

    it("getAllScratchpad returns all entries", () => {
      const coord = createCoordination();
      coord.setScratchpad("testA", "1", "w1");
      coord.setScratchpad("testB", "2", "w2");

      const all = coord.getAllScratchpad();
      expect(all["testA"]).toBeDefined();
      expect(all["testB"]).toBeDefined();
    });

    it("deletes entries", () => {
      const coord = createCoordination();
      coord.setScratchpad("key1", "value1", "w1");

      expect(coord.deleteScratchpad("key1")).toBe(true);
      expect(coord.getScratchpad("key1")).toBeUndefined();
    });
  });

  // ── State persistence ──────────────────────────────────────────────

  describe("state persistence", () => {
    it("exports and imports locks", () => {
      const coord1 = createCoordination();
      coord1.acquireLock("/src/a.ts", "w1");
      coord1.acquireLock("/src/b.ts", "w2");

      const exported = coord1.exportLocks();
      expect(exported).toHaveLength(2);

      const coord2 = createCoordination();
      coord2.importLocks(exported);
      expect(coord2.getAllLocks()).toHaveLength(2);
    });
  });
});
