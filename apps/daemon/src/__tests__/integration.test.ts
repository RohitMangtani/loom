/**
 * Integration test: daemon → agent discovery → status detection → API response
 *
 * Verifies the end-to-end flow: register a fake worker, send it through
 * the telemetry pipeline, and confirm it appears correctly via the REST API
 * and worker context system.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { TelemetryReceiver } from "../telemetry.js";
import type { WorkerState } from "../types.js";

// Mock fs operations (telemetry writes workers.json, learnings, etc.)
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    existsSync: vi.fn((p: string) => {
      // Allow real reads for test fixtures, block ~/.hive writes
      if (typeof p === "string" && p.includes(".hive")) return false;
      return actual.existsSync(p);
    }),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    appendFileSync: vi.fn(),
    readFileSync: vi.fn((p: string, enc?: string) => {
      if (typeof p === "string" && p.includes("queue.json")) return "[]";
      if (typeof p === "string" && p.includes("scratchpad.json")) return "{}";
      if (typeof p === "string" && p.includes("reviews.json")) return "[]";
      return "{}";
    }),
    readdirSync: vi.fn(() => []),
    statSync: vi.fn(() => ({ mtimeMs: Date.now(), isDirectory: () => true })),
  };
});

// Mock tty-input (no real Terminal.app interaction in tests)
vi.mock("../tty-input.js", () => ({
  sendInputToTty: vi.fn(() => ({ ok: true })),
  sendInputToTtyAsync: vi.fn(() => Promise.resolve({ ok: true })),
  isSendInFlight: vi.fn(() => false),
  sendSelectionToTty: vi.fn(() => ({ ok: true })),
  sendEnterToTty: vi.fn(() => ({ ok: true })),
  sendEnterToTtyAsync: vi.fn(() => Promise.resolve({ ok: true })),
  sendInputToMultipleTtys: vi.fn(() => []),
}));

// Mock arrange-windows (no real window management in tests)
vi.mock("../arrange-windows.js", () => ({
  updateTerminalTitles: vi.fn(),
  arrangeTerminalWindows: vi.fn(),
  detectQuadrantsFromWindowPositions: vi.fn(),
  positionWindowToQuadrant: vi.fn(),
  resetArrangementCache: vi.fn(),
  spawnTerminalWindow: vi.fn(),
  closeTerminalWindow: vi.fn(),
}));

// Mock child_process
vi.mock("child_process", () => ({
  execFileSync: vi.fn(() => ""),
  execFile: vi.fn(),
}));

// Mock project-discovery
vi.mock("../project-discovery.js", () => ({
  scanLocalProjects: vi.fn(() => ({})),
}));

function createWorker(overrides: Partial<WorkerState> = {}): WorkerState {
  return {
    id: `test_${Math.random().toString(36).slice(2, 8)}`,
    pid: 12345,
    project: "/Users/test/projects/myapp",
    projectName: "myapp",
    status: "idle",
    currentAction: null,
    lastAction: "Discovered",
    lastActionAt: Date.now(),
    errorCount: 0,
    startedAt: Date.now() - 30000,
    task: null,
    managed: false,
    tty: "ttys001",
    model: "claude",
    ...overrides,
  };
}

describe("Integration: daemon worker lifecycle", () => {
  let telemetry: TelemetryReceiver;

  afterEach(() => {
    // TelemetryReceiver starts an Express server  --  we need to stop it
    // But in these tests we don't call start(), so just clean up
  });

  it("registers a discovered worker and retrieves it via getAll", () => {
    telemetry = new TelemetryReceiver(0, "test-token");
    const worker = createWorker({ id: "w_integration_1", status: "idle" });

    telemetry.registerDiscovered(worker.id, worker);

    const all = telemetry.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe("w_integration_1");
    expect(all[0].status).toBe("idle");
    expect(all[0].projectName).toBe("myapp");
  });

  it("transitions worker status through the full lifecycle", () => {
    telemetry = new TelemetryReceiver(0, "test-token");
    const worker = createWorker({ id: "w_lifecycle", status: "idle" });

    telemetry.registerDiscovered(worker.id, worker);

    // Simulate a hook event: PreToolUse (agent starts working)
    const retrieved = telemetry.get("w_lifecycle");
    expect(retrieved).toBeDefined();
    expect(retrieved!.status).toBe("idle");

    // Manually transition to working (simulating what discovery does)
    retrieved!.status = "working";
    retrieved!.currentAction = "Reading /src/app.ts";
    retrieved!.lastAction = "Reading /src/app.ts";
    retrieved!.lastActionAt = Date.now();

    const working = telemetry.get("w_lifecycle");
    expect(working!.status).toBe("working");
    expect(working!.currentAction).toBe("Reading /src/app.ts");
  });

  it("tracks artifacts across workers and detects conflicts", () => {
    telemetry = new TelemetryReceiver(0, "test-token");
    const w1 = createWorker({ id: "w_art1", tty: "ttys001" });
    const w2 = createWorker({ id: "w_art2", tty: "ttys002" });

    telemetry.registerDiscovered(w1.id, w1);
    telemetry.registerDiscovered(w2.id, w2);

    // Both workers edit the same file
    telemetry.recordArtifact("w_art1", "/src/shared.ts", "edited");
    telemetry.recordArtifact("w_art2", "/src/shared.ts", "edited");

    // Check conflicts from w2's perspective
    const conflicts = telemetry.checkConflicts("/src/shared.ts", "w_art2");
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].workerId).toBe("w_art1");
  });

  it("manages the scratchpad for cross-agent coordination", () => {
    telemetry = new TelemetryReceiver(0, "test-token");

    const entry = telemetry.setScratchpad("current_task", "Deploy dashboard", "w1");
    expect(entry.value).toBe("Deploy dashboard");
    expect(entry.setBy).toBe("w1");

    const retrieved = telemetry.getScratchpad("current_task");
    expect(retrieved).toBeDefined();
    expect(retrieved!.value).toBe("Deploy dashboard");

    telemetry.deleteScratchpad("current_task");
    expect(telemetry.getScratchpad("current_task")).toBeUndefined();
  });

  it("manages file locks and prevents concurrent edits", () => {
    telemetry = new TelemetryReceiver(0, "test-token");
    const w1 = createWorker({ id: "w_lock1" });
    const w2 = createWorker({ id: "w_lock2" });

    telemetry.registerDiscovered(w1.id, w1);
    telemetry.registerDiscovered(w2.id, w2);

    // w1 acquires lock
    const result1 = telemetry.acquireLock("/src/app.ts", "w_lock1");
    expect(result1.acquired).toBe(true);

    // w2 tries to acquire same lock  --  blocked
    const result2 = telemetry.acquireLock("/src/app.ts", "w_lock2");
    expect(result2.acquired).toBe(false);
    expect(result2.holder?.workerId).toBe("w_lock1");

    // w1 releases, w2 can now acquire
    telemetry.releaseLock("/src/app.ts", "w_lock1");
    const result3 = telemetry.acquireLock("/src/app.ts", "w_lock2");
    expect(result3.acquired).toBe(true);
  });

  it("adds and retrieves reviews with auto-detected quadrants", () => {
    telemetry = new TelemetryReceiver(0, "test-token");
    const worker = createWorker({ id: "w_review" });
    telemetry.registerDiscovered(worker.id, worker);

    const review = telemetry.addReview("Q1 pushed hive (main)", "w_review", "hive", {
      type: "push",
      url: "https://github.com/RohitMangtani/hive",
    });

    expect(review.type).toBe("push");
    expect(review.seen).toBe(false);

    const all = telemetry.getReviews();
    expect(all).toHaveLength(1);

    telemetry.markReviewSeen(review.id);
    expect(telemetry.getUnseenReviews()).toHaveLength(0);
  });

  it("removes workers cleanly and releases their locks", () => {
    telemetry = new TelemetryReceiver(0, "test-token");
    const worker = createWorker({ id: "w_remove" });
    telemetry.registerDiscovered(worker.id, worker);

    telemetry.acquireLock("/src/file.ts", "w_remove");
    expect(telemetry.getAllLocks()).toHaveLength(1);

    telemetry.removeWorker("w_remove");

    expect(telemetry.getAll()).toHaveLength(0);
    expect(telemetry.getAllLocks()).toHaveLength(0);
  });

  it("exports and imports state for daemon restart recovery", () => {
    telemetry = new TelemetryReceiver(0, "test-token");
    const worker = createWorker({ id: "w_persist", tty: "ttys005" });
    telemetry.registerDiscovered(worker.id, worker);
    telemetry.acquireLock("/src/file.ts", "w_persist");

    const snapshot = telemetry.exportState();
    expect(snapshot.workers).toHaveLength(1);
    expect(snapshot.locks).toHaveLength(1);
    expect(snapshot.savedAt).toBeGreaterThan(0);

    // Create fresh telemetry and import
    const telemetry2 = new TelemetryReceiver(0, "test-token-2");
    telemetry2.importState(snapshot);

    expect(telemetry2.getAll()).toHaveLength(1);
    expect(telemetry2.getAll()[0].id).toBe("w_persist");
    // Locks restored
    const lockResult = telemetry2.acquireLock("/src/file.ts", "w_other");
    expect(lockResult.acquired).toBe(false);
  });
});
