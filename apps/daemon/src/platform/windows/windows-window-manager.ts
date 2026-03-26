/**
 * Windows window manager.
 *
 * Spawns agents in new terminal windows using Windows Terminal (wt.exe)
 * if available, otherwise falls back to cmd.exe /start.
 *
 * Key difference from macOS/Linux: wt.exe and cmd /start exit immediately
 * after opening a new tab/window. The actual agent runs as a child of
 * conhost.exe or WindowsTerminal.exe, not our spawn call. We can't retain
 * stdin handles. Instead, we wait briefly and use process discovery to
 * find the new agent by its command-line pattern.
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

/**
 * Find the PID of a newly-spawned agent by scanning for its command pattern.
 * Tries up to 5 times with 500ms intervals to give the process time to start.
 */
function findNewAgentPid(model: string, beforePids: Set<number>): number | null {
  const patterns: Record<string, string> = {
    claude: "claude",
    codex: "codex",
    openclaw: "openclaw",
    gemini: "gemini",
  };
  const needle = patterns[model] || model;

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const raw = execFileSync("powershell", [
        "-NoProfile", "-Command",
        `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match '${needle}' } | Select-Object -ExpandProperty ProcessId`,
      ], { encoding: "utf-8", timeout: 5000 }).trim();

      for (const line of raw.split("\n")) {
        const pid = parseInt(line.trim(), 10);
        if (pid && !beforePids.has(pid) && pid !== process.pid) {
          return pid;
        }
      }
    } catch { /* retry */ }

    // Brief sync sleep between attempts — only during spawn, not on hot path
    execFileSync("powershell", ["-NoProfile", "-Command", "Start-Sleep -Milliseconds 500"], { timeout: 3000 });
  }

  return null;
}

/**
 * Snapshot current PIDs matching an agent pattern so we can diff after spawn.
 */
function snapshotAgentPids(model: string): Set<number> {
  const patterns: Record<string, string> = {
    claude: "claude",
    codex: "codex",
    openclaw: "openclaw",
    gemini: "gemini",
  };
  const needle = patterns[model] || model;
  const pids = new Set<number>();

  try {
    const raw = execFileSync("powershell", [
      "-NoProfile", "-Command",
      `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match '${needle}' } | Select-Object -ExpandProperty ProcessId`,
    ], { encoding: "utf-8", timeout: 5000 }).trim();

    for (const line of raw.split("\n")) {
      const pid = parseInt(line.trim(), 10);
      if (pid) pids.add(pid);
    }
  } catch { /* empty set is fine */ }

  return pids;
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
      // Snapshot existing agent PIDs so we can find the new one
      const beforePids = snapshotAgentPids(model);

      if (useWT) {
        // Windows Terminal: spawn a new tab
        // wt.exe exits immediately — we find the real PID after
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

      // Find the new agent process by diffing PIDs
      const newPid = findNewAgentPid(model, beforePids);
      if (newPid) {
        return { ok: true, tty: `pid:${newPid}` };
      }

      // Agent may not have started yet — return success without tty.
      // Discovery will pick it up on the next 3s scan.
      return { ok: true, tty: undefined };
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
