/**
 * Windows window manager.
 *
 * Spawns agents in new terminal windows using Windows Terminal (wt.exe)
 * if available, otherwise falls back to cmd.exe /start.
 *
 * Key difference from macOS/Linux: wt.exe and cmd /start exit immediately
 * after opening a new tab/window. We return without a tty key and let
 * discovery pick up the new agent on the next 3s scan. The spawn placeholder
 * in satellite.ts handles the gap.
 */

import { execFileSync, execSync } from "child_process";
import { homedir } from "os";
import { join } from "path";
import { readFileSync } from "fs";
import type { WindowManager, WindowSlot } from "../interfaces.js";

const HOME = process.env.USERPROFILE || process.env.HOME || homedir();

function hasWindowsTerminal(): boolean {
  try {
    execFileSync("where", ["wt.exe"], { encoding: "utf-8", timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

function resolveSpawnCommand(model: string, initialMessage?: string): string {
  let cliCmd: string;
  if (model === "claude") cliCmd = "claude";
  else if (model === "codex") cliCmd = "codex";
  else if (model === "openclaw") cliCmd = "openclaw tui";
  else if (model === "gemini") cliCmd = "gemini";
  else {
    try {
      const raw = readFileSync(join(HOME, ".hive", "agents.json"), "utf-8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const custom = parsed.find((entry: Record<string, unknown>) => entry.id === model);
        if (typeof custom?.spawnCommand === "string" && custom.spawnCommand.trim()) {
          cliCmd = custom.spawnCommand;
        } else {
          cliCmd = model;
        }
      } else {
        cliCmd = model;
      }
    } catch {
      cliCmd = model;
    }
  }

  if (initialMessage && model === "claude") {
    const escaped = initialMessage.replace(/"/g, '\\"');
    cliCmd += ` "${escaped}"`;
  }

  return cliCmd;
}

const useWT = hasWindowsTerminal();

export class WindowsWindowManager implements WindowManager {
  spawnTerminal(
    project: string,
    model: string,
    _quadrant?: number,
    initialMessage?: string,
    _currentAgentCount?: number,
  ): { ok: boolean; tty?: string; error?: string } {
    const spawnCommand = resolveSpawnCommand(model, initialMessage);

    try {
      if (useWT) {
        // Windows Terminal: spawn a new tab
        // wt.exe exits immediately -- discovery picks up the agent on the next scan
        execSync(
          `start "" wt.exe new-tab --title "Hive - ${model}" -d "${project}" cmd /k ${spawnCommand}`,
          { timeout: 10000, windowsHide: true },
        );
      } else {
        // Fallback: start a new cmd window
        execSync(
          `start "Hive - ${model}" cmd /k "cd /d "${project}" && ${spawnCommand}"`,
          { timeout: 10000, windowsHide: true },
        );
      }

      // Don't try to find the PID here -- wt.exe and cmd /start create a
      // process tree (wt.exe -> cmd.exe -> conhost.exe -> node.exe) and
      // searching for "claude" matches multiple PIDs in the tree, causing
      // phantom workers. Let discovery handle it on the next 3s scan.
      // Return without a tty so satellite.ts skips the placeholder.
      return { ok: true };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `Spawn failed: ${msg.slice(0, 150)}` };
    }
  }

  closeTerminal(tty: string): { ok: boolean; error?: string } {
    const match = tty.match(/^pid:(\d+)$/);
    if (!match) return { ok: false, error: `Invalid tty: ${tty}` };

    const pid = match[1];

    try {
      // /T kills the entire process tree (cmd.exe + child agent)
      execFileSync("taskkill", ["/PID", pid, "/T", "/F"], {
        encoding: "utf-8",
        timeout: 5000,
      });
      return { ok: true };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // Process may already be gone
      if (msg.includes("not found")) return { ok: true };
      return { ok: false, error: `Close failed: ${msg.slice(0, 150)}` };
    }
  }

  arrangeWindows(_slots: WindowSlot[], _totalAgentCount?: number): void {
    // Window arrangement on Windows is best-effort.
    // Windows Terminal tabs are managed by the user.
  }
}
