import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { WsServer } from "../ws-server.js";

type RemovalHandler = () => void;
type UpdateHandler = (workerId: string, worker: unknown) => void;

function createServer(initialWorkers: unknown[] = []) {
  let workers = initialWorkers;
  let removalHandler: RemovalHandler | null = null;
  let updateHandler: UpdateHandler | null = null;

  const telemetry = {
    onUpdate(handler: UpdateHandler) {
      updateHandler = handler;
    },
    onRemoval(handler: RemovalHandler) {
      removalHandler = handler;
    },
    onReviewAdded() {
      // no-op for tests
    },
    setSatelliteRelay() {},
    setCapabilityRouter() {},
    setSatelliteContextRelay() {},
    setSwarmApi() {},
    onAutoCommit() {},
    onFullBroadcast() {},
    setScratchpad() {},
    setSatelliteSlots() {},
    getAll() {
      return workers;
    },
    getReviews() {
      return [];
    },
  };

  const procMgr = {
    setOutputHandler: vi.fn(),
  };

  const streamer = {
    unsubscribe: vi.fn(),
    readHistory: vi.fn(() => []),
    subscribe: vi.fn(),
    nudge: vi.fn(),
  };

  const server = new WsServer(
    telemetry as never,
    procMgr as never,
    streamer as never,
    3002,
    "token",
    "viewer-token"
  ) as unknown as {
    clients: Set<{ readyState: number; send: (data: string) => void }>;
    pushState: () => void;
  };

  return {
    server,
    setWorkers(nextWorkers: unknown[]) {
      workers = nextWorkers;
    },
    addClient() {
      const client = {
        readyState: WebSocket.OPEN,
        send: vi.fn(),
      };
      server.clients.add(client);
      return client;
    },
    triggerRemoval() {
      removalHandler?.();
    },
    triggerUpdate(workerId: string, worker: unknown) {
      updateHandler?.(workerId, worker);
    },
  };
}

