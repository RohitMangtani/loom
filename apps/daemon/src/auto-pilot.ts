import type { TelemetryReceiver } from "./telemetry.js";
import type { SessionStreamer } from "./session-stream.js";
import { sendInputToTty, sendSelectionToTty, isSendInFlight } from "./tty-input.js";
import { readTail } from "./utils.js";
import type { TerminalIO } from "./platform/interfaces.js";

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

// Grace period: how long to wait before auto-selecting.
// Gives the human time to see yellow and manually pick an option.
// If the user selects before this expires, auto-pilot never fires.
// 3s is the sweet spot: long enough to intervene from the dashboard,
// short enough that agents don't sit yellow for ages.
const GRACE_PERIOD_MS = 3_000;
const COOLDOWN_MS = 2_000;

export class AutoPilot {
  private telemetry: TelemetryReceiver;
  private streamer: SessionStreamer;
  private terminal: TerminalIO | null;
  private responded = new Set<string>();
  private lastAutoSend = new Map<string, number>();
  private firstSeen = new Map<string, number>();

  constructor(telemetry: TelemetryReceiver, streamer: SessionStreamer, terminal?: TerminalIO) {
    this.telemetry = telemetry;
    this.streamer = streamer;
    this.terminal = terminal || null;
  }

  tick(): void {
    const now = Date.now();

    for (const worker of this.telemetry.getAll()) {
      if (!worker.tty) continue;
      if (worker.status !== "stuck") continue;

      // Skip watchdog escalations — these are meant for the human, not auto-pilot
      if (worker.stuckMessage && worker.stuckMessage.startsWith("[watchdog]")) continue;

      // Cooldown: max one auto-send per COOLDOWN_MS per worker
      const lastSend = this.lastAutoSend.get(worker.id) || 0;
      if (now - lastSend < COOLDOWN_MS) continue;

      // Skip while another TTY send is in progress  --  sync auto-pilot sends
      // would race with async message/approval sends for Terminal focus.
      if (this.terminal ? this.terminal.isSendInFlight() : isSendInFlight()) continue;

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
      // Check both currentAction AND stuckMessage  --  discovery may clear currentAction
      // before auto-pilot fires, but stuckMessage persists while status is "stuck".
      const action = (worker.currentAction || "").toLowerCase();
      const hasNumberedOptions = !!(worker.stuckMessage && /\n\d\.\s/.test(worker.stuckMessage));
      const isSelectionPrompt = action.includes("question") ||
        action.includes("asking") ||
        action.includes("enterplanmode") ||
        action.includes("exitplanmode") ||
        action.includes("plan mode") ||
        action.includes("approval") ||
        hasNumberedOptions;
      const result = isSelectionPrompt
        ? (this.terminal
            ? this.terminal.sendSelection(worker.tty, parseInt(response.text, 10) - 1 || 0)
            : sendSelectionToTty(worker.tty, parseInt(response.text, 10) - 1 || 0))
        : (this.terminal
            ? this.terminal.sendText(worker.tty, response.text, worker.model)
            : sendInputToTty(worker.tty, response.text));
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

        console.log(`[auto-pilot] ${worker.tty}: sent "${response.text}"  --  ${response.reason} (waited ${Math.round(waitedMs / 1000)}s)`);
      } else {
        // Failed to send  --  don't mark as responded, let it retry next tick
        this.lastAutoSend.set(worker.id, now); // cooldown before retry
        console.log(`[auto-pilot] ${worker.tty}: FAILED to send "${response.text}"  --  ${result.error} (will retry)`);
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
   * Shared picker: given normalized options, apply priority logic.
   * Priority 1: "(Recommended)" → Priority 2: Affirmative keyword → Priority 3: First option.
   */
  private pickBestOption(
    options: Array<{ num: string; label: string }>
  ): { text: string; reason: string } | null {
    if (options.length === 0) return null;

    for (const opt of options) {
      if (/recommended/i.test(opt.label)) {
        return { text: opt.num, reason: `picked recommended "${opt.label}"` };
      }
    }

    const affirmative = /\b(yes|approve|proceed|allow|accept|continue|confirm|ok|sure|go ahead)\b/i;
    for (const opt of options) {
      if (affirmative.test(opt.label)) {
        return { text: opt.num, reason: `picked "${opt.label}"` };
      }
    }

    return { text: options[0].num, reason: `picked first option "${options[0].label}"` };
  }

  /**
   * Choose the best response for a stuck agent.
   * Delegates numbered-option picking to pickBestOption().
   * Keeps text-specific early exits (permission prompts, y/n, etc.).
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

      const pick = this.pickBestOption(parsed);
      if (pick) return pick;
    }

    // y/n style prompts → always yes
    if (msg.match(/\b(y\/n|yes\/no)\b/i) || msg.match(/\?\s*$/)) {
      return { text: "y", reason: "answered yes" };
    }

    // "Do you want to..." / "Should I..." / "Would you like..." in message
    if (msg.match(/\b(do you want|should i|would you like|shall i)\b/i)) {
      return { text: "y", reason: "answered yes" };
    }

    // Fallback  --  "1" works for most prompts
    return { text: "1", reason: "default response" };
  }

  /**
   * JSONL-based detection for AskUserQuestion prompts that hooks might miss
   * (e.g. if hook delivery was delayed or the worker just became stuck).
   */
  private checkJsonlPrompts(now: number): void {
    for (const worker of this.telemetry.getAll()) {
      if (!worker.tty) continue;
      // Never wake idle agents  --  only scan stuck workers for unanswered prompts
      if (worker.status === "idle") continue;

      const lastSend = this.lastAutoSend.get(worker.id) || 0;
      if (now - lastSend < COOLDOWN_MS) continue;
      if (this.terminal ? this.terminal.isSendInFlight() : isSendInFlight()) continue;

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
        ? (this.terminal
            ? this.terminal.sendSelection(worker.tty, parseInt(prompt.response, 10) - 1 || 0)
            : sendSelectionToTty(worker.tty, parseInt(prompt.response, 10) - 1 || 0))
        : (this.terminal
            ? this.terminal.sendText(worker.tty, prompt.response, worker.model)
            : sendInputToTty(worker.tty, prompt.response));
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

        console.log(`[auto-pilot] ${worker.tty}: sent "${prompt.response}" via ${prompt.isSelection ? "selection" : "text"}  --  ${prompt.reason} (JSONL, waited ${Math.round(waitedMs / 1000)}s)`);
      } else {
        // Failed  --  don't mark as responded, retry next tick after cooldown
        this.lastAutoSend.set(worker.id, now);
        console.log(`[auto-pilot] ${worker.tty}: FAILED JSONL send "${prompt.response}"  --  ${result.error} (will retry)`);
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
    try {
      const parsed = JSON.parse(line);
      const content = parsed?.message?.content || [];
      for (const c of content) {
        if (c?.name === "AskUserQuestion" && c?.input?.questions) {
          const q = c.input.questions[0];
          const opts = q?.options || [];
          const normalized = opts.map((o: { label?: string }, i: number) => ({
            num: String(i + 1),
            label: o.label || "",
          }));
          const pick = this.pickBestOption(normalized);
          if (pick) return { response: pick.text, reason: pick.reason, toolUseId, isSelection };
          break;
        }
      }
    } catch { /* parse failed, default to "1" */ }

    return { response: "1", reason: "picked first option", toolUseId, isSelection };
  }

}
