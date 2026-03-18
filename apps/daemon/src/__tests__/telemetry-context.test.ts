import { beforeEach, describe, expect, it, vi } from "vitest";
import { TelemetryReceiver } from "../telemetry.js";

const { writeFileSync } = vi.hoisted(() => ({
  writeFileSync: vi.fn(),
}));
const { sendInputToTty } = vi.hoisted(() => ({
  sendInputToTty: vi.fn(() => ({ ok: true })),
}));

vi.mock("fs", () => ({
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  appendFileSync: vi.fn(),
  readFileSync: vi.fn(() => "{}"),
  writeFileSync,
  readdirSync: vi.fn(() => []),
  statSync: vi.fn(() => ({ mtimeMs: Date.now() })),
}));

vi.mock("../tty-input.js", () => ({
  sendInputToTty,
}));

describe("TelemetryReceiver worker context", () => {
  let telemetry: TelemetryReceiver;

  beforeEach(() => {
    writeFileSync.mockClear();
    sendInputToTty.mockClear();

    telemetry = new TelemetryReceiver(3001, "token");
    telemetry.setStreamer({
      getSessionFile: () => null,
      setSessionFile: () => {},
      readHistory: (workerId) => {
        if (workerId !== "w_sender") return [];
        return [
          { role: "user", text: "Plan the daemon audit" },
          { role: "agent", text: "I am checking the queue and routing flow now." },
        ];
      },
    });

    telemetry.registerDiscovered("w_sender", {
      id: "w_sender",
      pid: 101,
      project: "/Users/rmgtni/factory/projects/hive",
      projectName: "hive",
      status: "idle",
      currentAction: null,
      lastAction: "Finished audit",
      lastActionAt: Date.now(),
      errorCount: 0,
      startedAt: 1,
      task: null,
      managed: false,
      tty: "ttys000",
      model: "claude",
      quadrant: 1,
      lastDirection: "Compare the article against the daemon behavior",
    });

    telemetry.registerDiscovered("w_target", {
      id: "w_target",
      pid: 202,
      project: "/Users/rmgtni/factory/projects/hive",
      projectName: "hive",
      status: "idle",
      currentAction: null,
      lastAction: "Waiting",
      lastActionAt: Date.now(),
      errorCount: 0,
      startedAt: 2,
      task: null,
      managed: false,
      tty: "ttys003",
      model: "codex",
      quadrant: 3,
    });

    telemetry.recordArtifact("w_sender", "/Users/rmgtni/factory/projects/hive/apps/daemon/src/telemetry.ts", "edited");
  });

  it("builds worker context snapshots with recent artifacts and history", () => {
    const context = telemetry.getWorkerContext("w_sender", { historyLimit: 2 });

    expect(context?.workerId).toBe("w_sender");
    expect(context?.recentArtifacts).toHaveLength(1);
    expect(context?.recentMessages).toHaveLength(2);
    expect(context?.contextSummary).toContain("Recent files");
    expect(context?.contextSummary).toContain("Plan the daemon audit");
  });

  it("composes direct messages with sender context", () => {
    const message = telemetry.composeMessageWithContext("w_target", "Summarize what Q1 found", {
      fromWorkerId: "w_sender",
    });

    expect(message).toContain("Summarize what Q1 found");
    expect(message).toContain("## Hive Peer Context");
    expect(message).toContain("Q1 (ttys000, claude)");
  });

  it("writes workers and contexts files for no-network terminals", () => {
    telemetry.writeWorkersFile();

    const writes = writeFileSync.mock.calls.map(([path, data]) => ({
      path: String(path),
      json: JSON.parse(String(data)),
    }));

    expect(writes.find((entry) => entry.path.endsWith("workers.json"))?.json.workers[0].contextSummary)
      .toContain("Q1 (ttys000, claude)");
    expect(writes.find((entry) => entry.path.endsWith("contexts.json"))?.json.workers).toHaveLength(2);
  });

  it("stages long tty prompts into a context bundle instead of typing them inline", () => {
    const result = telemetry.sendToWorker("w_target", "x".repeat(500), {
      source: "test",
      contextWorkerIds: ["w_sender"],
    });

    expect(result).toEqual({ ok: true });
    expect(sendInputToTty).toHaveBeenCalledTimes(1);
    expect(sendInputToTty.mock.calls[0][1]).toContain("context-messages/msg-");
    expect(sendInputToTty.mock.calls[0][1]).toContain("Read ");
    expect(writeFileSync.mock.calls.some(([path]) => String(path).includes("context-messages/msg-"))).toBe(true);
  });
});
