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
      workers: [{ id: "w1", status: "idle" }],
    });
    expect(workersCalls[1]).toEqual({
      type: "workers",
      workers: [{ id: "w1", status: "working" }],
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
      workers: [{ id: "w1", status: "idle" }],
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
});
