import { execFile, execFileSync } from "child_process";

interface QuadrantSlot {
  quadrant: number;
  tty: string;
  projectName: string;
  model: string;
}

/** Screen quadrant positions: Q1=top-left, Q2=top-right, Q3=bottom-left, Q4=bottom-right */
const QUADRANT_POSITIONS: Record<number, { x: number; y: number }> = {
  1: { x: 0, y: 0 },    // top-left
  2: { x: 1, y: 0 },    // top-right
  3: { x: 0, y: 1 },    // bottom-left
  4: { x: 1, y: 1 },    // bottom-right
};

// Track last arrangement to avoid redundant AppleScript calls
let lastArrangement = "";
let lastTitleFingerprint = "";

/**
 * Detect the physical screen position of each Terminal window by TTY
 * and return the quadrant assignment (1-4) based on where the window
 * actually sits on screen.
 *
 * Returns a Map<tty, quadrant>. TTYs whose window can't be found are omitted.
 */
// Guard: only one detect at a time
let detectInFlight = false;

/**
 * Detect the physical screen position of each Terminal window by TTY
 * and invoke the callback with the quadrant assignments.
 *
 * Async — does NOT block the event loop. Results arrive via callback.
 * If a detection is already in flight, the call is skipped (callback not invoked).
 */
export function detectQuadrantsFromWindowPositions(
  ttys: string[],
  callback: (result: Map<string, number>) => void,
): void {
  if (ttys.length === 0) return;
  if (detectInFlight) return;
  detectInFlight = true;

  const ttyChecks = ttys.map(tty => {
    const device = tty.startsWith("/dev/") ? tty : `/dev/${tty}`;
    return `
    repeat with w in windows
      repeat with t in tabs of w
        if tty of t is "${device}" then
          set b to bounds of w
          set cx to ((item 1 of b) + (item 3 of b)) / 2
          set cy to ((item 2 of b) + (item 4 of b)) / 2
          set end of results to "${tty}," & cx & "," & cy
          exit repeat
        end if
      end repeat
    end repeat`;
  }).join("\n");

  const script = `
tell application "Finder"
  set screenBounds to bounds of window of desktop
  set screenW to item 3 of screenBounds
  set screenH to item 4 of screenBounds
end tell
set midX to screenW / 2
set midY to screenH / 2

set results to {}
tell application "Terminal"
${ttyChecks}
end tell

set output to ""
repeat with r in results
  set output to output & r & linefeed
end repeat
return "SCREEN:" & midX & "," & midY & linefeed & output
`;

  execFile("/usr/bin/osascript", ["-e", script], {
    timeout: 8000,
    encoding: "utf-8",
  }, (err, stdout) => {
    detectInFlight = false;
    if (err) {
      const msg = err.message || String(err);
      console.log(`[arrange] Failed to detect window positions: ${msg.slice(0, 150)}`);
      return;
    }

    const raw = (stdout as string).trim();
    const lines = raw.split("\n").map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) return;

    const screenLine = lines.find(l => l.startsWith("SCREEN:"));
    if (!screenLine) return;
    const [midXStr, midYStr] = screenLine.replace("SCREEN:", "").split(",");
    const midX = parseFloat(midXStr);
    const midY = parseFloat(midYStr);

    const positions: Array<{ tty: string; cx: number; cy: number }> = [];
    for (const line of lines) {
      if (line.startsWith("SCREEN:")) continue;
      const parts = line.split(",");
      if (parts.length < 3) continue;
      positions.push({
        tty: parts[0],
        cx: parseFloat(parts[1]),
        cy: parseFloat(parts[2]),
      });
    }

    const result = new Map<string, number>();
    const usedQuadrants = new Set<number>();

    for (const pos of positions) {
      const isLeft = pos.cx < midX;
      const isTop = pos.cy < midY;
      let q: number;
      if (isTop && isLeft) q = 1;
      else if (isTop && !isLeft) q = 2;
      else if (!isTop && isLeft) q = 3;
      else q = 4;

      if (usedQuadrants.has(q)) {
        const free = [1, 2, 3, 4].filter(n => !usedQuadrants.has(n));
        if (free.length === 0) continue;
        q = free[0];
      }
      result.set(pos.tty, q);
      usedQuadrants.add(q);
    }

    callback(result);
  });
}

