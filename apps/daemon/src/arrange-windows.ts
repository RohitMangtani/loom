import { execFile, execFileSync } from "child_process";
import { ProcessDiscovery } from "./discovery.js";

interface QuadrantSlot {
  quadrant: number;
  tty: string;
  projectName: string;
  model: string;
}

/** Grid formations for each agent count.
 *  Each formation defines cols, rows, and slot positions (x=col, y=row indices). */
const MAX_SLOTS = 8;

interface GridFormation {
  cols: number;
  rows: number;
  positions: Record<number, { x: number; y: number }>;
}

const FORMATIONS: Record<number, GridFormation> = {
  1: { cols: 1, rows: 1, positions: { 1: { x: 0, y: 0 } } },
  2: { cols: 2, rows: 1, positions: { 1: { x: 0, y: 0 }, 2: { x: 1, y: 0 } } },
  3: { cols: 2, rows: 2, positions: { 1: { x: 0, y: 0 }, 2: { x: 1, y: 0 }, 3: { x: 0, y: 1 } } },
  4: { cols: 2, rows: 2, positions: { 1: { x: 0, y: 0 }, 2: { x: 1, y: 0 }, 3: { x: 0, y: 1 }, 4: { x: 1, y: 1 } } },
  5: { cols: 3, rows: 2, positions: { 1: { x: 0, y: 0 }, 2: { x: 1, y: 0 }, 3: { x: 2, y: 0 }, 4: { x: 0, y: 1 }, 5: { x: 1, y: 1 } } },
  6: { cols: 3, rows: 2, positions: { 1: { x: 0, y: 0 }, 2: { x: 1, y: 0 }, 3: { x: 2, y: 0 }, 4: { x: 0, y: 1 }, 5: { x: 1, y: 1 }, 6: { x: 2, y: 1 } } },
  7: { cols: 4, rows: 2, positions: { 1: { x: 0, y: 0 }, 2: { x: 1, y: 0 }, 3: { x: 2, y: 0 }, 4: { x: 3, y: 0 }, 5: { x: 0, y: 1 }, 6: { x: 1, y: 1 }, 7: { x: 2, y: 1 } } },
  8: { cols: 4, rows: 2, positions: { 1: { x: 0, y: 0 }, 2: { x: 1, y: 0 }, 3: { x: 2, y: 0 }, 4: { x: 3, y: 0 }, 5: { x: 0, y: 1 }, 6: { x: 1, y: 1 }, 7: { x: 2, y: 1 }, 8: { x: 3, y: 1 } } },
};

function getFormation(agentCount: number): GridFormation {
  return FORMATIONS[Math.max(1, Math.min(agentCount, MAX_SLOTS))];
}

