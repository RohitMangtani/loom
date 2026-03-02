import type { TelemetryReceiver } from "./telemetry.js";
import type { SessionStreamer } from "./session-stream.js";
import { sendInputToTty, sendSelectionToTty } from "./tty-input.js";
import { readTail } from "./utils.js";

/**
 * Auto-pilot: ensures agents NEVER stay stuck waiting for keyboard input.
 *
 * Brute-force autonomous: scans for ANY prompt, picks the most optimal
 * option (recommended > yes/proceed > first option). Never says no.
 *
 * Two layers of defense:
 * 1. PreToolUse command hook (auto-approve.sh) prevents permission prompts
 * 2. This auto-pilot catches everything else via stuck detection + JSONL scan
 *
 * Grace period: 3s so a human on the dashboard can intervene first.
 */

const GRACE_PERIOD_MS = 0;
const COOLDOWN_MS = 4_000;

export class AutoPilot {
  private telemetry: TelemetryReceiver;
  private streamer: SessionStreamer;
  private responded = new Set<string>();
  private lastAutoSend = new Map<string, number>();
  private firstSeen = new Map<string, number>();

  constructor(telemetry: TelemetryReceiver, streamer: SessionStreamer) {
    this.telemetry = telemetry;
    this.streamer = streamer;
  }

  tick(): void {
    const now = Date.now();

    for (const worker of this.telemetry.getAll()) {
      if (!worker.tty) continue;
      if (worker.status !== "stuck") continue;

      // Cooldown: max one auto-send per COOLDOWN_MS per worker
      const lastSend = this.lastAutoSend.get(worker.id) || 0;
      if (now - lastSend < COOLDOWN_MS) continue;

      // Unique key for this stuck instance (so we don't re-respond to the same prompt)
      const stuckKey = `${worker.id}_${worker.lastActionAt}`;

      if (this.responded.has(stuckKey)) continue;

      // Grace period: first time seeing this stuck state → start timer
      if (!this.firstSeen.has(stuckKey)) {
        this.firstSeen.set(stuckKey, now);
        continue;
      }

      const waitedMs = now - this.firstSeen.get(stuckKey)!;
      if (waitedMs < GRACE_PERIOD_MS) continue;

      // Grace period expired. Determine what to send.
      const response = this.chooseResponse(worker.currentAction, worker.stuckMessage);

      // AskUserQuestion/EnterPlanMode use ink's selection UI which ignores
      // `do script` text injection. Send arrow keys + Enter via System Events.
      const isSelectionPrompt = (worker.currentAction || "").includes("question") ||
        (worker.currentAction || "").includes("Asking") ||
        (worker.currentAction || "").includes("EnterPlanMode");
      const result = isSelectionPrompt
        ? sendSelectionToTty(worker.tty, parseInt(response.text, 10) - 1 || 0)
        : sendInputToTty(worker.tty, response.text);
      if (result.ok) {
        this.responded.add(stuckKey);
        this.firstSeen.delete(stuckKey);
        this.lastAutoSend.set(worker.id, now);

        worker.status = "working";
        worker.currentAction = "Thinking...";
        worker.lastAction = `Auto: ${response.reason}`;
        worker.lastActionAt = now;
        worker.stuckMessage = undefined;
        // Mark external input so discovery doesn't flip to idle before JSONL catches up
        this.telemetry.markInputSent(worker.id, "auto-pilot:stuck");
        this.telemetry.notifyExternal(worker);

        console.log(`[auto-pilot] ${worker.tty}: sent "${response.text}" — ${response.reason} (waited ${Math.round(waitedMs / 1000)}s)`);
      }
    }

    // Also check JSONL for AskUserQuestion that hooks might have missed
    this.checkJsonlPrompts(now);

    // Prune old entries
    if (this.responded.size > 500) {
      const arr = Array.from(this.responded);
      this.responded = new Set(arr.slice(arr.length - 200));
    }
    if (this.firstSeen.size > 100) {
      for (const [id, ts] of this.firstSeen) {
        if (now - ts > 300_000) this.firstSeen.delete(id);
      }
    }
  }

