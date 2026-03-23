// Requires tmux to be installed

import { execFile, execFileSync } from "child_process";
import { promisify } from "util";
import type { PlatformSendResult, TerminalIO } from "../interfaces.js";

const execFileAsync = promisify(execFile);
const TMUX_SESSION = "hive";
const PANE_FORMAT = "#{session_name}\t#{pane_id}\t#{pane_tty}";

function normalizeTty(tty: string): string {
  return tty.replace(/^\/dev\//, "");
}

function listPanesSync(): Array<{ paneId: string; paneTty: string }> {
  try {
    const stdout = execFileSync("tmux", ["list-panes", "-a", "-F", PANE_FORMAT], {
      encoding: "utf-8",
      timeout: 5000,
    }) as string;
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.split("\t"))
      .filter((parts) => parts[0] === TMUX_SESSION && parts[1] && parts[2])
      .map((parts) => ({
        paneId: parts[1],
        paneTty: normalizeTty(parts[2]),
      }));
  } catch {
    return [];
  }
}

async function listPanesAsync(): Promise<Array<{ paneId: string; paneTty: string }>> {
  try {
    const { stdout } = await execFileAsync("tmux", ["list-panes", "-a", "-F", PANE_FORMAT], {
      encoding: "utf-8",
      timeout: 5000,
    });
    return String(stdout)
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.split("\t"))
      .filter((parts) => parts[0] === TMUX_SESSION && parts[1] && parts[2])
      .map((parts) => ({
        paneId: parts[1],
        paneTty: normalizeTty(parts[2]),
      }));
  } catch {
    return [];
  }
}

function resolvePaneIdSync(tty: string): string | null {
  const normalized = normalizeTty(tty);
  const pane = listPanesSync().find((entry) => entry.paneTty === normalized);
  return pane?.paneId || null;
}

async function resolvePaneIdAsync(tty: string): Promise<string | null> {
  const normalized = normalizeTty(tty);
  const pane = (await listPanesAsync()).find((entry) => entry.paneTty === normalized);
  return pane?.paneId || null;
}

function runTmuxSync(args: string[]): PlatformSendResult {
  try {
    execFileSync("tmux", args, {
      encoding: "utf-8",
      timeout: 5000,
    });
    return { ok: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg.slice(0, 180) };
  }
}

async function runTmuxAsync(args: string[]): Promise<PlatformSendResult> {
  try {
    await execFileAsync("tmux", args, {
      encoding: "utf-8",
      timeout: 5000,
    });
    return { ok: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg.slice(0, 180) };
  }
}

export class LinuxTerminalIO implements TerminalIO {
  private sendInFlight = false;
  private sendMutex: Promise<void> = Promise.resolve();

  private withSyncSend(task: () => PlatformSendResult): PlatformSendResult {
    this.sendInFlight = true;
    try {
      return task();
    } finally {
      this.sendInFlight = false;
    }
  }

  private runSerialized(task: () => Promise<PlatformSendResult>): Promise<PlatformSendResult> {
    const resultPromise = this.sendMutex.then(async () => {
      this.sendInFlight = true;
      try {
        return await task();
      } finally {
        this.sendInFlight = false;
      }
    });
    this.sendMutex = resultPromise.then(() => {}, () => {});
    return resultPromise;
  }

  sendText(tty: string, text: string): PlatformSendResult {
    const cleaned = text.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
    if (!cleaned) return { ok: false, error: "Empty message" };

    return this.withSyncSend(() => {
      const paneId = resolvePaneIdSync(tty);
      if (!paneId) return { ok: false, error: `TTY not found in tmux: ${tty}` };

      const typed = runTmuxSync(["send-keys", "-t", paneId, "-l", cleaned]);
      if (!typed.ok) return { ok: false, error: `tmux send failed: ${typed.error}` };
      const entered = runTmuxSync(["send-keys", "-t", paneId, "Enter"]);
      if (!entered.ok) return { ok: false, error: `tmux send failed: ${entered.error}` };
      return { ok: true };
    });
  }

  sendTextAsync(tty: string, text: string): Promise<PlatformSendResult> {
    const cleaned = text.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
    if (!cleaned) return Promise.resolve({ ok: false, error: "Empty message" });

    return this.runSerialized(async () => {
      const paneId = await resolvePaneIdAsync(tty);
      if (!paneId) return { ok: false, error: `TTY not found in tmux: ${tty}` };

      const typed = await runTmuxAsync(["send-keys", "-t", paneId, "-l", cleaned]);
      if (!typed.ok) return { ok: false, error: `tmux send failed: ${typed.error}` };
      const entered = await runTmuxAsync(["send-keys", "-t", paneId, "Enter"]);
      if (!entered.ok) return { ok: false, error: `tmux send failed: ${entered.error}` };
      return { ok: true };
    });
  }

  sendKeystroke(tty: string, key: "enter" | "down" | "up"): PlatformSendResult {
    const paneId = resolvePaneIdSync(tty);
    if (!paneId) return { ok: false, error: `TTY not found in tmux: ${tty}` };
    const tmuxKey = key === "enter" ? "Enter" : key === "down" ? "Down" : "Up";
    return this.withSyncSend(() => {
      const result = runTmuxSync(["send-keys", "-t", paneId, tmuxKey]);
      return result.ok
        ? result
        : { ok: false, error: `tmux keystroke failed: ${result.error}` };
    });
  }

  sendKeystrokeAsync(tty: string, key: "enter" | "down" | "up"): Promise<PlatformSendResult> {
    const tmuxKey = key === "enter" ? "Enter" : key === "down" ? "Down" : "Up";
    return this.runSerialized(async () => {
      const paneId = await resolvePaneIdAsync(tty);
      if (!paneId) return { ok: false, error: `TTY not found in tmux: ${tty}` };
      const result = await runTmuxAsync(["send-keys", "-t", paneId, tmuxKey]);
      return result.ok
        ? result
        : { ok: false, error: `tmux keystroke failed: ${result.error}` };
    });
  }

  sendSelection(tty: string, optionIndex: number): PlatformSendResult {
    const paneId = resolvePaneIdSync(tty);
    if (!paneId) return { ok: false, error: `TTY not found in tmux: ${tty}` };
    const count = Math.max(0, optionIndex);
    return this.withSyncSend(() => {
      if (count > 0) {
        const downKeys = Array.from({ length: count }, () => "Down");
        const downResult = runTmuxSync(["send-keys", "-t", paneId, ...downKeys]);
        if (!downResult.ok) {
          return { ok: false, error: `tmux selection failed: ${downResult.error}` };
        }
      }
      const enterResult = runTmuxSync(["send-keys", "-t", paneId, "Enter"]);
      return enterResult.ok
        ? enterResult
        : { ok: false, error: `tmux selection failed: ${enterResult.error}` };
    });
  }

  readContent(tty: string): string | null {
    const paneId = resolvePaneIdSync(tty);
    if (!paneId) return null;

    try {
      const capture = execFileSync("tmux", ["capture-pane", "-t", paneId, "-p"], {
        encoding: "utf-8",
        timeout: 5000,
      }) as string;
      return capture.trim() || null;
    } catch {
      return null;
    }
  }

  isSendInFlight(): boolean {
    return this.sendInFlight;
  }
}