/**
 * Set Terminal.app tab titles and window positions to match quadrant assignments.
 * Called whenever quadrant assignments change in writeWorkersFile().
 *
 * Each terminal tab gets titled "Q{N} - {project}" and its window is moved
 * to the corresponding screen quadrant so the physical layout matches the dashboard.
 */
export function arrangeTerminalWindows(slots: QuadrantSlot[]): void {
  if (slots.length === 0) return;

  // Build a fingerprint to skip redundant calls
  const fingerprint = slots
    .map(s => `${s.quadrant}:${s.tty}:${s.projectName}`)
    .sort()
    .join("|");
  if (fingerprint === lastArrangement) return;
  lastArrangement = fingerprint;

  // Build AppleScript that:
  // 1. Gets screen dimensions
  // 2. For each slot, finds the tab by TTY, sets its title, and positions its window
  const tabBlocks = slots.map(slot => {
    const pos = QUADRANT_POSITIONS[slot.quadrant];
    if (!pos) return "";
    const device = slot.tty.startsWith("/dev/") ? slot.tty : `/dev/${slot.tty}`;
    const title = `Q${slot.quadrant} - ${slot.projectName}`;

    return `
    -- Q${slot.quadrant}: ${slot.tty}
    set targetTab to missing value
    set targetWin to missing value
    repeat with w in windows
      repeat with t in tabs of w
        if tty of t is "${device}" then
          set targetTab to t
          set targetWin to w
          exit repeat
        end if
      end repeat
      if targetTab is not missing value then exit repeat
    end repeat
    if targetTab is not missing value then
      set custom title of targetTab to "${title}"
      set title displays custom title of targetTab to true
      set bounds of targetWin to {screenX + ${pos.x} * halfW, screenY + ${pos.y} * halfH + menuBarH, screenX + ${pos.x} * halfW + halfW, screenY + ${pos.y} * halfH + halfH + menuBarH}
    end if
    set targetTab to missing value
    set targetWin to missing value`;
  }).filter(Boolean).join("\n");

  if (!tabBlocks) return;

  const script = `
tell application "Finder"
  set screenBounds to bounds of window of desktop
  set screenX to item 1 of screenBounds
  set screenY to item 2 of screenBounds
  set screenW to item 3 of screenBounds
  set screenH to item 4 of screenBounds
end tell
set menuBarH to 25
set halfW to (screenW - screenX) / 2
set halfH to (screenH - screenY - menuBarH) / 2

tell application "Terminal"
${tabBlocks}
end tell
`;

  execFile("/usr/bin/osascript", ["-e", script], {
    timeout: 10000,
    encoding: "utf-8",
  }, (err) => {
    if (err) {
      const msg = err.message || String(err);
      console.log(`[arrange] Failed to arrange windows: ${msg.slice(0, 150)}`);
    }
  });
}

// Guard: only one title update at a time
let titleInFlight = false;

/**
 * Set Terminal.app tab titles to match quadrant assignments WITHOUT moving windows.
 * Called on every writeWorkersFile() tick so labels stay in sync when windows are dragged.
 * Async (fire-and-forget) — does NOT block the event loop.
 */
export function updateTerminalTitles(slots: QuadrantSlot[]): void {
  if (slots.length === 0) return;
  if (titleInFlight) return; // skip if previous call still running

  const fingerprint = slots
    .map(s => `${s.quadrant}:${s.tty}:${s.projectName}`)
    .sort()
    .join("|");
  if (fingerprint === lastTitleFingerprint) return;
  // Don't set fingerprint yet — only on success, so failures retry next tick

  const tabBlocks = slots.map(slot => {
    const device = slot.tty.startsWith("/dev/") ? slot.tty : `/dev/${slot.tty}`;
    const title = `Q${slot.quadrant} - ${slot.projectName}`;
    return `
    repeat with w in windows
      repeat with t in tabs of w
        if tty of t is "${device}" then
          set custom title of t to "${title}"
          set title displays custom title of t to true
          exit repeat
        end if
      end repeat
    end repeat`;
  }).filter(Boolean).join("\n");

  if (!tabBlocks) return;

  const script = `
tell application "Terminal"
${tabBlocks}
end tell
`;

  titleInFlight = true;
  execFile("/usr/bin/osascript", ["-e", script], {
    timeout: 8000,
    encoding: "utf-8",
  }, (err) => {
    titleInFlight = false;
    if (err) {
      const msg = err.message || String(err);
      console.log(`[arrange] Failed to update titles: ${msg.slice(0, 150)}`);
      // Don't cache fingerprint — retry next tick
    } else {
      lastTitleFingerprint = fingerprint;
    }
  });
}

