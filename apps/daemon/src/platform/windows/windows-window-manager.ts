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

let lastArrangement = "";

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
  if (model === "claude") cliCmd = "claude --enable-auto-mode";
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

  arrangeWindows(slots: WindowSlot[], totalAgentCount?: number): void {
    // Arrange windows in a grid matching the quadrant system.
    // Uses PowerShell + Win32 SetWindowPos to position each agent's terminal window.
    //
    // Note: If agents run as tabs inside a single Windows Terminal (wt.exe) instance,
    // only the WT window itself can be positioned — individual tabs cannot be placed
    // in separate screen regions. In that case, this positions the WT window to fill
    // the screen. When agents run in separate windows (cmd.exe), each gets its own
    // quadrant.

    const desired = slots.filter((slot) => !!slot.tty).sort((a, b) => a.quadrant - b.quadrant);
    if (desired.length === 0) return;

    // Dedup: skip if arrangement hasn't changed
    const fingerprint = desired
      .map((slot) => `${slot.quadrant}:${slot.tty}:${slot.projectName}:${slot.model}`)
      .join("|") + `@${totalAgentCount || desired.length}`;
    if (fingerprint === lastArrangement) return;
    lastArrangement = fingerprint;

    // Build a PowerShell script that:
    // 1. Imports SetWindowPos from user32.dll
    // 2. Gets the primary screen working area
    // 3. Positions each window in its quadrant
    const windowPositionCalls = desired.map((slot) => {
      const pidStr = slot.tty.replace(/^pid:/, "");
      // Quadrant layout (2x2 grid):
      //   Q1 = top-left     Q2 = top-right
      //   Q3 = bottom-left  Q4 = bottom-right
      // For 1 window: full screen. For 2: left/right split. For 3+: 2x2 grid.
      return `@{ Pid = ${pidStr}; Quadrant = ${slot.quadrant}; Label = "Q${slot.quadrant} - ${slot.projectName.replace(/'/g, "''")}" }`;
    }).join(",\n    ");

    const psScript = `
Add-Type @"
  using System;
  using System.Runtime.InteropServices;
  public class HiveLayout {
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
    [DllImport("user32.dll")] public static extern bool SetWindowText(IntPtr hWnd, string lpString);
    public static readonly IntPtr HWND_TOP = IntPtr.Zero;
    public const uint SWP_SHOWWINDOW = 0x0040;
  }
"@
Add-Type -AssemblyName System.Windows.Forms

$workArea = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$totalW = $workArea.Width
$totalH = $workArea.Height
$originX = $workArea.X
$originY = $workArea.Y

$slots = @(
    ${windowPositionCalls}
)
$count = $slots.Count

foreach ($slot in $slots) {
  $proc = Get-Process -Id $slot.Pid -ErrorAction SilentlyContinue
  if (-not $proc -or $proc.MainWindowHandle -eq [IntPtr]::Zero) {
    # Try parent process (conhost -> terminal)
    $parentId = (Get-CimInstance Win32_Process -Filter "ProcessId=$($slot.Pid)" -ErrorAction SilentlyContinue).ParentProcessId
    if ($parentId) { $proc = Get-Process -Id $parentId -ErrorAction SilentlyContinue }
    if (-not $proc -or $proc.MainWindowHandle -eq [IntPtr]::Zero) { continue }
  }
  $hwnd = $proc.MainWindowHandle

  if ($count -eq 1) {
    # Single window: fill the screen
    [HiveLayout]::SetWindowPos($hwnd, [HiveLayout]::HWND_TOP, $originX, $originY, $totalW, $totalH, [HiveLayout]::SWP_SHOWWINDOW) | Out-Null
  } elseif ($count -eq 2) {
    # Two windows: left/right split
    $halfW = [math]::Floor($totalW / 2)
    $x = if ($slot.Quadrant -le 2) { $originX + (($slot.Quadrant - 1) * $halfW) } else { $originX + (($slot.Quadrant - 3) * $halfW) }
    [HiveLayout]::SetWindowPos($hwnd, [HiveLayout]::HWND_TOP, $x, $originY, $halfW, $totalH, [HiveLayout]::SWP_SHOWWINDOW) | Out-Null
  } else {
    # 3 or 4 windows: 2x2 grid
    $halfW = [math]::Floor($totalW / 2)
    $halfH = [math]::Floor($totalH / 2)
    switch ($slot.Quadrant) {
      1 { $x = $originX;           $y = $originY;           }
      2 { $x = $originX + $halfW;  $y = $originY;           }
      3 { $x = $originX;           $y = $originY + $halfH;  }
      4 { $x = $originX + $halfW;  $y = $originY + $halfH;  }
      default { $x = $originX;     $y = $originY;           }
    }
    [HiveLayout]::SetWindowPos($hwnd, [HiveLayout]::HWND_TOP, $x, $y, $halfW, $halfH, [HiveLayout]::SWP_SHOWWINDOW) | Out-Null
  }

  # Best-effort: set window title to show quadrant
  try { [HiveLayout]::SetWindowText($hwnd, $slot.Label) | Out-Null } catch {}
}
`;

    try {
      execFileSync("powershell", ["-NoProfile", "-Command", psScript], {
        encoding: "utf-8",
        timeout: 10000,
      });
    } catch {
      // Window arrangement is best-effort — don't crash if it fails
    }
  }

  detectQuadrants(
    ttys: string[],
    callback: (result: Map<string, number>, rawSlots?: Map<string, number>) => void,
  ): void {
    if (ttys.length === 0) return;

    // Build a PowerShell script that:
    // 1. Gets the primary screen working area for midpoint calculations
    // 2. For each PID, finds the window handle and reads its position via GetWindowRect
    // 3. Maps each window to a quadrant based on its center position in a 2x2 grid
    const pids = ttys.map((tty) => tty.replace(/^pid:/, ""));
    const pidList = pids.join(",");

    const psScript = `
Add-Type @"
  using System;
  using System.Runtime.InteropServices;
  public class HiveDetect {
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  }
"@
Add-Type -AssemblyName System.Windows.Forms

$workArea = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$midX = $workArea.X + [math]::Floor($workArea.Width / 2)
$midY = $workArea.Y + [math]::Floor($workArea.Height / 2)

$pids = @(${pidList})
foreach ($pid in $pids) {
  $proc = Get-Process -Id $pid -ErrorAction SilentlyContinue
  if (-not $proc -or $proc.MainWindowHandle -eq [IntPtr]::Zero) {
    # Try parent process (conhost -> terminal)
    $parentId = (Get-CimInstance Win32_Process -Filter "ProcessId=$pid" -ErrorAction SilentlyContinue).ParentProcessId
    if ($parentId) { $proc = Get-Process -Id $parentId -ErrorAction SilentlyContinue }
    if (-not $proc -or $proc.MainWindowHandle -eq [IntPtr]::Zero) { continue }
  }
  $hwnd = $proc.MainWindowHandle
  $rect = New-Object HiveDetect+RECT
  $ok = [HiveDetect]::GetWindowRect($hwnd, [ref]$rect)
  if (-not $ok) { continue }
  $cx = [math]::Floor(($rect.Left + $rect.Right) / 2)
  $cy = [math]::Floor(($rect.Top + $rect.Bottom) / 2)
  # Quadrant: top-left=1, top-right=2, bottom-left=3, bottom-right=4
  if ($cx -lt $midX -and $cy -lt $midY) { $q = 1 }
  elseif ($cx -ge $midX -and $cy -lt $midY) { $q = 2 }
  elseif ($cx -lt $midX -and $cy -ge $midY) { $q = 3 }
  else { $q = 4 }
  Write-Output "$pid$([char]9)$q"
}
`;

    try {
      const output = execFileSync("powershell", ["-NoProfile", "-Command", psScript], {
        encoding: "utf-8",
        timeout: 10000,
      });

      // Parse output: each line is "PID\tQuadrant"
      const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);
      const result = new Map<string, number>();
      const rawSlots = new Map<string, number>();
      const usedSlots = new Set<number>();

      for (const line of lines) {
        const [pidStr, qStr] = line.split("\t");
        if (!pidStr || !qStr) continue;
        const quadrant = parseInt(qStr, 10);
        if (quadrant < 1 || quadrant > 4) continue;

        // Find the original tty string that matches this PID
        const originalTty = ttys.find((tty) => tty.replace(/^pid:/, "") === pidStr);
        if (!originalTty) continue;

        rawSlots.set(originalTty, quadrant);

        let q = quadrant;
        if (usedSlots.has(q)) {
          // Collision: find next free slot
          for (let s = 1; s <= 4; s++) {
            if (!usedSlots.has(s)) { q = s; break; }
          }
        }
        result.set(originalTty, q);
        usedSlots.add(q);
      }

      if (result.size > 0) {
        callback(result, rawSlots);
      }
    } catch {
      // detectQuadrants is best-effort -- don't crash if PowerShell fails
    }
  }

  resetArrangement(): void {
    lastArrangement = "";
  }
}