describe("WsServer pushState", () => {
  it("broadcasts workers only when the snapshot changes", () => {
    const harness = createServer([{ id: "w1", status: "idle" }]);
    const client = harness.addClient();

    harness.server.pushState();  // sends workers + models (first call)
    harness.server.pushState();  // no change — skips both
    harness.setWorkers([{ id: "w1", status: "working" }]);
    harness.server.pushState();  // sends workers (changed), skips models (same)

    // Filter to workers broadcasts only (pushState also sends models on first call)
    const workersCalls = (client.send.mock.calls as [string][])
      .map(([raw]) => JSON.parse(raw))
      .filter((msg: { type: string }) => msg.type === "workers");
    expect(workersCalls).toHaveLength(2);
    expect(workersCalls[0]).toEqual({
      type: "workers",
      workers: [{ id: "w1", status: "idle", machineLabel: "Rohits-Mac-mini.local" }],
    });
    expect(workersCalls[1]).toEqual({
      type: "workers",
      workers: [{ id: "w1", status: "working", machineLabel: "Rohits-Mac-mini.local" }],
    });
  });

  it("does not rebroadcast the same removal snapshot on the next tick", () => {
    const harness = createServer([{ id: "w1", status: "idle" }]);
    const client = harness.addClient();

    harness.triggerRemoval();
    harness.server.pushState();

    // triggerRemoval sends workers once, pushState skips workers (same snapshot)
    // but pushState sends models on first call (lastModelsSnapshot starts null)
    const workersCalls = (client.send.mock.calls as [string][])
      .map(([raw]) => JSON.parse(raw))
      .filter((msg: { type: string }) => msg.type === "workers");
    expect(workersCalls).toHaveLength(1);
    expect(workersCalls[0]).toEqual({
      type: "workers",
      workers: [{ id: "w1", status: "idle", machineLabel: "Rohits-Mac-mini.local" }],
    });
  });

  it("keeps immediate worker_update broadcasts unchanged", () => {
    const harness = createServer([{ id: "w1", status: "idle" }]);
    const client = harness.addClient();

    harness.triggerUpdate("w1", { id: "w1", status: "working" });

    expect(client.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(client.send.mock.calls[0]![0] as string)).toEqual({
      type: "worker_update",
      workerId: "w1",
      worker: { id: "w1", status: "working" },
    });
  });

  it("buffers satellite workers until satellite_hello arrives", () => {
    const harness = createServer([]);
    const client = harness.addClient();
    const server = harness.server as unknown as {
      handleSatelliteMessage: (ws: WebSocket, machineId: string, msg: Record<string, unknown>) => void;
      pushState: () => void;
    };
    const satelliteWs = {
      readyState: WebSocket.OPEN,
      send: vi.fn(),
    } as unknown as WebSocket;

    server.handleSatelliteMessage(satelliteWs, "remote-mac", {
      type: "satellite_workers",
      workers: [{ id: "rw1", status: "idle", model: "claude" }],
    });
    server.handleSatelliteMessage(satelliteWs, "remote-mac", {
      type: "satellite_hello",
      hostname: "Remote-Mac.local",
      version: "test",
    });
    server.pushState();

    const workersCalls = (client.send.mock.calls as [string][])
      .map(([raw]) => JSON.parse(raw))
      .filter((msg: { type: string }) => msg.type === "workers");
    expect(workersCalls).toHaveLength(1);
    expect(workersCalls[0]).toEqual({
      type: "workers",
      workers: [{
        id: "remote-mac:rw1",
        status: "working",
        model: "claude",
        machine: "remote-mac",
        machineLabel: "Remote-Mac.local",
        currentAction: "Thinking...",
        quadrant: 1,
      }],
    });
  });

  it("ignores close from a superseded satellite connection", () => {
    const harness = createServer([]);
    const client = harness.addClient();
    const server = harness.server as unknown as {
      registerSatelliteSocket: (ws: WebSocket, machineId: string) => void;
      handleSatelliteMessage: (ws: WebSocket, machineId: string, msg: Record<string, unknown>) => void;
      handleSatelliteDisconnect: (ws: WebSocket, machineId: string) => void;
      pushState: () => void;
    };
    const satelliteWs1 = {
      readyState: WebSocket.OPEN,
      send: vi.fn(),
      close: vi.fn(),
    } as unknown as WebSocket;
    const satelliteWs2 = {
      readyState: WebSocket.OPEN,
      send: vi.fn(),
      close: vi.fn(),
    } as unknown as WebSocket;

    server.registerSatelliteSocket(satelliteWs1, "remote-mac");
    server.handleSatelliteMessage(satelliteWs1, "remote-mac", {
      type: "satellite_hello",
      hostname: "Remote-Mac.local",
      version: "test",
    });
    server.handleSatelliteMessage(satelliteWs1, "remote-mac", {
      type: "satellite_workers",
      workers: [{ id: "rw1", status: "idle", model: "claude" }],
    });

    server.registerSatelliteSocket(satelliteWs2, "remote-mac");
    server.handleSatelliteMessage(satelliteWs2, "remote-mac", {
      type: "satellite_hello",
      hostname: "Remote-Mac.local",
      version: "test",
    });
    server.handleSatelliteMessage(satelliteWs2, "remote-mac", {
      type: "satellite_workers",
      workers: [{ id: "rw1", status: "idle", model: "claude" }],
    });

    expect(satelliteWs1.close).toHaveBeenCalledTimes(1);

    server.handleSatelliteDisconnect(satelliteWs1, "remote-mac");
    server.pushState();

    const workersCalls = (client.send.mock.calls as [string][])
      .map(([raw]) => JSON.parse(raw))
      .filter((msg: { type: string }) => msg.type === "workers");
    expect(workersCalls).toHaveLength(1);
    expect(workersCalls[0]).toEqual({
      type: "workers",
      workers: [{
        id: "remote-mac:rw1",
        status: "idle",
        model: "claude",
        machine: "remote-mac",
        machineLabel: "Remote-Mac.local",
        quadrant: 1,
      }],
    });
  });
});