/**
 * Position a single Terminal window to the given quadrant.
 * Used only on spawn to place new windows in an open corner.
 */
export function positionWindowToQuadrant(tty: string, quadrant: number): void {
  const pos = QUADRANT_POSITIONS[quadrant];
  if (!pos) return;
  const device = tty.startsWith("/dev/") ? tty : `/dev/${tty}`;

  const script = `
tell application "Finder"
  set screenBounds to bounds of window of desktop
  set screenX to item 1 of screenBounds
  set screenY to item 2 of screenBounds
  set screenW to item 3 of screenBounds
  set screenH to item 4 of screenBounds
end tell
set menuBarH to 25
set halfW to (screenW - screenX) / 2
set halfH to (screenH - screenY - menuBarH) / 2

tell application "Terminal"
  repeat with w in windows
    repeat with t in tabs of w
      if tty of t is "${device}" then
        set bounds of w to {screenX + ${pos.x} * halfW, screenY + ${pos.y} * halfH + menuBarH, screenX + ${pos.x} * halfW + halfW, screenY + ${pos.y} * halfH + halfH + menuBarH}
        exit repeat
      end if
    end repeat
  end repeat
end tell
`;

  try {
    execFileSync("/usr/bin/osascript", ["-e", script], {
      timeout: 8000,
      encoding: "utf-8",
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[arrange] Failed to position window: ${msg.slice(0, 150)}`);
  }
}

/**
 * Open a new Terminal.app window, cd to the project, and run the model CLI.
 * Positions the window into the specified quadrant (or first open one).
 *
 * - claude: types `claude` then sends keystroke "1" (to select option 1 from the menu)
 * - codex: types `codex`
 * - openclaw: types `openclaw tui`
 */
export function spawnTerminalWindow(
  project: string,
  model: "claude" | "codex" | "openclaw",
  targetQuadrant?: number,
): { ok: boolean; error?: string } {
  const cdCmd = `cd "${project}"`;
  const launchCmd = model === "claude"
    ? `${cdCmd} && claude`
    : model === "openclaw"
      ? `${cdCmd} && openclaw tui`
      : `${cdCmd} && codex`;

  // If a target quadrant is given, spawn and position in one AppleScript call
  const pos = targetQuadrant ? QUADRANT_POSITIONS[targetQuadrant] : undefined;
  const positionBlock = pos ? `
tell application "Finder"
  set screenBounds to bounds of window of desktop
  set screenX to item 1 of screenBounds
  set screenY to item 2 of screenBounds
  set screenW to item 3 of screenBounds
  set screenH to item 4 of screenBounds
end tell
set menuBarH to 25
set halfW to (screenW - screenX) / 2
set halfH to (screenH - screenY - menuBarH) / 2
` : "";

  const setBoundsLine = pos
    ? `set bounds of front window to {screenX + ${pos.x} * halfW, screenY + ${pos.y} * halfH + menuBarH, screenX + ${pos.x} * halfW + halfW, screenY + ${pos.y} * halfH + halfH + menuBarH}`
    : "";

  const script = `
${positionBlock}
tell application "Terminal"
  do script "${launchCmd.replace(/"/g, '\\"')}"
  activate
  ${setBoundsLine}
end tell
`;

  try {
    execFileSync("/usr/bin/osascript", ["-e", script], {
      timeout: 10000,
      encoding: "utf-8",
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Spawn terminal failed: ${msg.slice(0, 150)}` };
  }

  // For claude, we need to send "1" + Enter after a short delay
  // to select the first option from the CLI menu
  if (model === "claude") {
    setTimeout(() => {
      try {
        // Press "1" key in the frontmost Terminal window
        const selectScript = `
tell application "System Events"
  tell process "Terminal"
    keystroke "1"
    delay 0.3
    key code 36
  end tell
end tell
`;
        execFileSync("/usr/bin/osascript", ["-e", selectScript], {
          timeout: 5000,
          encoding: "utf-8",
        });
      } catch {
        // Non-critical - user can press 1 manually
        console.log("[arrange] Failed to auto-press 1 for claude CLI menu");
      }
    }, 3000); // Wait for claude CLI to show its menu
  }

  return { ok: true };
}
