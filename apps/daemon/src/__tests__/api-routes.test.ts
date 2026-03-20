import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerApiRoutes } from "../api-routes.js";

interface Harness {
  baseUrl: string;
  close: () => Promise<void>;
  receiver: Record<string, unknown>;
}

async function createHarness(): Promise<Harness> {
  const app = express();
  app.use(express.json());

  const receiver = {
    getAllWorkersIncludingSatellites: vi.fn(() => []),
    sendToWorkerAsync: vi.fn(),
    getWorkerContextAsync: vi.fn(),
    getWorkerContexts: vi.fn(() => []),
    getMessageQueueDetails: vi.fn(() => ({})),
    cancelMessage: vi.fn(() => false),
    getTaskQueue: vi.fn(() => []),
    pushTask: vi.fn(),
    getTaskQueueLength: vi.fn(() => 0),
    removeTask: vi.fn(() => false),
    getAll: vi.fn(() => []),
    getArtifacts: vi.fn(() => []),
    checkConflicts: vi.fn(() => []),
    getSignals: vi.fn(() => []),
    getAllLocks: vi.fn(() => []),
    acquireLock: vi.fn(() => ({ acquired: true })),
    releaseLock: vi.fn(() => true),
    releaseAllLocks: vi.fn(() => 0),
    setScratchpad: vi.fn(),
    getScratchpad: vi.fn(),
    getAllScratchpad: vi.fn(() => []),
    deleteScratchpad: vi.fn(() => true),
    getDebugState: vi.fn(() => ({})),
    updateSatellites: vi.fn(),
    spawnViaSwarm: vi.fn(() => ({ ok: true, machine: "satellite-1", model: "claude", project: "/Users/rohitmangtani/hive" })),
    killViaSwarm: vi.fn(() => ({ ok: true, workerId: "satellite-1:w1" })),
    maintainSatelliteViaSwarm: vi.fn(() => ({ ok: true, machine: "satellite-1", action: "reinstall" })),
    execViaSwarm: vi.fn(async () => ({
      ok: true,
      machine: "satellite-1",
      command: "pwd",
      cwd: "/Users/rohitmangtani/hive",
      stdout: "/Users/rohitmangtani/hive\n",
      stderr: "",
      exitCode: 0,
      timedOut: false,
      durationMs: 12,
    })),
    getSwarmProjects: vi.fn(() => ({
      projects: [
        {
          name: "hive",
          path: "/Users/rmgtni/factory/projects/hive",
          machines: {
            local: "/Users/rmgtni/factory/projects/hive",
            "satellite-1": "/Users/rohitmangtani/hive",
          },
        },
      ],
    })),
    getSwarmCapabilities: vi.fn(() => ({
      local: { node: true, projects: { hive: "/Users/rmgtni/factory/projects/hive" } },
      "satellite-1": { node: true, projects: { hive: "/Users/rohitmangtani/hive" } },
    })),
    get: vi.fn(),
    addReview: vi.fn(),
    getUnseenReviews: vi.fn(() => []),
    getReviews: vi.fn(() => []),
    markReviewSeen: vi.fn(() => true),
    markAllReviewsSeen: vi.fn(() => 0),
    dismissReview: vi.fn(() => true),
    clearAllReviews: vi.fn(() => 0),
    forceRearrange: vi.fn(),
  };

  const procMgr = {} as never;
  const discovery = { getAuditLog: vi.fn(() => []) } as never;
  registerApiRoutes(app, (_req, _res, next) => next(), receiver as never, procMgr, discovery);

  const server = await new Promise<import("http").Server>((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to bind test server");

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    receiver,
    close: () => new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve())),
  };
}

describe("registerApiRoutes", () => {
  const harnesses: Harness[] = [];

  afterEach(async () => {
    while (harnesses.length > 0) {
      const harness = harnesses.pop();
      if (harness) await harness.close();
    }
  });

  it("serves swarm-wide project and capability views", async () => {
    const harness = await createHarness();
    harnesses.push(harness);

    const projectsRes = await fetch(`${harness.baseUrl}/api/projects`);
    const capabilitiesRes = await fetch(`${harness.baseUrl}/api/capabilities`);

    expect(await projectsRes.json()).toEqual(harness.receiver.getSwarmProjects());
    expect(await capabilitiesRes.json()).toEqual(harness.receiver.getSwarmCapabilities());
  });

  it("routes spawn and kill requests through the swarm control plane", async () => {
    const harness = await createHarness();
    harnesses.push(harness);

    const spawnRes = await fetch(`${harness.baseUrl}/api/spawn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: "hive",
        machine: "satellite-1",
        model: "claude",
        task: "Audit the remote daemon",
      }),
    });
    const killRes = await fetch(`${harness.baseUrl}/api/kill`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workerId: "satellite-1:w1" }),
    });

    expect(harness.receiver.spawnViaSwarm).toHaveBeenCalledWith({
      project: "hive",
      machine: "satellite-1",
      model: "claude",
      task: "Audit the remote daemon",
      targetQuadrant: undefined,
    });
    expect(harness.receiver.killViaSwarm).toHaveBeenCalledWith("satellite-1:w1");
    expect(await spawnRes.json()).toEqual({ ok: true, machine: "satellite-1", model: "claude", project: "/Users/rohitmangtani/hive" });
    expect(await killRes.json()).toEqual({ ok: true, workerId: "satellite-1:w1" });
  });

  it("routes satellite repair requests through the swarm control plane", async () => {
    const harness = await createHarness();
    harnesses.push(harness);

    const repairRes = await fetch(`${harness.baseUrl}/api/satellites/repair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        machine: "satellite-1",
        action: "reinstall",
      }),
    });

    expect(harness.receiver.maintainSatelliteViaSwarm).toHaveBeenCalledWith("satellite-1", "reinstall");
    expect(await repairRes.json()).toEqual({ ok: true, machine: "satellite-1", action: "reinstall" });
  });

  it("routes exec requests through the swarm control plane", async () => {
    const harness = await createHarness();
    harnesses.push(harness);

    const execRes = await fetch(`${harness.baseUrl}/api/exec`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        machine: "satellite-1",
        cwd: "hive",
        command: "pwd",
        timeoutMs: 5_000,
      }),
    });

    expect(harness.receiver.execViaSwarm).toHaveBeenCalledWith({
      machine: "satellite-1",
      cwd: "hive",
      command: "pwd",
      timeoutMs: 5_000,
    });
    expect(await execRes.json()).toEqual({
      ok: true,
      machine: "satellite-1",
      command: "pwd",
      cwd: "/Users/rohitmangtani/hive",
      stdout: "/Users/rohitmangtani/hive\n",
      stderr: "",
      exitCode: 0,
      timedOut: false,
      durationMs: 12,
    });
  });
});
