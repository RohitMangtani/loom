/**
 * Windows terminal IO.
 *
 * On Windows there are no /dev/tty devices. Agents are identified by PID.
 * Terminal IO uses PowerShell + Win32 WriteConsoleInput to inject keystrokes
 * directly into a console's input buffer via AttachConsole(pid). No window
 * focus is required — works headless, minimized, or when another window is
 * in the foreground.
 *
 * The approach:
 * 1. FreeConsole() — detach from our own console
 * 2. Walk the process tree (up to 5 levels) trying AttachConsole(pid) for
 *    each ancestor until one succeeds (the target PID may be a child of
 *    conhost.exe or WindowsTerminal.exe)
 * 3. GetStdHandle(STD_INPUT_HANDLE) to get the console input buffer handle
 * 4. WriteConsoleInput() to inject KEY_EVENT_RECORD pairs (down+up) for
 *    each character or virtual key
 * 5. FreeConsole() to detach cleanly
 *
 * readContent() attempts several strategies to read terminal output:
 *   1. Check if the process has a --log-file / -log argument and read the tail
 *   2. Check for hive-terminal-*.log temp files written by the process
 *   3. Return null as fallback if nothing works
 */

import { execFileSync, execFile } from "child_process";
import { promisify } from "util";
import { writeFileSync, unlinkSync, readFileSync, existsSync, readdirSync, statSync } from "fs";
import { randomBytes } from "crypto";
import { tmpdir } from "os";
import { join } from "path";
import type { PlatformSendResult, TerminalIO } from "../interfaces.js";

const execFileAsync = promisify(execFile);

function extractPid(tty: string): string | null {
  const match = tty.match(/^pid:(\d+)$/);
  return match ? match[1] : null;
}

/**
 * Legacy: Build the PowerShell preamble that loads Win32 API and focuses a window.
 * Kept as a fallback — main send functions now use WriteConsoleInput which
 * does not require window focus.
 */
function _buildWindowFocusScript(pid: string): string {
  return `
Add-Type @"
  using System;
  using System.Runtime.InteropServices;
  public class HiveWinApi {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  }
"@
$proc = Get-Process -Id ${pid} -ErrorAction SilentlyContinue
if (-not $proc -or -not $proc.MainWindowHandle -or $proc.MainWindowHandle -eq [IntPtr]::Zero) {
  $parent = (Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue).ParentProcessId
  if ($parent) { $proc = Get-Process -Id $parent -ErrorAction SilentlyContinue }
  if (-not $proc -or -not $proc.MainWindowHandle -or $proc.MainWindowHandle -eq [IntPtr]::Zero) { exit 1 }
}
[HiveWinApi]::ShowWindow($proc.MainWindowHandle, 9) | Out-Null
[HiveWinApi]::SetForegroundWindow($proc.MainWindowHandle) | Out-Null
Start-Sleep -Milliseconds 200
Add-Type -AssemblyName System.Windows.Forms
`;
}

/**
 * Build the PowerShell C# type definition for WriteConsoleInput via AttachConsole.
 * This is the core Win32 interop used by all send functions.
 */
function buildConsoleInputType(): string {
  return `
Add-Type @"
  using System;
  using System.Runtime.InteropServices;

  [StructLayout(LayoutKind.Explicit)]
  public struct KEY_EVENT_RECORD {
    [FieldOffset(0)] public bool bKeyDown;
    [FieldOffset(4)] public ushort wRepeatCount;
    [FieldOffset(6)] public ushort wVirtualKeyCode;
    [FieldOffset(8)] public ushort wVirtualScanCode;
    [FieldOffset(10)] public char UnicodeChar;
    [FieldOffset(12)] public uint dwControlKeyState;
  }

  [StructLayout(LayoutKind.Explicit)]
  public struct INPUT_RECORD {
    [FieldOffset(0)] public ushort EventType;
    [FieldOffset(4)] public KEY_EVENT_RECORD KeyEvent;
  }

  public class HiveConsoleApi {
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool FreeConsole();

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool AttachConsole(uint dwProcessId);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr GetStdHandle(int nStdHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool WriteConsoleInput(
      IntPtr hConsoleInput,
      INPUT_RECORD[] lpBuffer,
      uint nLength,
      out uint lpNumberOfEventsWritten
    );

    public static void SendKeyEvent(IntPtr handle, ushort vk, char ch) {
      INPUT_RECORD[] events = new INPUT_RECORD[2];

      events[0].EventType = 0x0001; // KEY_EVENT
      events[0].KeyEvent.bKeyDown = true;
      events[0].KeyEvent.wRepeatCount = 1;
      events[0].KeyEvent.wVirtualKeyCode = vk;
      events[0].KeyEvent.UnicodeChar = ch;
      events[0].KeyEvent.dwControlKeyState = 0;

      events[1].EventType = 0x0001;
      events[1].KeyEvent.bKeyDown = false;
      events[1].KeyEvent.wRepeatCount = 1;
      events[1].KeyEvent.wVirtualKeyCode = vk;
      events[1].KeyEvent.UnicodeChar = ch;
      events[1].KeyEvent.dwControlKeyState = 0;

      uint written;
      WriteConsoleInput(handle, events, 2, out written);
    }
  }
"@
`;
}

