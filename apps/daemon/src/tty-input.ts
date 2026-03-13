import { execFileSync, execFile } from "child_process";
import { promisify } from "util";
import { writeFileSync, unlinkSync } from "fs";
import { randomBytes } from "crypto";
import { join } from "path";
import { homedir, tmpdir } from "os";

const execFileAsync = promisify(execFile);
const SEND_RETURN_BIN = process.env.SEND_RETURN_BIN || join(homedir(), "send-return");

/**
 * Send messages to multiple TTYs in a single batched AppleScript call.
 * Much faster than calling sendInputToTty N times serially.
 *
 * Each entry's text is injected into its TTY tab, followed by a Return
 * keystroke, all within one osascript invocation.
 */
export function sendInputToMultipleTtys(
  entries: Array<{ tty: string; text: string }>,
): Array<{ tty: string; ok: boolean; error?: string }> {
  if (entries.length === 0) return [];
  if (entries.length === 1) {
    const r = sendInputToTty(entries[0].tty, entries[0].text);
    return [{ tty: entries[0].tty, ...r }];
  }

  // Write temp files for each entry
  const prepared: Array<{ tty: string; device: string; tmpFile: string }> = [];
  const results: Array<{ tty: string; ok: boolean; error?: string }> = [];

  for (const entry of entries) {
    const cleaned = entry.text.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
    if (!cleaned) {
      results.push({ tty: entry.tty, ok: false, error: "Empty message" });
      continue;
    }
    const device = entry.tty.startsWith("/dev/") ? entry.tty : `/dev/${entry.tty}`;
    const tmpFile = join(tmpdir(), `hive-input-${randomBytes(8).toString("hex")}.txt`);
    try {
      writeFileSync(tmpFile, cleaned, { encoding: "utf-8", mode: 0o600 });
      prepared.push({ tty: entry.tty, device, tmpFile });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ tty: entry.tty, ok: false, error: `Write tmp failed: ${msg.slice(0, 150)}` });
    }
  }

  if (prepared.length === 0) return results;

  const previousApp = getFrontmostApp();

  // Build one AppleScript that injects text into each tab and sends Return
  // via System Events keystroke (no need for send-return binary per-tab)
  const tabBlocks = prepared.map(p => `
    -- Inject into ${p.tty}
    set targetTab to missing value
    set targetWin to missing value
    repeat with w in windows
      repeat with t in tabs of w
        if tty of t is "${p.device}" then
          set targetTab to t
          set targetWin to w
          exit repeat
        end if
      end repeat
      if targetTab is not missing value then exit repeat
    end repeat
    if targetTab is not missing value then
      set payload to read POSIX file "${p.tmpFile}" as «class utf8»
      do script payload in targetTab
      set selected of targetTab to true
      set index of targetWin to 1
    end if
    set targetTab to missing value
    set targetWin to missing value`
  ).join("\n");

  // After injecting all text, activate Terminal and send Return for each tab
  const returnBlocks = prepared.map(p => `
    -- Return for ${p.tty}
    set targetTab to missing value
    set targetWin to missing value
    repeat with w in windows
      repeat with t in tabs of w
        if tty of t is "${p.device}" then
          set targetTab to t
          set targetWin to w
          exit repeat
        end if
      end repeat
      if targetTab is not missing value then exit repeat
    end repeat
    if targetTab is not missing value then
      set selected of targetTab to true
      set index of targetWin to 1
    end if
    set targetTab to missing value
    set targetWin to missing value`
  ).join(`
    delay 0.15
    tell application "System Events"
      tell process "Terminal"
        key code 36
      end tell
    end tell
    delay 0.3
  `);

  const script = `
tell application "Terminal"
${tabBlocks}
end tell

delay 0.2

tell application "Terminal"
  activate
${returnBlocks}
  delay 0.15
end tell
tell application "System Events"
  tell process "Terminal"
    key code 36
  end tell
end tell
`;

  try {
    execFileSync("/usr/bin/osascript", ["-e", script], {
      timeout: 30000,
      encoding: "utf-8",
    });
    for (const p of prepared) {
      results.push({ tty: p.tty, ok: true });
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    for (const p of prepared) {
      results.push({ tty: p.tty, ok: false, error: `Batch send failed: ${msg.slice(0, 150)}` });
    }
  }

  // Cleanup all temp files
  for (const p of prepared) cleanup(p.tmpFile);

  // Restore focus
  if (previousApp) restoreFrontmostApp(previousApp);

  return results;
}