  /**
   * Choose the best response. Priority:
   * 1. "(Recommended)" option
   * 2. Affirmative option (yes/approve/proceed/allow/accept/continue/confirm)
   * 3. First numbered option
   * 4. "y" for y/n prompts
   * 5. "1" as universal fallback
   *
   * Never says no. Always picks the most optimal path forward.
   */
  private chooseResponse(
    currentAction: string | null,
    stuckMessage: string | undefined
  ): { text: string; reason: string } {
    const action = (currentAction || "").toLowerCase();
    const msg = stuckMessage || "";

    // Permission prompts → "1" (yes) immediately
    if (action.includes("allow") || action.includes("permission") ||
        action.includes("proceed") || action.includes("confirm") ||
        action.includes("do you want")) {
      return { text: "1", reason: "approved permission" };
    }

    // Parse numbered options from stuckMessage: "1. Option A\n2. Option B"
    const numbered = msg.match(/(?:^|\n)\s*(\d)[.)]\s+(.+)/gm);
    if (numbered && numbered.length >= 2) {
      const parsed = numbered.map(line => {
        const m = line.match(/(\d)[.)]\s+(.+)/);
        return m ? { num: m[1], label: m[2].trim() } : null;
      }).filter(Boolean) as { num: string; label: string }[];

      // Priority 1: "(Recommended)" option
      for (const opt of parsed) {
        if (opt.label.toLowerCase().includes("recommended")) {
          return { text: opt.num, reason: `picked recommended "${opt.label}"` };
        }
      }

      // Priority 2: Affirmative option
      const affirmative = /\b(yes|approve|proceed|allow|accept|continue|confirm|ok|sure|go ahead)\b/i;
      for (const opt of parsed) {
        if (affirmative.test(opt.label)) {
          return { text: opt.num, reason: `picked "${opt.label}"` };
        }
      }

