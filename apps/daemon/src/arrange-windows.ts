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

/** Vertical stack: 1 column, N rows. Each agent is a full-width horizontal strip. */
const FORMATIONS: Record<number, GridFormation> = {
  1: { cols: 1, rows: 1, positions: { 1: { x: 0, y: 0 } } },
  2: { cols: 1, rows: 2, positions: { 1: { x: 0, y: 0 }, 2: { x: 0, y: 1 } } },
  3: { cols: 1, rows: 3, positions: { 1: { x: 0, y: 0 }, 2: { x: 0, y: 1 }, 3: { x: 0, y: 2 } } },
  4: { cols: 1, rows: 4, positions: { 1: { x: 0, y: 0 }, 2: { x: 0, y: 1 }, 3: { x: 0, y: 2 }, 4: { x: 0, y: 3 } } },
  5: { cols: 1, rows: 5, positions: { 1: { x: 0, y: 0 }, 2: { x: 0, y: 1 }, 3: { x: 0, y: 2 }, 4: { x: 0, y: 3 }, 5: { x: 0, y: 4 } } },
  6: { cols: 1, rows: 6, positions: { 1: { x: 0, y: 0 }, 2: { x: 0, y: 1 }, 3: { x: 0, y: 2 }, 4: { x: 0, y: 3 }, 5: { x: 0, y: 4 }, 6: { x: 0, y: 5 } } },
  7: { cols: 1, rows: 7, positions: { 1: { x: 0, y: 0 }, 2: { x: 0, y: 1 }, 3: { x: 0, y: 2 }, 4: { x: 0, y: 3 }, 5: { x: 0, y: 4 }, 6: { x: 0, y: 5 }, 7: { x: 0, y: 6 } } },
  8: { cols: 1, rows: 8, positions: { 1: { x: 0, y: 0 }, 2: { x: 0, y: 1 }, 3: { x: 0, y: 2 }, 4: { x: 0, y: 3 }, 5: { x: 0, y: 4 }, 6: { x: 0, y: 5 }, 7: { x: 0, y: 6 }, 8: { x: 0, y: 7 } } },
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

/** Reset the arrangement cache so the next arrangeTerminalWindows() call fires. */
export function resetArrangementCache(): void {
  lastArrangement = "";
  lastTitleFingerprint = "";
}

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
  callback: (result: Map<string, number>, rawSlots?: Map<string, number>) => void,
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
    const rawSlots = new Map<string, number>(); // natural slot per tty, no collision resolution
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

      // Store the natural (pre-collision) slot for drift detection
      rawSlots.set(pos.tty, q);

      if (usedSlots.has(q)) {
        const allSlots = Object.keys(formation.positions).map(Number);
        const free = allSlots.filter(n => !usedSlots.has(n));
        if (free.length === 0) continue;
        q = free[0];
      }
      result.set(pos.tty, q);
      usedSlots.add(q);
    }

    callback(result, rawSlots);
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
 * - gemini: types `gemini`
 * - custom agents: uses spawnCommand from ~/.hive/agents.json
 */
export function spawnTerminalWindow(
  project: string,
  model: string,
  targetQuadrant?: number,
  initialMessage?: string,
  currentAgentCount?: number,
): { ok: boolean; error?: string; tty?: string } {
  const cdCmd = `cd "${project}"`;
  let cliCmd: string;
  if (model === "claude") cliCmd = "claude";
  else if (model === "codex") cliCmd = "codex";
  else if (model === "openclaw") cliCmd = "openclaw tui";
  else if (model === "gemini") cliCmd = "gemini";
  else {
    const custom = ProcessDiscovery.getCustomAgent(model);
    cliCmd = custom?.spawnCommand || model;
  }

  // Append initial message as a CLI argument when supported.
  // Claude: positional prompt argument
  // Codex/OpenClaw/Gemini: no CLI prompt arg, message sent via TTY after startup
  if (initialMessage) {
    const escaped = initialMessage.replace(/'/g, "'\\''");
    if (model === "claude") cliCmd += ` '${escaped}'`;
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

  // Return the TTY of the new tab so the caller can create an immediate
  // worker entry before discovery's 3-second scan picks it up.
  const script = `
${positionBlock}
tell application "Terminal"
  set newTab to do script "${launchCmd.replace(/"/g, '\\"')}"
  activate
  ${setBoundsLine}
  set newTty to tty of newTab
  return newTty
end tell
`;

  try {
    const result = execFileSync("/usr/bin/osascript", ["-e", script], {
      timeout: 10000,
      encoding: "utf-8",
    });
    const tty = (result as string).trim() || undefined;
    return { ok: true, tty };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Spawn terminal failed: ${msg.slice(0, 150)}` };
  }
}

/**
 * Close the Terminal.app window/tab for a given TTY device.
 * If the window has only one tab, closes the whole window.
 * If it has multiple tabs, closes just the tab.
 */
export function closeTerminalWindow(tty: string): { ok: boolean; error?: string } {
  const device = tty.startsWith("/dev/") ? tty : `/dev/${tty}`;

  const script = `
tell application "Terminal"
  repeat with w in windows
    repeat with t in tabs of w
      if tty of t is "${device}" then
        if (count of tabs of w) is 1 then
          close w
        else
          close t
        end if
        return "closed"
      end if
    end repeat
  end repeat
  return "not_found"
end tell
`;

  try {
    const result = execFileSync("/usr/bin/osascript", ["-e", script], {
      timeout: 5000,
      encoding: "utf-8",
    });
    const out = (result as string).trim();
    if (out === "not_found") {
      return { ok: true }; // Already gone — not an error
    }
    return { ok: true };
  } catch (err: unknown) {
    // osascript failed — likely missing Automation permission.
    // Fallback: SIGKILL all remaining processes on the TTY (the agent
    // is already dead from the kill handler). This kills the shell too,
    // and Terminal.app auto-closes the tab when no processes remain.
    try {
      const output = execFileSync("/usr/sbin/lsof", ["-t", device], {
        timeout: 3000,
        encoding: "utf-8",
      });
      const pids = output
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((p) => parseInt(p, 10))
        .filter((p) => !isNaN(p) && p !== process.pid);
      for (const pid of pids) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
      if (pids.length > 0) return { ok: true };
    } catch {
      /* lsof also failed */
    }

    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Close terminal failed: ${msg.slice(0, 150)}` };
  }
}
