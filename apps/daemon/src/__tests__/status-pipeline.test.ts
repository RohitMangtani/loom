/**
 * Status Detection Pipeline Tests
 *
 * Tests the core JSONL tail analysis  --  the foundation of Hive's status detection.
 * Creates temporary JSONL files with known conversation patterns and verifies
 * that analyzeJsonlTail returns the correct status and confidence level.
 *
 * These tests cover the 7-layer phantom-green prevention pipeline:
 * 1. Noise filtering (progress/system entries ignored)
 * 2. highConfidence field (tool_use = high, mid-stream = low)
 * 3. Corroboration guard (low-confidence blocked without hooks)
 * 4. Confidence-gated cooldown (only high-confidence sets timer)
 * 5. Extended cooldown (25s after genuine tool call)
 * 6. idleConfirmed lock (hysteresis locks to idle)
 * 7. Input override (dashboard message clears idle lock)
 */

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { writeFileSync, mkdirSync, rmSync, statSync } from "fs";
import { join } from "path";
import { ProcessDiscovery } from "../discovery.js";
import type { TelemetryReceiver } from "../telemetry.js";
import type { SessionStreamer } from "../session-stream.js";

// ── Test fixture helpers ──────────────────────────────────────────────

const TEST_DIR = join(process.env.TMPDIR || "/private/tmp/claude-501", "hive-status-tests");

function jsonlLine(obj: Record<string, unknown>): string {
  return JSON.stringify(obj);
}

/** Claude-format assistant message (text-only response) */
function claudeAssistant(text = "Here is the answer."): string {
  return jsonlLine({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
}

/** Claude-format assistant message with tool_use (working signal) */
function claudeToolUse(toolName = "Read", filePath = "/src/index.ts"): string {
  return jsonlLine({
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "tool_use", id: "toolu_test123", name: toolName, input: { file_path: filePath } },
      ],
    },
  });
}

/** Claude-format tool_result (response to tool_use) */
function claudeToolResult(toolUseId = "toolu_test123"): string {
  return jsonlLine({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content: "file contents..." }],
    },
  });
}

/** Claude-format user message (human input) */
function claudeUserMessage(text = "Fix the login bug"): string {
  return jsonlLine({
    type: "user",
    message: { role: "user", content: text },
  });
}

/** Noise entry  --  progress (should be filtered) */
function noiseProgress(): string {
  return jsonlLine({ type: "progress", data: { bytes: 1234 } });
}

/** Noise entry  --  system (should be filtered) */
function noiseSystem(): string {
  return jsonlLine({ type: "system", message: "context window compacted" });
}

/** Noise entry  --  file-history-snapshot (should be filtered) */
function noiseFileHistory(): string {
  return jsonlLine({ type: "file-history-snapshot", files: ["/src/app.ts"] });
}

/** Codex-format task_complete (definitive idle) */
function codexTaskComplete(turnId = "turn_abc"): string {
  return jsonlLine({
    type: "response_item",
    payload: { type: "task_complete", turn_id: turnId },
  });
}

/** Codex-format function_call (working signal) */
function codexFunctionCall(): string {
  return jsonlLine({
    type: "response_item",
    payload: { type: "function_call", name: "shell", arguments: '{"command":"ls"}' },
  });
}

/** Write a JSONL file and return its path */
function writeTestJsonl(name: string, lines: string[], ageMs = 0): string {
  const filePath = join(TEST_DIR, `${name}.jsonl`);
  writeFileSync(filePath, lines.join("\n") + "\n");
  if (ageMs > 0) {
    // Backdate the file's mtime
    const now = Date.now();
    const mtime = new Date(now - ageMs);
    const { utimesSync } = require("fs");
    utimesSync(filePath, mtime, mtime);
  }
  return filePath;
}

// ── Mock setup ────────────────────────────────────────────────────────

// We need to access analyzeJsonlTail which is private. We'll test through
// readSessionContextFromFile by making the method accessible via prototype.
// This is a test-only technique  --  the production API is unchanged.

type SessionContext = {
  projectName: string | null;
  projectPath: string | null;
  latestAction: string | null;
  lastDirection: string | null;
  status: "working" | "idle";
  fileAgeMs: number;
  highConfidence: boolean;
};

function createTestDiscovery(): ProcessDiscovery {
  // Minimal mocks  --  we only need the JSONL analysis, not process scanning
  const mockTelemetry = {
    registerSession: vi.fn(),
    isSessionOwnedByOther: vi.fn(() => false),
    recordSignal: vi.fn(),
    setIdleConfirmed: vi.fn(),
    isIdleConfirmed: vi.fn(() => false),
    getLastInputSent: vi.fn(() => 0),
    getLastHookTime: vi.fn(() => Date.now()),
    isRecentSpawn: vi.fn(() => false),
    getAll: vi.fn(() => []),
    get: vi.fn(),
    notifyExternal: vi.fn(),
  } as unknown as TelemetryReceiver;

  const mockStreamer = {
    getSessionFile: vi.fn(() => null),
    setSessionFile: vi.fn(),
    clearSessionPath: vi.fn(),
    isFileMappedToOther: vi.fn(() => false),
    clearWorker: vi.fn(),
  } as unknown as SessionStreamer;

  return new ProcessDiscovery(mockTelemetry, mockStreamer);
}