      // Priority 3: First option (Claude convention puts best option first)
      return { text: parsed[0].num, reason: `picked first option "${parsed[0].label}"` };
    }

    // y/n style prompts → always yes
    if (msg.match(/\b(y\/n|yes\/no)\b/i) || msg.match(/\?\s*$/)) {
      return { text: "y", reason: "answered yes" };
    }

    // "Do you want to..." / "Should I..." / "Would you like..." in message
    if (msg.match(/\b(do you want|should i|would you like|shall i)\b/i)) {
      return { text: "y", reason: "answered yes" };
    }

    // Fallback — "1" works for most prompts
    return { text: "1", reason: "default response" };
  }

  /**
   * JSONL-based detection for AskUserQuestion prompts that hooks might miss
   * (e.g. if hook delivery was delayed or the worker just became stuck).
   */
  private checkJsonlPrompts(now: number): void {
    for (const worker of this.telemetry.getAll()) {
      if (!worker.tty) continue;
      // Never wake idle agents — only scan stuck workers for unanswered prompts
      if (worker.status === "idle") continue;

      const lastSend = this.lastAutoSend.get(worker.id) || 0;
      if (now - lastSend < COOLDOWN_MS) continue;

      const sessionFile = this.streamer.getSessionFile(worker.id);
      if (!sessionFile) continue;

      const prompt = this.detectUnansweredAsk(sessionFile);
      if (!prompt) continue;
      if (this.responded.has(prompt.toolUseId)) continue;

      if (!this.firstSeen.has(prompt.toolUseId)) {
        this.firstSeen.set(prompt.toolUseId, now);
        continue;
      }

      const waitedMs = now - this.firstSeen.get(prompt.toolUseId)!;
      if (waitedMs < GRACE_PERIOD_MS) continue;

      // Selection prompts (AskUserQuestion, EnterPlanMode, ExitPlanMode) use
      // ink's selection UI → need System Events keystrokes, not text injection.
      const result = prompt.isSelection
        ? sendSelectionToTty(worker.tty, parseInt(prompt.response, 10) - 1 || 0)
        : sendInputToTty(worker.tty, prompt.response);
      if (result.ok) {
        this.responded.add(prompt.toolUseId);
        this.firstSeen.delete(prompt.toolUseId);
        this.lastAutoSend.set(worker.id, now);

        worker.status = "working";
        worker.currentAction = "Thinking...";
        worker.lastAction = `Auto: ${prompt.reason}`;
        worker.lastActionAt = now;
        worker.stuckMessage = undefined;
        this.telemetry.markInputSent(worker.id, "auto-pilot:jsonl");
        this.telemetry.notifyExternal(worker);

        console.log(`[auto-pilot] ${worker.tty}: sent "${prompt.response}" via ${prompt.isSelection ? "selection" : "text"} — ${prompt.reason} (JSONL, waited ${Math.round(waitedMs / 1000)}s)`);
      }
    }
  }

  // Tools that block waiting for user input
  private static readonly BLOCKING_TOOLS = new Set([
    "AskUserQuestion",
    "EnterPlanMode",
    "ExitPlanMode",
  ]);

  /**
   * Detect unanswered blocking tool calls in JSONL tail.
   * Catches AskUserQuestion, EnterPlanMode, and any other tool that
   * blocks waiting for keyboard input.
   */
  private detectUnansweredAsk(filePath: string): {
    response: string;
    reason: string;
    toolUseId: string;
    isSelection: boolean;
  } | null {
    try {
      const tail = readTail(filePath, 15_000);
      const lines = tail.split("\n").filter(Boolean);

      for (let i = lines.length - 1; i >= Math.max(0, lines.length - 25); i--) {
        const line = lines[i];

        if (line.includes('"tool_result"')) return null;

        if ((line.includes('"type":"user"') || line.includes('"type": "user"'))
            && !line.includes('"tool_result"')) {
          return null;
        }

        if (line.includes('"tool_use"') && line.includes('"assistant"')) {
          const nameMatch = line.match(/"name"\s*:\s*"([^"]+)"/);
          const idMatch = line.match(/"id"\s*:\s*"(toolu_[^"]+)"/);

          if (nameMatch?.[1] && idMatch?.[1] && AutoPilot.BLOCKING_TOOLS.has(nameMatch[1])) {
            return this.buildBlockingResponse(nameMatch[1], idMatch[1], line);
          }
          return null;
        }
      }

      return null;
    } catch {
      return null;
    }
  }

  private buildBlockingResponse(
    toolName: string,
    toolUseId: string,
    line: string
  ): { response: string; reason: string; toolUseId: string; isSelection: boolean } {
    // All blocking tools use ink selection UIs
    const isSelection = true;

    // EnterPlanMode / ExitPlanMode → just approve (Enter = first option)
    if (toolName === "EnterPlanMode" || toolName === "ExitPlanMode") {
      return { response: "1", reason: `approved ${toolName}`, toolUseId, isSelection };
    }

    // AskUserQuestion → parse options and pick the best one
    let response = "1";
    let reason = "picked first option";

    try {
      const parsed = JSON.parse(line);
      const content = parsed?.message?.content || [];
      for (const c of content) {
        if (c?.name === "AskUserQuestion" && c?.input?.questions) {
          const q = c.input.questions[0];
          const opts = q?.options || [];

          // Priority 1: "(Recommended)" in any option
          for (let i = 0; i < opts.length; i++) {
            const label = (opts[i].label || "");
            if (label.includes("Recommended") || label.includes("recommended")) {
              response = String(i + 1);
              reason = `picked recommended "${label}"`;
              return { response, reason, toolUseId, isSelection };
            }
          }

          // Priority 2: Affirmative option
          const affirmative = /\b(yes|allow|accept|approve|proceed|continue|confirm|go ahead)\b/i;
          for (let i = 0; i < opts.length; i++) {
            if (affirmative.test(opts[i].label || "")) {
              response = String(i + 1);
              reason = `picked "${opts[i].label}"`;
              return { response, reason, toolUseId, isSelection };
            }
          }

          // Priority 3: First option (Claude puts best first by convention)
          if (opts[0]?.label) {
            reason = `picked first option "${opts[0].label}"`;
          }
          break;
        }
      }
    } catch { /* parse failed, default to "1" */ }

    return { response, reason, toolUseId, isSelection };
  }

}
