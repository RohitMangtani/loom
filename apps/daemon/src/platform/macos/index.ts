import { execFile } from "child_process";
import { promisify } from "util";
import { ProcessDiscovery } from "../../discovery.js";
import { arrangeTerminalWindows, closeTerminalWindow, spawnTerminalWindow } from "../../arrange-windows.js";
import {
  isSendInFlight,
  sendEnterToTtyAsync,
  sendInputToTtyAsync,
  sendSelectionToTty,
} from "../../tty-input.js";
import type { DiscoveredProcess, ProcessDiscoverer, TerminalIO, WindowManager } from "../interfaces.js";

const execFileAsync = promisify(execFile);

interface MacProcessShape {
  pid: number;
  cpuPercent: number;
  startedAt: number;
  tty: string;
  cwd: string;
  model?: string;
  sessionIds: string[];
  jsonlFile: string | null;
}

interface MacDiscoveryShape {
  findClaudeProcesses(): MacProcessShape[];
  getCpuForPid(pid: number): number;
  readTerminalContent(tty: string): string | null;
}

function createDiscoveryAdapter(): MacDiscoveryShape {
  return new ProcessDiscovery({} as never, {} as never) as unknown as MacDiscoveryShape;
}

async function sendArrowKeyToTty(tty: string, key: "up" | "down"): Promise<{ ok: boolean; error?: string }> {
  const device = tty.startsWith("/dev/") ? tty : `/dev/${tty}`;
  const keyCode = key === "down" ? 125 : 126;

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
delay 0.3
tell application "System Events"
  tell process "Terminal"
    key code ${keyCode}
  end tell
end tell
`;

  try {
    await execFileAsync("/usr/bin/osascript", ["-e", script], {
      timeout: 8000,
      encoding: "utf-8",
    });
    return { ok: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Keystroke failed: ${msg.slice(0, 180)}` };
  }
}

class MacOSTerminalIO implements TerminalIO {
  constructor(private readonly discovery: MacDiscoveryShape) {}

  sendText(tty: string, text: string): Promise<{ ok: boolean; error?: string }> {
    return sendInputToTtyAsync(tty, text);
  }

  sendKeystroke(tty: string, key: "enter" | "down" | "up"): Promise<{ ok: boolean; error?: string }> {
    if (key === "enter") return sendEnterToTtyAsync(tty);
    return sendArrowKeyToTty(tty, key);
  }

  async sendSelection(tty: string, optionIndex: number): Promise<{ ok: boolean; error?: string }> {
    return sendSelectionToTty(tty, optionIndex);
  }

  readContent(tty: string): string | null {
    return this.discovery.readTerminalContent(tty);
  }

  isSendInFlight(): boolean {
    return isSendInFlight();
  }
}

class MacOSProcessDiscoverer implements ProcessDiscoverer {
  constructor(private readonly discovery: MacDiscoveryShape) {}

  findAgentProcesses(): DiscoveredProcess[] {
    return this.discovery.findClaudeProcesses().map((proc) => ({
      pid: proc.pid,
      cpuPercent: proc.cpuPercent,
      startedAt: proc.startedAt,
      tty: proc.tty,
      cwd: proc.cwd,
      model: proc.model || "claude",
      sessionIds: proc.sessionIds,
      jsonlFile: proc.jsonlFile,
    }));
  }

  getCpu(pid: number): number {
    return this.discovery.getCpuForPid(pid);
  }

  getPtyOffset(pid: number): number | null {
    try {
      const { execFileSync } = require("child_process") as typeof import("child_process");
      const out = execFileSync("lsof", ["-a", "-p", String(pid), "-d", "1"], {
        encoding: "utf-8",
        timeout: 2000,
      }).trim();
      const lastLine = out.split("\n").pop();
      if (!lastLine) return null;
      const fields = lastLine.trim().split(/\s+/);
      const offsetStr = fields[6] || "";
      const offset = parseInt(offsetStr.replace(/^0t/, ""), 10);
      return Number.isNaN(offset) ? null : offset;
    } catch {
      return null;
    }
  }
}

class MacOSWindowManager implements WindowManager {
  async spawnTerminal(project: string, model: string, quadrant?: number): Promise<string> {
    const result = spawnTerminalWindow(project, model, quadrant);
    if (!result.ok || !result.tty) {
      throw new Error(result.error || "Failed to spawn Terminal.app window");
    }
    return result.tty;
  }

  async closeTerminal(tty: string): Promise<void> {
    const result = closeTerminalWindow(tty);
    if (!result.ok) {
      throw new Error(result.error || "Failed to close Terminal.app window");
    }
  }

  arrangeWindows(slots: Array<{ tty: string; quadrant: number; projectName: string; model: string }>): void {
    arrangeTerminalWindows(slots);
  }
}

export function createMacOSPlatform(): { terminal: TerminalIO; discovery: ProcessDiscoverer; windows: WindowManager } {
  const discovery = createDiscoveryAdapter();
  return {
    terminal: new MacOSTerminalIO(discovery),
    discovery: new MacOSProcessDiscoverer(discovery),
    windows: new MacOSWindowManager(),
  };
}