// Backwards-compatible accessor used by spawnTerminalWindow and arrangeTerminalWindows
function getSlotPosition(slot: number, agentCount: number): { x: number; y: number } | undefined {
  return getFormation(agentCount).positions[slot];
}

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
    const usedSlots = new Set<number>();

    // Use the formation matching the number of detected agents
    const formation = getFormation(positions.length);
    const cellW = midX * 2 / formation.cols;
    const cellH = midY * 2 / formation.rows;

    for (const pos of positions) {
      const col = Math.min(Math.floor(pos.cx / cellW), formation.cols - 1);
      const row = Math.min(Math.floor(pos.cy / cellH), formation.rows - 1);
      // Find the slot whose position matches this col/row
      let q = 0;
      for (const [slot, spos] of Object.entries(formation.positions)) {
        if (spos.x === col && spos.y === row) { q = Number(slot); break; }
      }
      if (!q) q = 1; // fallback

      if (usedSlots.has(q)) {
        const allSlots = Object.keys(formation.positions).map(Number);
        const free = allSlots.filter(n => !usedSlots.has(n));
        if (free.length === 0) continue;
        q = free[0];
      }
      result.set(pos.tty, q);
      usedSlots.add(q);
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
  const formation = getFormation(slots.length);

  const tabBlocks = slots.map(slot => {
    const pos = getSlotPosition(slot.quadrant, slots.length);
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
      set bounds of targetWin to {screenX + ${pos.x} * cellW, screenY + ${pos.y} * cellH + menuBarH, screenX + ${pos.x} * cellW + cellW, screenY + ${pos.y} * cellH + cellH + menuBarH}
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
set cellW to (screenW - screenX) / ${formation.cols}
set cellH to (screenH - screenY - menuBarH) / ${formation.rows}

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
export function positionWindowToQuadrant(tty: string, quadrant: number, agentCount?: number): void {
  const count = agentCount || 4;
  const pos = getSlotPosition(quadrant, count);
  if (!pos) return;
  const formation = getFormation(count);
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
set cellW to (screenW - screenX) / ${formation.cols}
set cellH to (screenH - screenY - menuBarH) / ${formation.rows}

tell application "Terminal"
  repeat with w in windows
    repeat with t in tabs of w
      if tty of t is "${device}" then
        set bounds of w to {screenX + ${pos.x} * cellW, screenY + ${pos.y} * cellH + menuBarH, screenX + ${pos.x} * cellW + cellW, screenY + ${pos.y} * cellH + cellH + menuBarH}
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
 * - custom agents: uses spawnCommand from ~/.hive/agents.json
 */
export function spawnTerminalWindow(
  project: string,
  model: string,
  targetQuadrant?: number,
  initialMessage?: string,
  currentAgentCount?: number,
): { ok: boolean; error?: string } {
  const cdCmd = `cd "${project}"`;
  let cliCmd: string;
  if (model === "claude") cliCmd = "claude";
  else if (model === "codex") cliCmd = "codex";
  else if (model === "openclaw") cliCmd = "openclaw tui";
  else {
    const custom = ProcessDiscovery.getCustomAgent(model);
    cliCmd = custom?.spawnCommand || model;
  }
  const launchCmd = `${cdCmd} && ${cliCmd}`;

  // If a target quadrant is given, spawn and position in one AppleScript call.
  // Capture the tab reference from `do script` and use `window of newTab`
  // instead of `front window` to avoid race conditions with `activate`.
  // Use formation for (currentAgentCount + 1) since we're adding one
  const newCount = (currentAgentCount || 0) + 1;
  const formation = getFormation(newCount);
  const pos = targetQuadrant ? getSlotPosition(targetQuadrant, newCount) : undefined;
  const positionBlock = pos ? `
tell application "Finder"
  set screenBounds to bounds of window of desktop
  set screenX to item 1 of screenBounds
  set screenY to item 2 of screenBounds
  set screenW to item 3 of screenBounds
  set screenH to item 4 of screenBounds
end tell
set menuBarH to 25
set cellW to (screenW - screenX) / ${formation.cols}
set cellH to (screenH - screenY - menuBarH) / ${formation.rows}
` : "";

  const setBoundsLine = pos
    ? `set bounds of window of newTab to {screenX + ${pos.x} * cellW, screenY + ${pos.y} * cellH + menuBarH, screenX + ${pos.x} * cellW + cellW, screenY + ${pos.y} * cellH + cellH + menuBarH}`
    : "";

  const script = `
${positionBlock}
tell application "Terminal"
  set newTab to do script "${launchCmd.replace(/"/g, '\\"')}"
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

  // Both Claude and Codex show a startup menu that needs auto-bypass.
  // Claude: press "1" + Enter to select first project option.
  // Codex: press "1" + Enter to accept/select first option.
  // After the menu is cleared, type the initial message.
  const needsMenuBypass = model === "claude" || model === "codex";

  if (needsMenuBypass) {
    setTimeout(() => {
      try {
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
        console.log(`[arrange] Failed to auto-press 1 for ${model} CLI menu`);
      }

      if (initialMessage) {
        setTimeout(() => {
          try {
            const escaped = initialMessage.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
            const msgScript = `
tell application "System Events"
  tell process "Terminal"
    keystroke "${escaped}"
    delay 0.2
    key code 36
  end tell
end tell
`;
            execFileSync("/usr/bin/osascript", ["-e", msgScript], {
              timeout: 5000,
              encoding: "utf-8",
            });
          } catch {
            console.log(`[arrange] Failed to type initial message for ${model}`);
          }
        }, 4000);
      }
    }, 3000);
  } else {
    // For openclaw / custom: just wait for CLI to start, then type the message
    if (initialMessage) {
      setTimeout(() => {
        try {
          const escaped = initialMessage.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
          const msgScript = `
tell application "System Events"
  tell process "Terminal"
    keystroke "${escaped}"
    delay 0.2
    key code 36
  end tell
end tell
`;
          execFileSync("/usr/bin/osascript", ["-e", msgScript], {
            timeout: 5000,
            encoding: "utf-8",
          });
        } catch {
          console.log(`[arrange] Failed to type initial message for ${model}`);
        }
      }, 5000);
    }
  }

  return { ok: true };
}