/**
 * Capture the bundle ID of the currently frontmost application.
 * Returns null on failure (non-critical — restore just won't happen).
 */
function getFrontmostApp(): string | null {
  try {
    const result = execFileSync("/usr/bin/osascript", ["-e",
      'tell application "System Events" to return bundle identifier of first application process whose frontmost is true'
    ], { timeout: 2000, encoding: "utf-8" });
    const bid = result.trim();
    return bid && bid !== "com.apple.Terminal" ? bid : null;
  } catch {
    return null;
  }
}

async function getFrontmostAppAsync(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("/usr/bin/osascript", ["-e",
      'tell application "System Events" to return bundle identifier of first application process whose frontmost is true'
    ], { timeout: 2000, encoding: "utf-8" });
    const bid = (stdout as string).trim();
    return bid && bid !== "com.apple.Terminal" ? bid : null;
  } catch {
    return null;
  }
}

/**
 * Restore focus to the app that was frontmost before we activated Terminal.
 * Fire-and-forget — if it fails, the user just stays on Terminal (no worse than before).
 */
function restoreFrontmostApp(bundleId: string): void {
  try {
    execFileSync("/usr/bin/osascript", ["-e",
      `tell application id "${bundleId}" to activate`
    ], { timeout: 2000, encoding: "utf-8" });
  } catch {
    // Non-critical — worst case user stays on Terminal (current behavior)
  }
}

function restoreFrontmostAppAsync(bundleId: string): void {
  execFile("/usr/bin/osascript", ["-e",
    `tell application id "${bundleId}" to activate`
  ], { timeout: 2000, encoding: "utf-8" }, () => {
    // Non-critical — worst case user stays on Terminal
  });
}

/**
 * Send text + Enter to a Claude Code instance running in a Terminal.app tab.
 *
 * Two-step approach:
 * 1. Write the text to a temp file (avoids AppleScript string escaping and
 *    keeps the `do script` payload to a single call).
 * 2. AppleScript loads the file and injects it into the correct Terminal tab.
 * 3. A compiled Swift helper (`~/send-return`) posts a CGEvent Return keystroke
 *    at the HID level (requires Accessibility permission for the binary).
 *
 * After the Return lands, focus is restored to whatever app was frontmost
 * before Terminal was activated.
 */
