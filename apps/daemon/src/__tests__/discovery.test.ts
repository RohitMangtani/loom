import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ProcessDiscovery } from "../discovery.js";

function writeSession(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "hive-discovery-"));
  const file = join(dir, "session.jsonl");
  writeFileSync(file, lines.join("\n") + "\n", "utf-8");
  return file;
}

function createDiscoveryHarness(options?: {
  idleConfirmed?: boolean;
  lastInputMsAgo?: number;
}) {
  const telemetry = {
    isIdleConfirmed: vi.fn(() => options?.idleConfirmed ?? false),
    getLastInputSent: vi.fn(() => {
      const lastInputMsAgo = options?.lastInputMsAgo;
      if (lastInputMsAgo == null) return 0;
      return Date.now() - lastInputMsAgo;
    }),
    setIdleConfirmed: vi.fn(),
    recordSignal: vi.fn(),
    isRecentSpawn: vi.fn(() => false),
  };
  const discovery = new ProcessDiscovery(telemetry as never, {} as never) as unknown as {
    runJsonlAnalysis: (
      id: string,
      existing: Record<string, unknown>,
      tty: string,
      cachedPath: string | null,
      cachedMtime: number,
      hookAge: number,
      auditCtx: Record<string, unknown>,
    ) => void;
    getCpuForPid: (pid: number) => number;
    getPtyOutputDelta: (pid: number) => number;
    checkTransition: (
      id: string,
      tty: string,
      to: string,
      reason: string,
      context: Record<string, unknown>,
    ) => void;
  };

  discovery.getCpuForPid = () => 0;
  discovery.getPtyOutputDelta = () => 0;
  discovery.checkTransition = () => {};

  return { discovery, telemetry };
}

describe("ProcessDiscovery idle-confirmed handling", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps a just-finished worker idle despite recent input and stale fresh output", () => {
    const file = writeSession([
      '{"timestamp":"2026-03-20T03:45:14.000Z","type":"assistant","message":{"content":[{"type":"text","text":"Done."}]}}',
    ]);
    dirs.push(file.replace(/\/[^/]+$/, ""));

    const { discovery, telemetry } = createDiscoveryHarness({
      idleConfirmed: true,
      lastInputMsAgo: 1_000,
    });
    const worker = {
      id: "w1",
      pid: 123,
      project: "/Users/rmgtni/factory/projects/hive",
      projectName: "hive",
      status: "idle",
      currentAction: null,
      lastAction: "Session ended",
      lastActionAt: Date.now(),
      errorCount: 0,
      startedAt: Date.now() - 60_000,
      task: null,
      managed: false,
      tty: "ttys000",
      model: "claude",
    };

    discovery.runJsonlAnalysis("w1", worker, "ttys000", file, Date.now(), 30_000, {});

    expect(worker.status).toBe("idle");
    expect(worker.currentAction).toBeNull();
    expect(telemetry.setIdleConfirmed).not.toHaveBeenCalledWith("w1", false);
  });

  it("still lets definitive new work break the idle lock after session end", () => {
    const file = writeSession([
      '{"timestamp":"2026-03-20T03:45:14.000Z","type":"user","message":{"role":"user","content":[{"type":"text","text":"Run the next task"}]}}',
    ]);
    dirs.push(file.replace(/\/[^/]+$/, ""));

    const { discovery, telemetry } = createDiscoveryHarness({
      idleConfirmed: true,
      lastInputMsAgo: 1_000,
    });
    const worker = {
      id: "w1",
      pid: 123,
      project: "/Users/rmgtni/factory/projects/hive",
      projectName: "hive",
      status: "idle",
      currentAction: null,
      lastAction: "Session ended",
      lastActionAt: Date.now(),
      errorCount: 0,
      startedAt: Date.now() - 60_000,
      task: null,
      managed: false,
      tty: "ttys000",
      model: "claude",
    };

    discovery.runJsonlAnalysis("w1", worker, "ttys000", file, Date.now(), 30_000, {});

    expect(worker.status).toBe("working");
    expect(worker.currentAction).toBe("Thinking...");
    expect(telemetry.setIdleConfirmed).toHaveBeenCalledWith("w1", false);
  });

  it("falls back to CPU analysis when a Claude worker has no session file and hooks are stale", () => {
    const { discovery } = createDiscoveryHarness();
    const worker = {
      id: "w1",
      pid: 123,
      project: "/Users/rmgtni/factory/projects/hive",
      projectName: "hive",
      status: "working",
      currentAction: "Thinking...",
      lastAction: "Run doctor.sh with --repair-satellite flag",
      lastActionAt: Date.now() - 60_000,
      errorCount: 0,
      startedAt: Date.now() - 120_000,
      task: null,
      managed: false,
      tty: "ttys000",
      model: "claude",
    };

    discovery.runJsonlAnalysis("w1", worker, "ttys000", null, 0, 30_000, {});
    expect(worker.status).toBe("working");

    discovery.runJsonlAnalysis("w1", worker, "ttys000", null, 0, 30_000, {});
    expect(worker.status).toBe("idle");
    expect(worker.currentAction).toBeNull();
  });

  it("keeps the last Claude state when hooks are still fresh and no session file is mapped", () => {
    const { discovery } = createDiscoveryHarness();
    const worker = {
      id: "w1",
      pid: 123,
      project: "/Users/rmgtni/factory/projects/hive",
      projectName: "hive",
      status: "working",
      currentAction: "Thinking...",
      lastAction: "Received prompt",
      lastActionAt: Date.now(),
      errorCount: 0,
      startedAt: Date.now() - 10_000,
      task: null,
      managed: false,
      tty: "ttys000",
      model: "claude",
    };

    discovery.runJsonlAnalysis("w1", worker, "ttys000", null, 0, 3_000, {});
    expect(worker.status).toBe("working");
    expect(worker.currentAction).toBe("Thinking...");
  });
});
