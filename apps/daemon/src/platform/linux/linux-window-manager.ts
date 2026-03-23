// Requires tmux to be installed

import { execFile, execFileSync } from "child_process";
import { homedir } from "os";
import { join } from "path";
import { promisify } from "util";
import type { WindowManager } from "../interfaces.js";

const execFileAsync = promisify(execFile);
const TMUX_SESSION = "hive";
const HOME = process.env.HOME || homedir();

function resolveSpawnCommand(model: string): string {
  if (model === "claude") return "claude";
  if (model === "codex") return "codex";
  if (model === "openclaw") return "openclaw tui";
  if (model === "gemini") return "gemini";

  try {
    const { readFileSync } = require("fs") as typeof import("fs");
    const raw = readFileSync(join(HOME, ".hive", "agents.json"), "utf-8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const custom = parsed.find((entry: Record<string, unknown>) => entry.id === model);
      if (typeof custom?.spawnCommand === "string" && custom.spawnCommand.trim()) {
        return custom.spawnCommand;
      }
    }
  } catch {
    // Fall back to the model string.
  }

  return model;
}

async function resolveWindowTargetForTty(tty: string): Promise<string | null> {
  const normalized = tty.replace(/^\/dev\//, "");
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
      if (paneTty.replace(/^\/dev\//, "") === normalized) {
        return `${TMUX_SESSION}:${windowIndex}`;
      }
    }
    return null;
  } catch {
    return null;
  }
}

export class LinuxWindowManager implements WindowManager {
  async spawnTerminal(project: string, model: string, quadrant?: number): Promise<string> {
    const windowName = `Q${quadrant ?? await this.getNextWindowLabel()}`;
    const spawnCommand = resolveSpawnCommand(model);

    try {
      execFileSync("tmux", ["has-session", "-t", TMUX_SESSION], {
        encoding: "utf-8",
        timeout: 3000,
      });
    } catch {
      const tty = execFileSync("tmux", [
        "new-session",
        "-d",
        "-P",
        "-F",
        "#{pane_tty}",
        "-s",
        TMUX_SESSION,
        "-n",
        windowName,
        "-c",
        project,
        spawnCommand,
      ], {
        encoding: "utf-8",
        timeout: 10000,
      }).trim();
      return tty.replace(/^\/dev\//, "");
    }

    const tty = execFileSync("tmux", [
      "new-window",
      "-P",
      "-F",
      "#{pane_tty}",
      "-t",
      TMUX_SESSION,
      "-n",
      windowName,
      "-c",
      project,
      spawnCommand,
    ], {
      encoding: "utf-8",
      timeout: 10000,
    }).trim();

    return tty.replace(/^\/dev\//, "");
  }

  async closeTerminal(tty: string): Promise<void> {
    const target = await resolveWindowTargetForTty(tty);
    if (!target) return;

    try {
      await execFileAsync("tmux", ["kill-window", "-t", target], {
        encoding: "utf-8",
        timeout: 5000,
      });
    } catch {
      // Best effort — window may already be gone.
    }
  }

  arrangeWindows(_slots: Array<{ tty: string; quadrant: number; projectName: string; model: string }>): void {
    try {
      execFile("tmux", ["select-layout", "-t", TMUX_SESSION, "tiled"], {
        encoding: "utf-8",
        timeout: 5000,
      }, () => {
        // Layout changes are best effort.
      });
    } catch {
      // Session may not exist yet.
    }
  }

  private async getNextWindowLabel(): Promise<number> {
    try {
      const { stdout } = await execFileAsync("tmux", ["list-windows", "-t", TMUX_SESSION, "-F", "#{window_name}"], {
        encoding: "utf-8",
        timeout: 3000,
      });
      const seen = new Set(
        (stdout as string)
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean),
      );
      let candidate = 1;
      while (seen.has(`Q${candidate}`)) candidate += 1;
      return candidate;
    } catch {
      return 1;
    }
  }
}
