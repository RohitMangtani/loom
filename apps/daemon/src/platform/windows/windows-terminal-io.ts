/**
 * Windows terminal IO.
 *
 * On Windows there are no /dev/tty devices. Agents are identified by PID.
 * Terminal IO uses PowerShell to send keystrokes to the window owning
 * the target process via SetForegroundWindow + SendKeys.
 *
 * Limitations:
 * - SendKeys targets the foreground window. If another window is focused
 *   at the exact moment, input may go to the wrong window. This is
 *   inherently racy (same limitation as AppleScript on macOS).
 * - readContent() returns null — there's no reliable way to read terminal
 *   buffer on Windows without ConPTY.
 */

import { execFileSync, execFile } from "child_process";
import { promisify } from "util";
import { writeFileSync, unlinkSync } from "fs";
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
 * Build the PowerShell preamble that loads Win32 API and finds the window.
 * Reused across send/keystroke functions to avoid duplication.
 */
function buildWindowFocusScript(pid: string): string {
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
  # Process may be a child of conhost — try finding the parent terminal window
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

function sendViaPowerShell(pid: string, text: string): PlatformSendResult {
  const tmpFile = join(tmpdir(), `hive-input-${randomBytes(8).toString("hex")}.txt`);
  try {
    writeFileSync(tmpFile, text, { encoding: "utf-8" });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Write tmp failed: ${msg.slice(0, 150)}` };
  }

  const psScript = buildWindowFocusScript(pid) + `
$text = Get-Content -Path '${tmpFile.replace(/'/g, "''")}' -Raw
[System.Windows.Forms.SendKeys]::SendWait($text)
Start-Sleep -Milliseconds 100
[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
`;

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

  const psScript = buildWindowFocusScript(pid) + `
$text = Get-Content -Path '${tmpFile.replace(/'/g, "''")}' -Raw
[System.Windows.Forms.SendKeys]::SendWait($text)
Start-Sleep -Milliseconds 100
[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
`;

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
  const sendKey = key === "enter" ? "{ENTER}" : key === "down" ? "{DOWN}" : "{UP}";
  const psScript = buildWindowFocusScript(pid) +
    `[System.Windows.Forms.SendKeys]::SendWait('${sendKey}')`;

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
  const sendKey = key === "enter" ? "{ENTER}" : key === "down" ? "{DOWN}" : "{UP}";
  const psScript = buildWindowFocusScript(pid) +
    `[System.Windows.Forms.SendKeys]::SendWait('${sendKey}')`;

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

  readContent(_tty: string): string | null {
    // No reliable way to read terminal content on Windows without ConPTY
    return null;
  }

  isSendInFlight(): boolean {
    return this._sendInFlight;
  }
}
