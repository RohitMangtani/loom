import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerApiRoutes } from "../api-routes.js";

interface Harness {
  baseUrl: string;
  close: () => Promise<void>;
  receiver: Record<string, unknown>;
}

async function createHarness(options?: {
  requireAuth?: Parameters<typeof registerApiRoutes>[1];
}): Promise<Harness> {
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
  registerApiRoutes(
    app,
    options?.requireAuth || ((_req, _res, next) => next()),
    receiver as never,
    procMgr,
    discovery,
  );

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

  it("rejects unauthorized exec and kill requests before touching the control plane", async () => {
    const requireAuth = (
      req: Parameters<Parameters<typeof registerApiRoutes>[1]>[0],
      res: Parameters<Parameters<typeof registerApiRoutes>[1]>[1],
      next: Parameters<Parameters<typeof registerApiRoutes>[1]>[2],
    ) => {
      if (req.headers.authorization !== "Bearer secret") {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      next();
    };
    const harness = await createHarness({ requireAuth });
    harnesses.push(harness);

    const execRes = await fetch(`${harness.baseUrl}/api/exec`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "pwd" }),
    });
    const killRes = await fetch(`${harness.baseUrl}/api/kill`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workerId: "satellite-1:w1" }),
    });

    expect(execRes.status).toBe(401);
    expect(await execRes.json()).toEqual({ error: "Unauthorized" });
    expect(killRes.status).toBe(401);
    expect(await killRes.json()).toEqual({ error: "Unauthorized" });
    expect(harness.receiver.execViaSwarm).not.toHaveBeenCalled();
    expect(harness.receiver.killViaSwarm).not.toHaveBeenCalled();
  });

  it("rejects malformed privileged control-plane inputs before touching the swarm handlers", async () => {
    const harness = await createHarness();
    harnesses.push(harness);

    const spawnRes = await fetch(`${harness.baseUrl}/api/spawn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: "/tmp/demo",
        model: "claude;rm",
      }),
    });
    const killRes = await fetch(`${harness.baseUrl}/api/kill`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workerId: "../bad-worker" }),
    });
    const repairRes = await fetch(`${harness.baseUrl}/api/satellites/repair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        machine: "satellite-1",
        action: "destroy",
      }),
    });
    const execRes = await fetch(`${harness.baseUrl}/api/exec`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        machine: "satellite-1",
        command: "x".repeat(5001),
      }),
    });

    expect(spawnRes.status).toBe(400);
    expect(await spawnRes.json()).toEqual({ error: "Invalid model" });
    expect(killRes.status).toBe(400);
    expect(await killRes.json()).toEqual({ error: "Invalid workerId" });
    expect(repairRes.status).toBe(400);
    expect(await repairRes.json()).toEqual({ error: "Invalid action" });
    expect(execRes.status).toBe(400);
    expect(await execRes.json()).toEqual({ error: "Invalid command" });
    expect(harness.receiver.spawnViaSwarm).not.toHaveBeenCalled();
    expect(harness.receiver.killViaSwarm).not.toHaveBeenCalled();
    expect(harness.receiver.maintainSatelliteViaSwarm).not.toHaveBeenCalled();
    expect(harness.receiver.execViaSwarm).not.toHaveBeenCalled();
  });

  it("maps exec control-plane failures to the correct HTTP statuses", async () => {
    const harness = await createHarness();
    harnesses.push(harness);

    vi.mocked(harness.receiver.execViaSwarm as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        ok: false,
        command: "sleep 10",
        cwd: "/Users/rmgtni/factory/projects/hive",
        stdout: "",
        stderr: "",
        exitCode: null,
        timedOut: true,
        durationMs: 5_000,
        error: "Command timed out",
      })
      .mockResolvedValueOnce({
        ok: false,
        command: "pwd",
        cwd: "hive",
        stdout: "",
        stderr: "",
        exitCode: null,
        timedOut: false,
        durationMs: 12,
        error: 'Machine "satellite-9" not connected',
      })
      .mockResolvedValueOnce({
        ok: false,
        command: "pwd",
        cwd: "missing-project",
        stdout: "",
        stderr: "",
        exitCode: null,
        timedOut: false,
        durationMs: 8,
        error: "Working directory not found: /missing-project",
      });

    const timeoutRes = await fetch(`${harness.baseUrl}/api/exec`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "sleep 10" }),
    });
    const missingMachineRes = await fetch(`${harness.baseUrl}/api/exec`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ machine: "satellite-9", command: "pwd", cwd: "hive" }),
    });
    const missingCwdRes = await fetch(`${harness.baseUrl}/api/exec`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "pwd", cwd: "missing-project" }),
    });

    expect(timeoutRes.status).toBe(408);
    expect((await timeoutRes.json()).timedOut).toBe(true);
    expect(missingMachineRes.status).toBe(404);
    expect((await missingMachineRes.json()).error).toContain("not connected");
    expect(missingCwdRes.status).toBe(400);
    expect((await missingCwdRes.json()).error).toContain("Working directory not found");
  });

  it("maps missing worker kill requests to 404", async () => {
    const harness = await createHarness();
    harnesses.push(harness);

    vi.mocked(harness.receiver.killViaSwarm as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce({ ok: false, error: "Worker satellite-1:w404 not found" });

    const killRes = await fetch(`${harness.baseUrl}/api/kill`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workerId: "satellite-1:w404" }),
    });

    expect(killRes.status).toBe(404);
    expect(await killRes.json()).toEqual({ error: "Worker satellite-1:w404 not found" });
  });
});