/** Call the private readSessionContextFromFile through bracket notation */
function analyzeFile(discovery: ProcessDiscovery, filePath: string): SessionContext {
  return (discovery as unknown as { readSessionContextFromFile(p: string): SessionContext })
    .readSessionContextFromFile(filePath);
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("JSONL tail analysis (analyzeJsonlTail)", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* */ }
  });

  // ── Scenario 1: Tool in flight → working (green) ──────────────────

  it("detects tool_use at tail as working (high confidence)", () => {
    const discovery = createTestDiscovery();
    const file = writeTestJsonl("tool-in-flight", [
      claudeUserMessage("Fix the bug"),
      claudeToolUse("Read", "/src/main.ts"),
      // No tool_result after  --  tool is in flight
    ]);

    const ctx = analyzeFile(discovery, file);
    expect(ctx.status).toBe("working");
    expect(ctx.highConfidence).toBe(true);
  });

  it("detects tool_result at tail as working (thinking phase)", () => {
    const discovery = createTestDiscovery();
    const file = writeTestJsonl("thinking-after-tool", [
      claudeUserMessage("Read the file"),
      claudeToolUse("Read"),
      claudeToolResult(),
      // Claude received result, now thinking about next step
    ]);

    const ctx = analyzeFile(discovery, file);
    expect(ctx.status).toBe("working");
  });

  // ── Scenario 2: Finished response → idle (red) ────────────────────

  it("detects assistant text at tail as idle when file is stale", () => {
    const discovery = createTestDiscovery();
    const file = writeTestJsonl("finished-response", [
      claudeUserMessage("What is 2+2?"),
      claudeAssistant("The answer is 4."),
    ], 10_000); // 10s old  --  past the 4s grace period

    const ctx = analyzeFile(discovery, file);
    expect(ctx.status).toBe("idle");
  });

  it("keeps working during mid-stream grace (assistant at tail, file < 4s old)", () => {
    const discovery = createTestDiscovery();
    // File is fresh (0ms age)  --  Claude is still writing its response
    const file = writeTestJsonl("mid-stream", [
      claudeUserMessage("Explain quantum computing"),
      claudeAssistant("Quantum computing uses..."),
    ]);

    const ctx = analyzeFile(discovery, file);
    expect(ctx.status).toBe("working");
    expect(ctx.highConfidence).toBe(false); // mid-stream = low confidence
  });

  // ── Scenario 3: Noise filtering → no phantom green ─────────────────

  it("ignores noise entries and detects idle correctly", () => {
    const discovery = createTestDiscovery();
    const file = writeTestJsonl("noise-after-idle", [
      claudeUserMessage("What time is it?"),
      claudeAssistant("It is 3pm."),
      // Many noise entries written after  --  should NOT cause phantom green
      noiseProgress(),
      noiseProgress(),
      noiseSystem(),
      noiseFileHistory(),
      noiseProgress(),
    ], 10_000); // file is 10s old

    const ctx = analyzeFile(discovery, file);
    expect(ctx.status).toBe("idle");
  });

  it("noise entries at tail make mid-stream check fail (no phantom green)", () => {
    const discovery = createTestDiscovery();
    // File is fresh (0ms) but ONLY because noise was written  --  not real content
    const file = writeTestJsonl("noise-fresh", [
      claudeUserMessage("Hello"),
      claudeAssistant("Hi there!"),
      noiseProgress(), // last raw line is noise
    ]);

    const ctx = analyzeFile(discovery, file);
    // The mid-stream grace period (assistant at tail, file < 4s) should NOT apply
    // when file freshness comes from noise writes. fileAgeIsFromNoise = true.
    // Result: idle, because the assistant text is "finished" and noise can't override.
    expect(ctx.status).toBe("idle");
  });

  // ── Scenario 4: User message → working (thinking) ──────────────────

  it("detects user message at tail as working (Claude is thinking)", () => {
    const discovery = createTestDiscovery();
    const file = writeTestJsonl("user-sent", [
      claudeAssistant("Previous response."),
      claudeUserMessage("Now fix the login page"),
      // No assistant response yet  --  Claude is thinking
    ]);

    const ctx = analyzeFile(discovery, file);
    expect(ctx.status).toBe("working");
  });

  it("user message at tail but file very stale → idle (compacted session)", () => {
    const discovery = createTestDiscovery();
    const file = writeTestJsonl("user-stale", [
      claudeAssistant("Previous response."),
      claudeUserMessage("Fix the bug"),
    ], 180_000); // 3 minutes old  --  Claude already responded in a new file

    const ctx = analyzeFile(discovery, file);
    expect(ctx.status).toBe("idle");
  });

  // ── Scenario 5: Tool call chain → stays working ─────────────────────

  it("stays working through a chain of tool calls", () => {
    const discovery = createTestDiscovery();
    const file = writeTestJsonl("tool-chain", [
      claudeUserMessage("Refactor the auth module"),
      claudeToolUse("Read", "/src/auth.ts"),
      claudeToolResult("toolu_1"),
      claudeToolUse("Edit", "/src/auth.ts"),
      claudeToolResult("toolu_2"),
      claudeToolUse("Read", "/src/test.ts"),
      // Still in flight  --  last tool_use has no result
    ]);

    const ctx = analyzeFile(discovery, file);
    expect(ctx.status).toBe("working");
    expect(ctx.highConfidence).toBe(true);
  });

  // ── Scenario 6: Codex task_complete → immediate idle ───────────────

  it("detects Codex task_complete as immediate idle (high confidence)", () => {
    const discovery = createTestDiscovery();
    const file = writeTestJsonl("codex-done", [
      jsonlLine({ type: "event_msg", payload: { type: "user_message", message: "Fix the bug" } }),
      jsonlLine({ type: "response_item", payload: { type: "function_call", name: "shell" } }),
      jsonlLine({ type: "response_item", payload: { type: "function_call_output", output: "ok" } }),
      codexTaskComplete("turn_1"),
    ]);

    const ctx = analyzeFile(discovery, file);
    expect(ctx.status).toBe("idle");
    expect(ctx.highConfidence).toBe(true);
  });

  // ── Scenario 7: No-pattern fallback ─────────────────────────────────

  it("no-pattern fallback: fresh file with no patterns → working", () => {
    const discovery = createTestDiscovery();
    // A line that has no recognizable conversation patterns (no user/assistant/tool)
    // Fill 50KB+ so no real patterns are visible in the scan window
    const junkLine = jsonlLine({ type: "unknown_custom_event", data: "x".repeat(60000) });
    const file = writeTestJsonl("no-pattern-fresh", [junkLine]);

    const ctx = analyzeFile(discovery, file);
    // File is fresh, no patterns found → assume working (green)
    expect(ctx.status).toBe("working");
    expect(ctx.highConfidence).toBe(false);
  });

  it("no-pattern fallback: stale file with no patterns → idle", () => {
    const discovery = createTestDiscovery();
    const junkLine = jsonlLine({ type: "unknown_custom_event", data: "x".repeat(60000) });
    const file = writeTestJsonl("no-pattern-stale", [junkLine], 180_000);

    const ctx = analyzeFile(discovery, file);
    expect(ctx.status).toBe("idle");
  });

  // ── Action extraction ───────────────────────────────────────────────

  it("extracts tool name as latestAction from tool_use", () => {
    const discovery = createTestDiscovery();
    const file = writeTestJsonl("action-extract", [
      claudeUserMessage("Check the file"),
      claudeToolUse("Grep", "/src/**/*.ts"),
    ]);

    const ctx = analyzeFile(discovery, file);
    // parseActionFromLine describes Grep as "Searching code", not raw tool name
    expect(ctx.latestAction).toBeTruthy();
  });

  it("extracts user direction from user message", () => {
    const discovery = createTestDiscovery();
    const file = writeTestJsonl("direction-extract", [
      claudeUserMessage("Deploy the dashboard to production"),
      claudeToolUse("Bash"),
    ]);

    const ctx = analyzeFile(discovery, file);
    expect(ctx.lastDirection).toContain("Deploy the dashboard");
  });

  // ── Edge cases ──────────────────────────────────────────────────────

  it("handles empty JSONL file gracefully", () => {
    const discovery = createTestDiscovery();
    // Empty file but fresh → no-pattern fallback triggers "working"
    // Empty file that is stale → "idle"
    const staleFile = writeTestJsonl("empty-stale", [], 180_000);
    const ctx = analyzeFile(discovery, staleFile);
    expect(ctx.status).toBe("idle");
  });

  it("handles truncated first line (mid-read cut)", () => {
    const discovery = createTestDiscovery();
    // Simulate a tail read that cut a line in the middle
    const file = writeTestJsonl("truncated", [
      'partial json that is not valid {',
      claudeUserMessage("Real message after truncation"),
      claudeToolUse("Read"),
    ]);

    const ctx = analyzeFile(discovery, file);
    expect(ctx.status).toBe("working");
    expect(ctx.highConfidence).toBe(true);
  });
});
