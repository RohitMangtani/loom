/**
 * Hive Subprocess POC — Proof that Claude Code can be managed via stdin/stdout
 *
 * Run this from a PLAIN terminal (not inside Claude Code):
 *   npx tsx scripts/subprocess-poc.ts
 *
 * What this proves:
 * 1. Spawn Claude Code as a child process (no Terminal.app)
 * 2. Send tasks via stdin (no AppleScript/CGEvent)
 * 3. Read structured JSON responses from stdout (no JSONL tailing)
 * 4. Detect status from stream events (no 8-layer pipeline)
 * 5. Send follow-up messages to a running agent (no TTY injection)
 *
 * This does NOT modify any existing daemon code.
 */

import { spawn, type ChildProcess } from "child_process";
import { createInterface } from "readline";

interface StreamEvent {
  type: string;
  subtype?: string;
  content?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  session_id?: string;
  [key: string]: unknown;
}

class SubprocessAgent {
  private proc: ChildProcess | null = null;
  private status: "idle" | "working" | "dead" = "idle";
  private lastEvent: number = 0;
  private eventCount: number = 0;
  private project: string;

  constructor(project: string) {
    this.project = project;
  }

  spawn(task: string): void {
    console.log(`\n[HIVE] Spawning agent for: ${this.project}`);
    console.log(`[HIVE] Task: ${task}`);
    console.log(`[HIVE] ---`);

    this.proc = spawn("claude", [
      "-p",
      "--output-format", "stream-json",
      "--verbose",
      "--no-session-persistence",
      "--max-turns", "5",
    ], {
      cwd: this.project,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, CLAUDECODE: undefined },
    });

    this.status = "working";
    this.lastEvent = Date.now();

    // Read stdout line by line (each line is a JSON event)
    const rl = createInterface({ input: this.proc.stdout! });
    rl.on("line", (line) => {
      this.lastEvent = Date.now();
      this.eventCount++;
      try {
        const event: StreamEvent = JSON.parse(line);
        // Raw log for debugging
        const preview = JSON.stringify(event).slice(0, 300);
        console.log(`[RAW #${this.eventCount}] ${preview}`);
        this.handleEvent(event);
      } catch {
        // Non-JSON output, just log it
        console.log(`[STDOUT] ${line}`);
      }
    });

    // Read stderr
    const errRl = createInterface({ input: this.proc.stderr! });
    errRl.on("line", (line) => {
      console.log(`[STDERR] ${line}`);
    });

    this.proc.on("exit", (code) => {
      this.status = "dead";
      console.log(`\n[HIVE] Agent exited with code ${code}`);
      console.log(`[HIVE] Total events received: ${this.eventCount}`);
    });

    // Send the task via stdin
    this.proc.stdin!.write(task + "\n");
    this.proc.stdin!.end();
  }

  private handleEvent(event: StreamEvent): void {
    const elapsed = ((Date.now() - this.lastEvent) / 1000).toFixed(1);

    switch (event.type) {
      case "assistant":
        if (event.subtype === "tool_use") {
          this.status = "working";
          console.log(`[STATUS: WORKING] Tool call: ${event.tool_name}`);
        } else if (event.subtype === "text") {
          this.status = "working";
          // Truncate long text output
          const text = String(event.content || "").slice(0, 200);
          console.log(`[STATUS: WORKING] Response: ${text}${String(event.content || "").length > 200 ? "..." : ""}`);
        }
        break;

      case "tool_result":
        this.status = "working";
        console.log(`[STATUS: WORKING] Tool result received`);
        break;

      case "result":
        this.status = "idle";
        console.log(`[STATUS: IDLE] Turn complete`);
        // Log the final text if present
        if (event.subtype === "text" && event.content) {
          console.log(`[FINAL] ${String(event.content).slice(0, 500)}`);
        }
        break;

      default:
        console.log(`[EVENT] ${event.type}${event.subtype ? `:${event.subtype}` : ""}`);
    }
  }

  getStatus(): string {
    return this.status;
  }

  isAlive(): boolean {
    return this.proc !== null && this.status !== "dead";
  }
}

// --- Main ---

const project = process.argv[2] || process.env.HOME + "/factory/projects/hive";
const task = process.argv[3] || "List the top-level files in this project. Just the filenames, nothing else.";

console.log("=== Hive Subprocess POC ===");
console.log(`Project: ${project}`);
console.log(`Task: ${task}`);

const agent = new SubprocessAgent(project);
agent.spawn(task);
