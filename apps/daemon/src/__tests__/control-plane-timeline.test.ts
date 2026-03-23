import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { buildControlPlaneTimeline } from "../control-plane-timeline.js";

describe("buildControlPlaneTimeline", () => {
  let tempHome: string | null = null;
  let prevHome: string | undefined;
  let prevHiveHome: string | undefined;

  afterEach(() => {
    if (prevHome == null) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevHiveHome == null) delete process.env.HIVE_HOME; else process.env.HIVE_HOME = prevHiveHome;
    if (tempHome) {
      rmSync(tempHome, { recursive: true, force: true });
      tempHome = null;
    }
  });

  it("merges audit, routed context, and completion history into one timeline", () => {
    tempHome = mkdtempSync(join(tmpdir(), "hive-timeline-"));
    const hiveDir = join(tempHome, ".hive");
    const collectorDir = join(hiveDir, "collector");
    mkdirSync(collectorDir, { recursive: true });

    prevHome = process.env.HOME;
    prevHiveHome = process.env.HIVE_HOME;
    process.env.HOME = tempHome;
    process.env.HIVE_HOME = tempHome;

    writeFileSync(join(hiveDir, "control-plane.log"), [
      JSON.stringify({
        ts: 1_777_000_000_100,
        type: "spawn",
        targetMachine: "local",
        cwd: "/tmp/demo",
        action: "codex",
        ok: true,
      }),
      JSON.stringify({
        ts: 1_777_000_000_200,
        type: "approval",
        targetMachine: "local",
        workerId: "w1",
        tty: "ttys007",
        action: "approve_prompt",
        ok: true,
      }),
    ].join("\n") + "\n");

    writeFileSync(join(collectorDir, "events.jsonl"), `${JSON.stringify({
      ts: 1_777_000_000_300,
      type: "tool_start",
      workerId: "w1",
      toolName: "Read",
      filePath: "/Users/test/.hive/context-messages/msg-123.md",
    })}\n`);

    writeFileSync(join(hiveDir, "quadrant-audit.log"), `${JSON.stringify({
      ts: "2026-03-23T03:00:00.500Z",
      workerId: "w1",
      tty: "ttys007",
      from: "working",
      to: "idle",
      reason: "JSONL tail high-confidence idle (codex)",
      context: { tailAction: "Session ended" },
    })}\n`);

    const timeline = buildControlPlaneTimeline({
      limit: 20,
      workers: [
        {
          id: "w1",
          pid: 1,
          project: "/tmp/demo",
          projectName: "demo",
          status: "idle",
          currentAction: null,
          lastAction: "Session ended",
          lastActionAt: 1_777_000_000_600,
          errorCount: 0,
          startedAt: 1_777_000_000_000,
          task: null,
          managed: false,
          tty: "ttys007",
          quadrant: 3,
          model: "codex",
          lastDirection: "Read /Users/test/.hive/context-messages/msg-123.md and follow it exactly.",
        },
      ],
      streamer: {
        getSessionFile: () => "/Users/test/.codex/sessions/run-123.jsonl",
      },
    });

    expect(timeline).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "spawn",
          summary: "Spawned codex in demo",
        }),
        expect.objectContaining({
          type: "approval",
          workerId: "w1",
        }),
        expect.objectContaining({
          type: "route",
          workerId: "w1",
          links: expect.arrayContaining([
            expect.objectContaining({ kind: "context", path: "/Users/test/.hive/context-messages/msg-123.md" }),
            expect.objectContaining({ kind: "output", path: "/Users/test/.codex/sessions/run-123.jsonl" }),
          ]),
        }),
        expect.objectContaining({
          type: "completion",
          workerId: "w1",
          workerLabel: "Q3",
        }),
      ]),
    );
  });
});
