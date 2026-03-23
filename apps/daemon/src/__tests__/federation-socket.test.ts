import { EventEmitter } from "events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { FederationSocketClient, type FederationSocketLike } from "../federation-socket.js";

class FakeSocket extends EventEmitter implements FederationSocketLike {
  readyState = WebSocket.CONNECTING;
  readonly url: string;
  readonly send = vi.fn((data: string) => {
    this.sent.push(data);
  });
  readonly close = vi.fn(() => {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.emit("close");
  });
  readonly terminate = vi.fn(() => {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.emit("close");
  });
  readonly sent: string[] = [];

  constructor(url: string) {
    super();
    this.url = url;
  }

  open(): void {
    this.readyState = WebSocket.OPEN;
    this.emit("open");
  }

  pushMessage(payload: unknown): void {
    const raw = typeof payload === "string" ? payload : JSON.stringify(payload);
    this.emit("message", raw);
  }
}

function createHarness() {
  const sockets: FakeSocket[] = [];
  const save = vi.fn();
  const onOpen = vi.fn();
  const onMessage = vi.fn();
  const onDisconnect = vi.fn(() => "handled" as const);
  const onReconnectScheduled = vi.fn();
  const onHeartbeatTimeout = vi.fn();
  const onMalformedMessage = vi.fn();

  const client = new FederationSocketClient<{ type?: string }, { type: string }>({
    primaryUrl: "https://primary.example/hive",
    token: "secret token",
    satelliteId: "remote-mac",
    stableConnectionMs: 60_000,
    heartbeatIntervalMs: 1_000,
    heartbeatTimeoutMs: 2_500,
    socketFactory: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    urls: {
      load: () => ["wss://primary.example/hive", "wss://backup.example/hive"],
      save,
    },
    hooks: {
      onOpen,
      onMessage,
      onDisconnect,
      onReconnectScheduled,
      onHeartbeatTimeout,
      onMalformedMessage,
      isHeartbeatAck: (message) => message.type === "satellite_heartbeat_ack",
      makeHeartbeat: () => ({ type: "satellite_heartbeat" }),
    },
  });

  return {
    client,
    sockets,
    save,
    onOpen,
    onMessage,
    onDisconnect,
    onReconnectScheduled,
    onHeartbeatTimeout,
    onMalformedMessage,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("FederationSocketClient", () => {
  it("builds an authenticated websocket URL from the configured primary URL", () => {
    const harness = createHarness();

    harness.client.start();

    expect(harness.sockets).toHaveLength(1);
    expect(harness.sockets[0]!.url).toBe(
      "wss://primary.example/hive?token=secret%20token&satellite=remote-mac",
    );
  });

  it("sends heartbeat frames and swallows heartbeat acknowledgements", () => {
    vi.useFakeTimers();
    const harness = createHarness();

    harness.client.start();
    harness.sockets[0]!.open();

    vi.advanceTimersByTime(1_000);
    expect(harness.sockets[0]!.send).toHaveBeenCalledWith(JSON.stringify({ type: "satellite_heartbeat" }));

    harness.sockets[0]!.pushMessage({ type: "satellite_heartbeat_ack" });
    expect(harness.onMessage).not.toHaveBeenCalled();
  });

  it("rotates to the next primary URL after an unstable disconnect", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    harness.onDisconnect.mockReturnValue("reconnect");

    harness.client.start();
    harness.sockets[0]!.open();
    harness.sockets[0]!.close();
    await Promise.resolve();

    expect(harness.onReconnectScheduled).toHaveBeenCalledWith({
      nextUrl: "wss://backup.example/hive",
      delayMs: 1_000,
      rotatedUrl: true,
    });

    vi.advanceTimersByTime(1_000);
    expect(harness.sockets).toHaveLength(2);
    expect(harness.sockets[1]!.url).toBe(
      "wss://backup.example/hive?token=secret%20token&satellite=remote-mac",
    );
  });

  it("terminates stale sockets when heartbeat acknowledgements stop arriving", () => {
    vi.useFakeTimers();
    const harness = createHarness();

    harness.client.start();
    harness.sockets[0]!.open();
    vi.advanceTimersByTime(3_000);

    expect(harness.onHeartbeatTimeout).toHaveBeenCalledWith({
      url: "wss://primary.example/hive",
      silenceMs: 3_000,
    });
    expect(harness.sockets[0]!.terminate).toHaveBeenCalledTimes(1);
    expect(harness.onDisconnect).toHaveBeenCalledWith(expect.objectContaining({
      reason: "heartbeat-timeout",
      stable: false,
      url: "wss://primary.example/hive",
    }));
  });

  it.todo("verifies federation transport interoperates with the live ws-server heartbeat ack flow");
  it.todo("verifies reconnect resume after a failed satellite self-heal against a real daemon instance");
});
