/**
 * Windows terminal IO.
 *
 * On Windows there are no /dev/tty devices. Agents are identified by PID.
 *
 * Message delivery uses a file-based inbox system instead of Win32 API
 * injection. No Win32 API can reliably inject text into Windows Terminal
 * from a background process (AttachConsole fails with ConPTY, PostMessage
 * requires focus, SendKeys is fragile). Instead:
 *
 * 1. The satellite daemon writes messages to ~/.hive/inbox/pid_{PID}.msg
 * 2. Claude Code hooks (identity.sh on UserPromptSubmit, auto-approve.sh
 *    on PreToolUse) check the inbox and deliver messages as additionalContext
 * 3. The agent sees the message in its next system-reminder and processes it
 *
 * This is reliable, requires no window focus or console attachment, and works
 * with any terminal emulator (Windows Terminal, cmd.exe, PowerShell, etc.).
 *
 * readContent() attempts several strategies to read terminal output:
 *   1. Check if the process has a --log-file / -log argument and read the tail
 *   2. Check for hive-terminal-*.log temp files written by the process
 *   3. Return null as fallback if nothing works
 */

import { execFileSync } from "child_process";
import { writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync, statSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import type { PlatformSendResult, TerminalIO } from "../interfaces.js";

function extractPid(tty: string): string | null {
  const match = tty.match(/^pid:(\d+)$/);
  return match ? match[1] : null;
}

/** Ensure ~/.hive/inbox/ exists and return its path. */
function ensureInboxDir(): string {
  const inboxDir = join(homedir(), ".hive", "inbox");
  mkdirSync(inboxDir, { recursive: true });
  return inboxDir;
}

/**
 * Write a message to the inbox for a target PID.
 * The file acts as the handoff point — hooks running inside the target
 * agent's Claude Code process will pick it up and inject it.
 */
function writeToInbox(pid: string, text: string): PlatformSendResult {
  try {
    const inboxDir = ensureInboxDir();
    const msgFile = join(inboxDir, `pid_${pid}.msg`);
    writeFileSync(msgFile, text, { encoding: "utf-8" });
    return { ok: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Inbox write failed: ${msg.slice(0, 150)}` };
  }
}

/**
 * Write a keystroke name to the inbox for a target PID.
 * Used for selection prompts (enter/down/up).
 */
function writeKeystrokeToInbox(pid: string, key: string): PlatformSendResult {
  try {
    const inboxDir = ensureInboxDir();
    const keyFile = join(inboxDir, `pid_${pid}.key`);
    writeFileSync(keyFile, key, { encoding: "utf-8" });
    return { ok: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Inbox keystroke write failed: ${msg.slice(0, 150)}` };
  }
}

export class WindowsTerminalIO implements TerminalIO {
  private _sendInFlight = false;

  sendText(tty: string, text: string): PlatformSendResult {
    const cleaned = text.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
    if (!cleaned) return { ok: false, error: "Empty message" };

    const pid = extractPid(tty);
    if (!pid) return { ok: false, error: `Invalid tty identifier: ${tty}` };

    this._sendInFlight = true;
    try {
      return writeToInbox(pid, cleaned);
    } finally {
      this._sendInFlight = false;
    }
  }

  sendTextAsync(tty: string, text: string): Promise<PlatformSendResult> {
    const cleaned = text.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
    if (!cleaned) return Promise.resolve({ ok: false, error: "Empty message" });

    const pid = extractPid(tty);
    if (!pid) return Promise.resolve({ ok: false, error: `Invalid tty identifier: ${tty}` });

    // Inbox write is synchronous (just a file write), but we keep the async
    // signature for interface compatibility.
    this._sendInFlight = true;
    try {
      return Promise.resolve(writeToInbox(pid, cleaned));
    } finally {
      this._sendInFlight = false;
    }
  }

  sendKeystroke(tty: string, key: "enter" | "down" | "up"): PlatformSendResult {
    const pid = extractPid(tty);
    if (!pid) return { ok: false, error: `Invalid tty identifier: ${tty}` };

    this._sendInFlight = true;
    try {
      return writeKeystrokeToInbox(pid, key);
    } finally {
      this._sendInFlight = false;
    }
  }

  sendKeystrokeAsync(tty: string, key: "enter" | "down" | "up"): Promise<PlatformSendResult> {
    const pid = extractPid(tty);
    if (!pid) return Promise.resolve({ ok: false, error: `Invalid tty identifier: ${tty}` });

    this._sendInFlight = true;
    try {
      return Promise.resolve(writeKeystrokeToInbox(pid, key));
    } finally {
      this._sendInFlight = false;
    }
  }

  sendSelection(tty: string, optionIndex: number): PlatformSendResult {
    const pid = extractPid(tty);
    if (!pid) return { ok: false, error: `Invalid tty identifier: ${tty}` };

    const count = Math.max(0, optionIndex);
    this._sendInFlight = true;
    try {
      for (let i = 0; i < count; i++) {
        const r = writeKeystrokeToInbox(pid, "down");
        if (!r.ok) return r;
      }
      return writeKeystrokeToInbox(pid, "enter");
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
