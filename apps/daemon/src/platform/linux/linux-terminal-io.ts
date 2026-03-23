// Requires tmux to be installed

import { execFile, execFileSync } from "child_process";
import { promisify } from "util";
import type { TerminalIO } from "../interfaces.js";

const execFileAsync = promisify(execFile);
const TMUX_SESSION = "hive";

function normalizeTty(tty: string): string {
  return tty.replace(/^\/dev\//, "");
}

async function resolveTmuxTarget(tty: string): Promise<string | null> {
  const normalized = normalizeTty(tty);
  try {
    const { stdout } = await execFileAsync("tmux", [
      "list-panes",
      "-a",
      "-F",
      "#{session_name}\t#{window_index}\t#{pane_tty}",
    ], {
      encoding: "utf-8",
      timeout: 5000,
    });

    for (const line of (stdout as string).split("\n")) {
      const [sessionName, windowIndex, paneTty] = line.trim().split("\t");
      if (sessionName !== TMUX_SESSION) continue;
      if (!windowIndex || !paneTty) continue;
      if (normalizeTty(paneTty) === normalized) {
        return `${TMUX_SESSION}:${windowIndex}`;
      }
    }
    return null;
  } catch {
    return null;
  }
}

export class LinuxTerminalIO implements TerminalIO {
  private sendInFlight = false;
  private sendMutex: Promise<void> = Promise.resolve();

  private runSerialized(task: () => Promise<{ ok: boolean; error?: string }>): Promise<{ ok: boolean; error?: string }> {
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

  async sendText(tty: string, text: string): Promise<{ ok: boolean; error?: string }> {
    const cleaned = text.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
    if (!cleaned) return { ok: false, error: "Empty message" };

    return this.runSerialized(async () => {
      const target = await resolveTmuxTarget(tty);
      if (!target) return { ok: false, error: `TTY not found in tmux: ${tty}` };

      try {
        await execFileAsync("tmux", ["send-keys", "-t", target, "-l", cleaned], {
          encoding: "utf-8",
          timeout: 5000,
        });
        await execFileAsync("tmux", ["send-keys", "-t", target, "Enter"], {
          encoding: "utf-8",
          timeout: 5000,
        });
        return { ok: true };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: `tmux send failed: ${msg.slice(0, 180)}` };
      }
    });
  }

  async sendKeystroke(tty: string, key: "enter" | "down" | "up"): Promise<{ ok: boolean; error?: string }> {
    const tmuxKey = key === "enter" ? "Enter" : key === "down" ? "Down" : "Up";
    return this.runSerialized(async () => {
      const target = await resolveTmuxTarget(tty);
      if (!target) return { ok: false, error: `TTY not found in tmux: ${tty}` };

      try {
        await execFileAsync("tmux", ["send-keys", "-t", target, tmuxKey], {
          encoding: "utf-8",
          timeout: 5000,
        });
        return { ok: true };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: `tmux keystroke failed: ${msg.slice(0, 180)}` };
      }
    });
  }

  async sendSelection(tty: string, optionIndex: number): Promise<{ ok: boolean; error?: string }> {
    const count = Math.max(0, optionIndex);
    return this.runSerialized(async () => {
      const target = await resolveTmuxTarget(tty);
      if (!target) return { ok: false, error: `TTY not found in tmux: ${tty}` };

      try {
        if (count > 0) {
          const downKeys = Array.from({ length: count }, () => "Down");
          await execFileAsync("tmux", ["send-keys", "-t", target, ...downKeys], {
            encoding: "utf-8",
            timeout: 5000,
          });
        }
        await execFileAsync("tmux", ["send-keys", "-t", target, "Enter"], {
          encoding: "utf-8",
          timeout: 5000,
        });
        return { ok: true };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: `tmux selection failed: ${msg.slice(0, 180)}` };
      }
    });
  }

  readContent(tty: string): string | null {
    const normalized = normalizeTty(tty);
    try {
      const stdout = execFileSync("tmux", [
        "list-panes",
        "-a",
        "-F",
        "#{session_name}\t#{window_index}\t#{pane_tty}",
      ], {
        encoding: "utf-8",
        timeout: 5000,
      }) as string;
      for (const line of stdout.split("\n")) {
        const [sessionName, windowIndex, paneTty] = line.trim().split("\t");
        if (sessionName !== TMUX_SESSION) continue;
        if (!windowIndex || !paneTty) continue;
        if (normalizeTty(paneTty) !== normalized) continue;
        const capture = execFileSync("tmux", ["capture-pane", "-t", `${TMUX_SESSION}:${windowIndex}`, "-p"], {
          encoding: "utf-8",
          timeout: 5000,
        }) as string;
        return capture.trim() || null;
      }
      return null;
    } catch {
      return null;
    }
  }

  isSendInFlight(): boolean {
    return this.sendInFlight;
  }
}