export function sendInputToTty(tty: string, text: string): { ok: boolean; error?: string } {
  const device = tty.startsWith("/dev/") ? tty : `/dev/${tty}`;

  // Collapse newlines to spaces — Claude Code input is single-line
  const cleaned = text.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return { ok: false, error: "Empty message" };

  const tmpFile = join(tmpdir(), `hive-input-${randomBytes(8).toString("hex")}.txt`);
  try {
    writeFileSync(tmpFile, cleaned, { encoding: "utf-8", mode: 0o600 });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Write tmp failed: ${msg.slice(0, 150)}` };
  }

  // Snapshot the currently frontmost app so we can restore after send
  const previousApp = getFrontmostApp();

  const script = `
tell application "Terminal"
  set payload to read POSIX file "${tmpFile}" as «class utf8»
  set targetTTY to "${device}"
  set targetTab to missing value
  set targetWin to missing value
  repeat with w in windows
    repeat with t in tabs of w
      if tty of t is targetTTY then
        set targetTab to t
        set targetWin to w
        exit repeat
      end if
    end repeat
    if targetTab is not missing value then exit repeat
  end repeat
  if targetTab is missing value then error "TTY not found in Terminal.app"
  do script payload in targetTab
  set selected of targetTab to true
  set index of targetWin to 1
  activate
end tell
`;

  try {
    execFileSync("/usr/bin/osascript", ["-e", script], {
      timeout: 15000,
      encoding: "utf-8",
    });
  } catch (err: unknown) {
    cleanup(tmpFile);
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Type failed: ${msg.slice(0, 180)}` };
  }

  cleanup(tmpFile);

  // Step 2: Send Return keystroke via CGEvent (HID-level, no Apple Events)
  try {
    execFileSync(SEND_RETURN_BIN, [], {
      timeout: 3000,
      encoding: "utf-8",
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // Still try to restore even if Return failed
    if (previousApp) restoreFrontmostApp(previousApp);
    return { ok: false, error: `Enter failed: ${msg.slice(0, 180)}` };
  }

  // Step 3: Restore focus to the app that was frontmost before Terminal
  if (previousApp) restoreFrontmostApp(previousApp);

  return { ok: true };
}

// Mutex for async TTY sends. The two-step approach (do script + send-return)
// requires Terminal focus to stay on the target window between steps. Without
// serialization, concurrent sends fight over focus and send-return hits the
// wrong terminal.
let sendMutex: Promise<void> = Promise.resolve();

/**
 * Async version of sendInputToTty — same two-step approach (do script + send-return)
 * but does NOT block the Node.js event loop. WebSocket messages, status updates,
 * and other requests continue flowing while the AppleScript executes.
 *
 * Sends are serialized via a promise chain so concurrent callers don't race
 * over Terminal.app focus.
 */
export function sendInputToTtyAsync(tty: string, text: string): Promise<{ ok: boolean; error?: string }> {
  const cleaned = text.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return Promise.resolve({ ok: false, error: "Empty message" });

  // Chain onto the mutex — each send waits for the previous to finish
  const resultPromise = sendMutex.then(() => doSendAsync(tty, cleaned));
  // Update the mutex to wait for this send (swallow errors so chain continues)
  sendMutex = resultPromise.then(() => {}, () => {});
  return resultPromise;
}

async function doSendAsync(tty: string, cleaned: string): Promise<{ ok: boolean; error?: string }> {
  const device = tty.startsWith("/dev/") ? tty : `/dev/${tty}`;

  const tmpFile = join(tmpdir(), `hive-input-${randomBytes(8).toString("hex")}.txt`);
  try {
    writeFileSync(tmpFile, cleaned, { encoding: "utf-8", mode: 0o600 });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Write tmp failed: ${msg.slice(0, 150)}` };
  }

  const script = `
tell application "Terminal"
  set payload to read POSIX file "${tmpFile}" as «class utf8»
  set targetTTY to "${device}"
  set targetTab to missing value
  set targetWin to missing value
  repeat with w in windows
    repeat with t in tabs of w
      if tty of t is targetTTY then
        set targetTab to t
        set targetWin to w
        exit repeat
      end if
    end repeat
    if targetTab is not missing value then exit repeat
  end repeat
  if targetTab is missing value then error "TTY not found in Terminal.app"
  do script payload in targetTab
  set selected of targetTab to true
  set index of targetWin to 1
  activate
end tell
`;

  try {
    await execFileAsync("/usr/bin/osascript", ["-e", script], {
      timeout: 15000,
      encoding: "utf-8",
    });
  } catch (err: unknown) {
    cleanup(tmpFile);
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Type failed: ${msg.slice(0, 180)}` };
  }

  cleanup(tmpFile);

  // Step 2: Send Return keystroke via CGEvent
  try {
    await execFileAsync(SEND_RETURN_BIN, [], {
      timeout: 3000,
      encoding: "utf-8",
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Enter failed: ${msg.slice(0, 180)}` };
  }

  return { ok: true };
}

/**
 * Send keystrokes (arrow keys + Enter) to a Terminal.app tab via System Events.
 *
 * Used for ink-based selection UIs (AskUserQuestion, EnterPlanMode) where
 * `do script` text injection doesn't work — ink's raw-mode selection
 * component ignores injected text and only responds to key events.
 *
 * @param optionIndex 0-based index of the option to select (0 = first/default)
 */
export function sendSelectionToTty(tty: string, optionIndex: number): { ok: boolean; error?: string } {
  const device = tty.startsWith("/dev/") ? tty : `/dev/${tty}`;

  // Build arrow-down keystrokes to reach the desired option
  const downKeys = Array(optionIndex)
    .fill('    key code 125\n    delay 0.05') // 125 = Down arrow
    .join("\n");

  const script = `
tell application "Terminal"
  set targetTTY to "${device}"
  set targetTab to missing value
  set targetWin to missing value
  repeat with w in windows
    repeat with t in tabs of w
      if tty of t is targetTTY then
        set targetTab to t
        set targetWin to w
        exit repeat
      end if
    end repeat
    if targetTab is not missing value then exit repeat
  end repeat
  if targetTab is missing value then error "TTY not found in Terminal.app"
  set selected of targetTab to true
  set index of targetWin to 1
  activate
  delay 0.3
end tell
tell application "System Events"
  tell process "Terminal"
${downKeys ? downKeys + "\n    delay 0.05" : ""}
    key code 36
  end tell
end tell
`;

  try {
    execFileSync("/usr/bin/osascript", ["-e", script], {
      timeout: 15000,
      encoding: "utf-8",
    });
    return { ok: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Selection failed: ${msg.slice(0, 180)}` };
  }
}

/**
 * Send just an Enter keystroke to a Terminal.app tab identified by TTY.
 *
 * Used for pre-session prompts (trust folder, sandbox) where the default
 * option is already selected and only Enter is needed.
 *
 * Two-step approach:
 * 1. AppleScript brings the correct tab to the front (Terminal.app API — works from launchd)
 * 2. CGEvent Return keystroke via ~/send-return (HID-level — works without System Events)
 */
export function sendEnterToTty(tty: string): { ok: boolean; error?: string } {
  const device = tty.startsWith("/dev/") ? tty : `/dev/${tty}`;

  const previousApp = getFrontmostApp();

  // Activate the correct terminal tab and send Return keystroke in one
  // AppleScript — uses key code 36 (Return) via System Events.
  // Falls back to CGEvent via send-return if System Events fails (-1743).
  const script = `
tell application "Terminal"
  set targetTTY to "${device}"
  set targetTab to missing value
  set targetWin to missing value
  repeat with w in windows
    repeat with t in tabs of w
      if tty of t is targetTTY then
        set targetTab to t
        set targetWin to w
        exit repeat
      end if
    end repeat
    if targetTab is not missing value then exit repeat
  end repeat
  if targetTab is missing value then error "TTY not found in Terminal.app"
  set selected of targetTab to true
  set index of targetWin to 1
  activate
end tell
delay 0.5
try
  tell application "System Events"
    tell process "Terminal"
      key code 36
    end tell
  end tell
  return "system_events"
on error
  return "need_cgevent"
end try
`;

  let needCGEvent = false;
  try {
    const result = execFileSync("/usr/bin/osascript", ["-e", script], {
      timeout: 8000,
      encoding: "utf-8",
    });
    needCGEvent = (result as string).trim() === "need_cgevent";
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Activate tab failed: ${msg.slice(0, 180)}` };
  }

  if (needCGEvent) {
    // System Events blocked (-1743) — fall back to CGEvent via send-return
    execFileSync("/bin/sleep", ["0.5"]);
    try {
      execFileSync(SEND_RETURN_BIN, [], {
        timeout: 3000,
        encoding: "utf-8",
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (previousApp) restoreFrontmostApp(previousApp);
      return { ok: false, error: `Enter failed: ${msg.slice(0, 180)}` };
    }
    // Send a second time after a brief delay (ink UI can miss the first)
    execFileSync("/bin/sleep", ["0.3"]);
    try {
      execFileSync(SEND_RETURN_BIN, [], { timeout: 3000, encoding: "utf-8" });
    } catch { /* best effort */ }
  }

  if (previousApp) restoreFrontmostApp(previousApp);

  return { ok: true };
}

function cleanup(path: string): void {
  try { unlinkSync(path); } catch { /* ignore */ }
}