/**
 * Build the PowerShell snippet that walks the process tree (up to 5 levels)
 * and attaches to the first console that succeeds.
 */
function buildAttachConsoleSnippet(pid: string): string {
  return `
[HiveConsoleApi]::FreeConsole() | Out-Null
$targetPid = ${pid}
$attached = $false
for ($i = 0; $i -lt 5; $i++) {
  if ([HiveConsoleApi]::AttachConsole([uint32]$targetPid)) {
    $attached = $true
    break
  }
  $parentRow = Get-CimInstance Win32_Process -Filter "ProcessId=$targetPid" -ErrorAction SilentlyContinue
  if (-not $parentRow -or -not $parentRow.ParentProcessId) { break }
  $targetPid = $parentRow.ParentProcessId
}
if (-not $attached) { exit 1 }
$hInput = [HiveConsoleApi]::GetStdHandle(-10)
if ($hInput -eq [IntPtr]::Zero -or $hInput -eq [IntPtr]::new(-1)) {
  [HiveConsoleApi]::FreeConsole() | Out-Null
  exit 1
}
`;
}

/**
 * Build the PowerShell snippet that reads text from a file and sends each
 * character as a KEY_EVENT pair, followed by Enter.
 */
function buildSendTextSnippet(tmpFilePath: string): string {
  return `
$text = Get-Content -Path '${tmpFilePath.replace(/'/g, "''")}' -Raw
foreach ($ch in $text.ToCharArray()) {
  [HiveConsoleApi]::SendKeyEvent($hInput, 0, $ch)
}
# Send Enter (VK_RETURN = 0x0D, char = 13)
[HiveConsoleApi]::SendKeyEvent($hInput, 0x0D, [char]13)
[HiveConsoleApi]::FreeConsole() | Out-Null
`;
}

/**
 * Build the PowerShell snippet that sends a single virtual key (enter/down/up)
 * as a KEY_EVENT pair.
 */
function buildSendKeystrokeSnippet(key: string): string {
  // VK_RETURN=0x0D, VK_DOWN=0x28, VK_UP=0x26
  const vk = key === "enter" ? "0x0D" : key === "down" ? "0x28" : "0x26";
  const ch = key === "enter" ? "[char]13" : "[char]0";
  return `
[HiveConsoleApi]::SendKeyEvent($hInput, ${vk}, ${ch})
[HiveConsoleApi]::FreeConsole() | Out-Null
`;
}

