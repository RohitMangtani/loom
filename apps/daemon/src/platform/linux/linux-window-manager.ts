// Requires tmux to be installed

import { execFileSync } from "child_process";
import { homedir } from "os";
import { join } from "path";
import type { WindowManager, WindowSlot } from "../interfaces.js";

const TMUX_SESSION = "hive";
const TMUX_WINDOW = "swarm";
const HOME = process.env.HOME || homedir();
let lastArrangement = "";

interface PaneInfo {
  paneId: string;
  paneTty: string;
  paneTop: number;
  paneIndex: number;
}

function normalizeTty(tty: string): string {
  return tty.replace(/^\/dev\//, "");
}

function resolveSpawnCommand(model: string, initialMessage?: string): string {
  let cliCmd: string;
  if (model === "claude") cliCmd = "claude --enable-auto-mode";
  else if (model === "codex") cliCmd = "codex";
  else if (model === "openclaw") cliCmd = "openclaw tui";
  else if (model === "gemini") cliCmd = "gemini";
  else {
    try {
      const { readFileSync } = require("fs") as typeof import("fs");
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
    const escaped = initialMessage.replace(/'/g, "'\\''");
    cliCmd += ` '${escaped}'`;
  }

  return cliCmd;
}

function sessionTarget(): string {
  return `${TMUX_SESSION}:${TMUX_WINDOW}`;
}

function runTmux(args: string[]): { ok: boolean; stdout?: string; error?: string } {
  try {
    const stdout = execFileSync("tmux", args, {
      encoding: "utf-8",
      timeout: 10000,
    }) as string;
    return { ok: true, stdout };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg.slice(0, 180) };
  }
}

function sessionExists(): boolean {
  return runTmux(["has-session", "-t", TMUX_SESSION]).ok;
}

function listPanes(): PaneInfo[] {
  const result = runTmux([
    "list-panes",
    "-t",
    sessionTarget(),
    "-F",
    "#{pane_id}\t#{pane_tty}\t#{pane_top}\t#{pane_index}",
  ]);
  if (!result.ok || !result.stdout) return [];

  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split("\t"))
    .filter((parts) => parts[0] && parts[1])
    .map((parts) => ({
      paneId: parts[0],
      paneTty: normalizeTty(parts[1]),
      paneTop: parseInt(parts[2] || "0", 10) || 0,
      paneIndex: parseInt(parts[3] || "0", 10) || 0,
    }))
    .sort((a, b) => (a.paneTop - b.paneTop) || (a.paneIndex - b.paneIndex));
}

function resolvePaneByTty(tty: string): PaneInfo | null {
  const normalized = normalizeTty(tty);
  return listPanes().find((pane) => pane.paneTty === normalized) || null;
}

function applyPaneChrome(): void {
  runTmux(["set-window-option", "-t", sessionTarget(), "automatic-rename", "off"]);
  runTmux(["set-window-option", "-t", sessionTarget(), "pane-border-status", "top"]);
  runTmux(["set-window-option", "-t", sessionTarget(), "pane-border-format", "#{pane_title}"]);
}

function restackPanes(desiredTtys: string[]): void {
  if (desiredTtys.length <= 1) return;

  let panes = listPanes();
  for (let index = 0; index < desiredTtys.length; index += 1) {
    const desiredTty = normalizeTty(desiredTtys[index]);
    const currentPane = panes[index];
    if (!currentPane || currentPane.paneTty === desiredTty) continue;

    const desiredPane = panes.find((pane) => pane.paneTty === desiredTty);
    if (!desiredPane) continue;

    const swapped = runTmux(["swap-pane", "-s", desiredPane.paneId, "-t", currentPane.paneId]);
    if (!swapped.ok) continue;
    panes = listPanes();
  }
}

export class LinuxWindowManager implements WindowManager {
  spawnTerminal(
    project: string,
    model: string,
    quadrant?: number,
    initialMessage?: string,
    _currentAgentCount?: number,
  ): { ok: boolean; tty?: string; error?: string } {
    const spawnCommand = resolveSpawnCommand(model, initialMessage);

    if (!sessionExists()) {
      const created = runTmux([
        "new-session",
        "-d",
        "-P",
        "-F",
        "#{pane_tty}",
        "-s",
        TMUX_SESSION,
        "-n",
        TMUX_WINDOW,
        "-c",
        project,
        spawnCommand,
      ]);
      if (!created.ok) {
        return { ok: false, error: `Spawn terminal failed: ${created.error}` };
      }
      applyPaneChrome();
      lastArrangement = "";
      return { ok: true, tty: created.stdout?.trim() };
    }

    const panes = listPanes();
    if (panes.length === 0) {
      const created = runTmux([
        "new-window",
        "-P",
        "-F",
        "#{pane_tty}",
        "-t",
        TMUX_SESSION,
        "-n",
        TMUX_WINDOW,
        "-c",
        project,
        spawnCommand,
      ]);
      if (!created.ok) {
        return { ok: false, error: `Spawn terminal failed: ${created.error}` };
      }
      applyPaneChrome();
      lastArrangement = "";
      return { ok: true, tty: created.stdout?.trim() };
    }

    const desiredIndex = Math.max(0, Math.min(
      typeof quadrant === "number" ? quadrant - 1 : panes.length,
      panes.length,
    ));
    const targetPane = desiredIndex <= 0
      ? panes[0]
      : panes[Math.min(desiredIndex - 1, panes.length - 1)];

    const splitArgs = desiredIndex <= 0
      ? ["split-window", "-v", "-b", "-P", "-F", "#{pane_tty}", "-t", targetPane.paneId, "-c", project, spawnCommand]
      : ["split-window", "-v", "-P", "-F", "#{pane_tty}", "-t", targetPane.paneId, "-c", project, spawnCommand];

    const created = runTmux(splitArgs);
    if (!created.ok) {
      return { ok: false, error: `Spawn terminal failed: ${created.error}` };
    }

    applyPaneChrome();
    runTmux(["select-layout", "-t", sessionTarget(), "even-vertical"]);
    lastArrangement = "";
    return { ok: true, tty: created.stdout?.trim() };
  }

  closeTerminal(tty: string): { ok: boolean; error?: string } {
    const pane = resolvePaneByTty(tty);
    if (!pane) return { ok: true };

    const killed = runTmux(["kill-pane", "-t", pane.paneId]);
    if (!killed.ok) {
      return { ok: false, error: `Close terminal failed: ${killed.error}` };
    }

    applyPaneChrome();
    runTmux(["select-layout", "-t", sessionTarget(), "even-vertical"]);
    lastArrangement = "";
    return { ok: true };
  }

  arrangeWindows(slots: WindowSlot[], totalAgentCount?: number): void {
    const desired = slots
      .filter((slot) => !!slot.tty)
      .sort((a, b) => a.quadrant - b.quadrant);
    if (desired.length === 0 || !sessionExists()) return;

    const fingerprint = desired
      .map((slot) => `${slot.quadrant}:${normalizeTty(slot.tty)}:${slot.projectName}:${slot.model}`)
      .join("|") + `@${totalAgentCount || desired.length}`;
    if (fingerprint === lastArrangement) return;
    lastArrangement = fingerprint;

    applyPaneChrome();
    runTmux(["select-layout", "-t", sessionTarget(), "even-vertical"]);
    restackPanes(desired.map((slot) => slot.tty));
    runTmux(["select-layout", "-t", sessionTarget(), "even-vertical"]);

    for (const slot of desired) {
      const pane = resolvePaneByTty(slot.tty);
      if (!pane) continue;
      runTmux(["select-pane", "-t", pane.paneId, "-T", `Q${slot.quadrant} - ${slot.projectName}`]);
    }
  }

  resetArrangement(): void {
    lastArrangement = "";
  }

  detectQuadrants(
    ttys: string[],
    callback: (result: Map<string, number>, rawSlots?: Map<string, number>) => void,
  ): void {
    if (ttys.length === 0) return;
    if (!sessionExists()) return;

    // Query tmux for pane positions: index, pid, top offset, left offset, width, height
    const raw = runTmux([
      "list-panes",
      "-t",
      sessionTarget(),
      "-F",
      "#{pane_index}\t#{pane_pid}\t#{pane_top}\t#{pane_left}\t#{pane_width}\t#{pane_height}\t#{pane_tty}",
    ]);
    if (!raw.ok || !raw.stdout) return;

    const panes = raw.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const parts = line.split("\t");
        return {
          index: parseInt(parts[0] || "0", 10),
          pid: parseInt(parts[1] || "0", 10),
          top: parseInt(parts[2] || "0", 10),
          left: parseInt(parts[3] || "0", 10),
          width: parseInt(parts[4] || "0", 10),
          height: parseInt(parts[5] || "0", 10),
          tty: normalizeTty(parts[6] || ""),
        };
      });

    if (panes.length === 0) return;

    // Build a lookup from normalized TTY to pane info
    const ttySet = new Set(ttys.map(normalizeTty));
    const matchedPanes = panes.filter((p) => ttySet.has(p.tty));
    if (matchedPanes.length === 0) return;

    // Sort by vertical position (top offset), then horizontal (left offset)
    matchedPanes.sort((a, b) => (a.top - b.top) || (a.left - b.left));

    // Assign quadrant slots 1..N based on sorted position (same grid logic as macOS:
    // vertical stack, topmost pane = Q1, next = Q2, etc.)
    const result = new Map<string, number>();
    const rawSlots = new Map<string, number>();
    const usedSlots = new Set<number>();

    for (const pane of matchedPanes) {
      // Find the original TTY string that matches this pane
      const originalTty = ttys.find((t) => normalizeTty(t) === pane.tty);
      if (!originalTty) continue;

      const naturalSlot = matchedPanes.indexOf(pane) + 1;
      rawSlots.set(originalTty, naturalSlot);

      let q = naturalSlot;
      if (usedSlots.has(q)) {
        // Collision: find next free slot
        for (let s = 1; s <= matchedPanes.length; s++) {
          if (!usedSlots.has(s)) { q = s; break; }
        }
      }
      result.set(originalTty, q);
      usedSlots.add(q);
    }

    callback(result, rawSlots);
  }
}