function sendViaPowerShell(pid: string, text: string): PlatformSendResult {
  const tmpFile = join(tmpdir(), `hive-input-${randomBytes(8).toString("hex")}.txt`);
  try {
    writeFileSync(tmpFile, text, { encoding: "utf-8" });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Write tmp failed: ${msg.slice(0, 150)}` };
  }

  const psScript =
    buildConsoleInputType() +
    buildAttachConsoleSnippet(pid) +
    buildSendTextSnippet(tmpFile);

  try {
    execFileSync("powershell", ["-NoProfile", "-Command", psScript], {
      encoding: "utf-8",
      timeout: 15000,
    });
    return { ok: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `PowerShell send failed: ${msg.slice(0, 150)}` };
  } finally {
    try { unlinkSync(tmpFile); } catch { /* ignore */ }
  }
}

async function sendViaPowerShellAsync(pid: string, text: string): Promise<PlatformSendResult> {
  const tmpFile = join(tmpdir(), `hive-input-${randomBytes(8).toString("hex")}.txt`);
  try {
    writeFileSync(tmpFile, text, { encoding: "utf-8" });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Write tmp failed: ${msg.slice(0, 150)}` };
  }

  const psScript =
    buildConsoleInputType() +
    buildAttachConsoleSnippet(pid) +
    buildSendTextSnippet(tmpFile);

  try {
    await execFileAsync("powershell", ["-NoProfile", "-Command", psScript], {
      encoding: "utf-8",
      timeout: 15000,
    });
    return { ok: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `PowerShell send failed: ${msg.slice(0, 150)}` };
  } finally {
    try { unlinkSync(tmpFile); } catch { /* ignore */ }
  }
}

function sendKeystrokeViaPowerShell(pid: string, key: string): PlatformSendResult {
  const psScript =
    buildConsoleInputType() +
    buildAttachConsoleSnippet(pid) +
    buildSendKeystrokeSnippet(key);

  try {
    execFileSync("powershell", ["-NoProfile", "-Command", psScript], {
      encoding: "utf-8",
      timeout: 10000,
    });
    return { ok: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Keystroke failed: ${msg.slice(0, 150)}` };
  }
}

async function sendKeystrokeViaPowerShellAsync(pid: string, key: string): Promise<PlatformSendResult> {
  const psScript =
    buildConsoleInputType() +
    buildAttachConsoleSnippet(pid) +
    buildSendKeystrokeSnippet(key);

  try {
    await execFileAsync("powershell", ["-NoProfile", "-Command", psScript], {
      encoding: "utf-8",
      timeout: 10000,
    });
    return { ok: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Keystroke failed: ${msg.slice(0, 150)}` };
  }
}

export class WindowsTerminalIO implements TerminalIO {
  private _sendInFlight = false;
  private sendMutex: Promise<void> = Promise.resolve();

  sendText(tty: string, text: string): PlatformSendResult {
    const cleaned = text.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
    if (!cleaned) return { ok: false, error: "Empty message" };

    const pid = extractPid(tty);
    if (!pid) return { ok: false, error: `Invalid tty identifier: ${tty}` };

    this._sendInFlight = true;
    try {
      return sendViaPowerShell(pid, cleaned);
    } finally {
      this._sendInFlight = false;
    }
  }

  sendTextAsync(tty: string, text: string): Promise<PlatformSendResult> {
    const cleaned = text.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
    if (!cleaned) return Promise.resolve({ ok: false, error: "Empty message" });

    const pid = extractPid(tty);
    if (!pid) return Promise.resolve({ ok: false, error: `Invalid tty identifier: ${tty}` });

    const resultPromise = this.sendMutex.then(async () => {
      this._sendInFlight = true;
      try {
        return await sendViaPowerShellAsync(pid, cleaned);
      } finally {
        this._sendInFlight = false;
      }
    });
    this.sendMutex = resultPromise.then(() => {}, () => {});
    return resultPromise;
  }

  sendKeystroke(tty: string, key: "enter" | "down" | "up"): PlatformSendResult {
    const pid = extractPid(tty);
    if (!pid) return { ok: false, error: `Invalid tty identifier: ${tty}` };

    this._sendInFlight = true;
    try {
      return sendKeystrokeViaPowerShell(pid, key);
    } finally {
      this._sendInFlight = false;
    }
  }

  sendKeystrokeAsync(tty: string, key: "enter" | "down" | "up"): Promise<PlatformSendResult> {
    const pid = extractPid(tty);
    if (!pid) return Promise.resolve({ ok: false, error: `Invalid tty identifier: ${tty}` });

    const resultPromise = this.sendMutex.then(async () => {
      this._sendInFlight = true;
      try {
        return await sendKeystrokeViaPowerShellAsync(pid, key);
      } finally {
        this._sendInFlight = false;
      }
    });
    this.sendMutex = resultPromise.then(() => {}, () => {});
    return resultPromise;
  }

  sendSelection(tty: string, optionIndex: number): PlatformSendResult {
    const pid = extractPid(tty);
    if (!pid) return { ok: false, error: `Invalid tty identifier: ${tty}` };

    const count = Math.max(0, optionIndex);
    this._sendInFlight = true;
    try {
      for (let i = 0; i < count; i++) {
        const r = sendKeystrokeViaPowerShell(pid, "down");
        if (!r.ok) return r;
      }
      return sendKeystrokeViaPowerShell(pid, "enter");
    } finally {
      this._sendInFlight = false;
    }
  }

  readContent(tty: string): string | null {
    const pid = extractPid(tty);
    if (!pid) return null;

    // Strategy 1: Check if the process was launched with a log file argument
    // (e.g. --log-file, --log, -l) and read the tail of that file.
    try {
      const cmdLine = execFileSync("powershell", [
        "-NoProfile", "-Command",
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue).CommandLine`,
      ], { encoding: "utf-8", timeout: 3000 }).trim();

      if (cmdLine) {
        const logMatch = cmdLine.match(/--?(?:log[-_]?file|log|output)\s+["']?([^"'\s]+)/i);
        if (logMatch && logMatch[1]) {
          const logPath = logMatch[1];
          try {
            if (existsSync(logPath)) {
              const content = readFileSync(logPath, "utf-8");
              const lines = content.split("\n");
              return lines.slice(-50).join("\n");
            }
          } catch { /* file unreadable, try next strategy */ }
        }
      }
    } catch { /* PowerShell unavailable or timed out */ }

    // Strategy 2: Check for hive-terminal log files in TEMP directory.
    // The daemon or spawn script may configure logging to %TEMP%\hive-terminal-{pid}.log
    const tempDir = process.env.TEMP || process.env.TMP || tmpdir();
    try {
      // Try exact PID-based log file first
      const pidLogFile = join(tempDir, `hive-terminal-${pid}.log`);
      if (existsSync(pidLogFile)) {
        const content = readFileSync(pidLogFile, "utf-8");
        const lines = content.split("\n");
        return lines.slice(-50).join("\n");
      }

      // Scan for any hive-terminal log files, pick the most recently modified
      const logFiles: Array<{ path: string; mtime: number }> = [];
      for (const entry of readdirSync(tempDir)) {
        if (!entry.startsWith("hive-terminal-") || !entry.endsWith(".log")) continue;
        const fullPath = join(tempDir, entry);
        try {
          const stat = statSync(fullPath);
          logFiles.push({ path: fullPath, mtime: stat.mtimeMs });
        } catch { /* skip */ }
      }

      if (logFiles.length > 0) {
        logFiles.sort((a, b) => b.mtime - a.mtime);
        const content = readFileSync(logFiles[0].path, "utf-8");
        const lines = content.split("\n");
        return lines.slice(-50).join("\n");
      }
    } catch { /* temp dir scan failed */ }

    // Strategy 3: Try reading the Windows Terminal log if the WT session
    // has logging enabled (Settings > Profile > Advanced > Log file path).
    // The default location is %LOCALAPPDATA%\Packages\Microsoft.WindowsTerminal_*\LocalState\
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      try {
        const packagesDir = join(localAppData, "Packages");
        for (const pkg of readdirSync(packagesDir)) {
          if (!pkg.startsWith("Microsoft.WindowsTerminal")) continue;
          const localState = join(packagesDir, pkg, "LocalState");
          if (!existsSync(localState)) continue;
          // Look for recent log files
          for (const file of readdirSync(localState)) {
            if (!file.endsWith(".log") && !file.endsWith(".txt")) continue;
            const fullPath = join(localState, file);
            try {
              const stat = statSync(fullPath);
              // Only consider files modified in the last 5 minutes
              if (Date.now() - stat.mtimeMs > 300_000) continue;
              const content = readFileSync(fullPath, "utf-8");
              const lines = content.split("\n");
              return lines.slice(-50).join("\n");
            } catch { /* skip */ }
          }
        }
      } catch { /* packages dir scan failed */ }
    }

    // Fallback: no content available
    return null;
  }

  isSendInFlight(): boolean {
    return this._sendInFlight;
  }
}
