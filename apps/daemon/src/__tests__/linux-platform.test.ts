/**
 * Linux platform hardening tests.
 *
 * Verifies tmux-based terminal I/O, process discovery, and window management
 * handle edge cases gracefully: missing tmux, dead panes, stale sessions,
 * empty output, concurrent sends, and /proc failures.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock child_process before imports
const mockExecFileSync = vi.fn();
const mockExecFile = vi.fn();
vi.mock("child_process", () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
  execFile: (...args: unknown[]) => mockExecFile(...args),
}));

// Mock fs for process discoverer
const mockReadFileSync = vi.fn(() => "");
const mockReaddirSync = vi.fn(() => [] as string[]);
const mockReadlinkSync = vi.fn(() => "");
const mockRealpathSync = vi.fn(() => "/home/user/project");
const mockExistsSync = vi.fn(() => false);
const mockStatSync = vi.fn(() => ({ mtimeMs: Date.now(), birthtimeMs: Date.now(), isDirectory: () => false }));
vi.mock("fs", () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
  readdirSync: (...args: unknown[]) => mockReaddirSync(...args),
  readlinkSync: (...args: unknown[]) => mockReadlinkSync(...args),
  realpathSync: (...args: unknown[]) => mockRealpathSync(...args),
  statSync: (...args: unknown[]) => mockStatSync(...args),
}));

import { LinuxTerminalIO } from "../platform/linux/linux-terminal-io.js";
import { LinuxProcessDiscoverer } from "../platform/linux/linux-process-discoverer.js";
import { LinuxWindowManager } from "../platform/linux/linux-window-manager.js";

describe("LinuxTerminalIO", () => {
  let terminal: LinuxTerminalIO;

  beforeEach(() => {
    terminal = new LinuxTerminalIO();
    mockExecFileSync.mockReset();
    mockExecFile.mockReset();
  });

  it("sends text via tmux send-keys with Enter", () => {
    // list-panes returns a matching pane
    mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (args[0] === "list-panes") return "hive\t%0\tpts/1\n";
      return "";
    });

    const result = terminal.sendText("pts/1", "fix the bug");
    expect(result.ok).toBe(true);
    // Should have called send-keys twice: once for text, once for Enter
    const sendKeysCalls = mockExecFileSync.mock.calls.filter(
      (c: unknown[]) => Array.isArray(c[1]) && (c[1] as string[]).includes("send-keys")
    );
    expect(sendKeysCalls.length).toBe(2);
  });

  it("returns error when tmux pane not found", () => {
    mockExecFileSync.mockImplementation(() => "");
    const result = terminal.sendText("pts/99", "hello");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("TTY not found");
  });

  it("returns error on empty message", () => {
    const result = terminal.sendText("pts/1", "   ");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Empty");
  });

  it("handles tmux not installed gracefully", () => {
    mockExecFileSync.mockImplementation(() => { throw new Error("command not found: tmux"); });
    const result = terminal.sendText("pts/1", "test");
    expect(result.ok).toBe(false);
  });

  it("reads pane content via capture-pane", () => {
    mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (args[0] === "list-panes") return "hive\t%0\tpts/1\n";
      if (args[0] === "capture-pane") return "$ claude\nWorking on task...\n";
      return "";
    });

    const content = terminal.readContent("pts/1");
    expect(content).toContain("Working on task");
  });

  it("returns null for readContent when pane gone", () => {
    mockExecFileSync.mockImplementation(() => "");
    expect(terminal.readContent("pts/99")).toBeNull();
  });

  it("sends selection via Down arrows + Enter", () => {
    mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (args[0] === "list-panes") return "hive\t%0\tpts/1\n";
      return "";
    });

    const result = terminal.sendSelection("pts/1", 2);
    expect(result.ok).toBe(true);
    // Should send Down, Down, then Enter
    const sendKeysCalls = mockExecFileSync.mock.calls.filter(
      (c: unknown[]) => Array.isArray(c[1]) && (c[1] as string[]).includes("send-keys")
    );
    expect(sendKeysCalls.length).toBe(2); // downs + enter
  });

  it("isSendInFlight returns false when idle", () => {
    expect(terminal.isSendInFlight()).toBe(false);
  });
});

describe("LinuxProcessDiscoverer", () => {
  let discoverer: LinuxProcessDiscoverer;

  beforeEach(() => {
    discoverer = new LinuxProcessDiscoverer();
    mockExecFileSync.mockReset();
    mockReadFileSync.mockReset();
    mockReaddirSync.mockReset();
    mockRealpathSync.mockReset();
    mockExistsSync.mockReset();
  });

  it("discovers claude process from ps output", () => {
    mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "ps") {
        return "  PID  %CPU                  STARTED TTY      COMMAND\n" +
               " 1234  5.2 Sun Mar 23 01:00:00 2026 pts/1    claude\n";
      }
      return "";
    });
    mockRealpathSync.mockReturnValue("/home/user/project");
    mockReaddirSync.mockReturnValue([]);

    const procs = discoverer.findAgentProcesses();
    expect(procs).toHaveLength(1);
    expect(procs[0].model).toBe("claude");
    expect(procs[0].pid).toBe(1234);
    expect(procs[0].tty).toBe("pts/1");
  });

  it("discovers codex process", () => {
    mockExecFileSync.mockImplementation((cmd: string) => {
      if (cmd === "ps") {
        return "  PID  %CPU                  STARTED TTY      COMMAND\n" +
               " 5678  2.1 Sun Mar 23 02:00:00 2026 pts/2    codex\n";
      }
      return "";
    });
    mockRealpathSync.mockReturnValue("/home/user/project");
    mockReaddirSync.mockReturnValue([]);

    const procs = discoverer.findAgentProcesses();
    expect(procs).toHaveLength(1);
    expect(procs[0].model).toBe("codex");
  });

  it("skips processes on TTY ?", () => {
    mockExecFileSync.mockImplementation((cmd: string) => {
      if (cmd === "ps") {
        return "  PID  %CPU                  STARTED TTY      COMMAND\n" +
               " 1234  5.2 Sun Mar 23 01:00:00 2026 ?        claude\n";
      }
      return "";
    });

    const procs = discoverer.findAgentProcesses();
    expect(procs).toHaveLength(0);
  });

  it("skips daemon's own PID", () => {
    mockExecFileSync.mockImplementation((cmd: string) => {
      if (cmd === "ps") {
        return "  PID  %CPU                  STARTED TTY      COMMAND\n" +
               `${process.pid}  5.2 Sun Mar 23 01:00:00 2026 pts/1    claude\n`;
      }
      return "";
    });

    const procs = discoverer.findAgentProcesses();
    expect(procs).toHaveLength(0);
  });

  it("deduplicates by TTY", () => {
    mockExecFileSync.mockImplementation((cmd: string) => {
      if (cmd === "ps") {
        return "  PID  %CPU                  STARTED TTY      COMMAND\n" +
               " 1234  5.2 Sun Mar 23 01:00:00 2026 pts/1    node claude\n" +
               " 1235  3.0 Sun Mar 23 01:00:00 2026 pts/1    claude\n";
      }
      return "";
    });
    mockRealpathSync.mockReturnValue("/home/user/project");
    mockReaddirSync.mockReturnValue([]);

    const procs = discoverer.findAgentProcesses();
    expect(procs).toHaveLength(1);
  });

  it("returns empty on ps failure", () => {
    mockExecFileSync.mockImplementation(() => { throw new Error("ps not found"); });
    expect(discoverer.findAgentProcesses()).toEqual([]);
  });

  it("gets CPU for a PID", () => {
    mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "ps" && (args as string[]).includes("%cpu=")) return "15.3";
      return "";
    });
    expect(discoverer.getCpu(1234)).toBe(15.3);
  });

  it("returns 0 CPU on failure", () => {
    mockExecFileSync.mockImplementation(() => { throw new Error("no such process"); });
    expect(discoverer.getCpu(99999)).toBe(0);
  });

  it("reads PTY offset from /proc/PID/fdinfo/1", () => {
    mockReadFileSync.mockReturnValue("pos:\t12345\nflags:\t0100002\n");
    expect(discoverer.getPtyOffset(1234)).toBe(12345);
  });

  it("returns null PTY offset on failure", () => {
    mockReadFileSync.mockImplementation(() => { throw new Error("no such file"); });
    expect(discoverer.getPtyOffset(99999)).toBeNull();
  });
});

describe("LinuxWindowManager", () => {
  let wm: LinuxWindowManager;

  beforeEach(() => {
    wm = new LinuxWindowManager();
    mockExecFileSync.mockReset();
  });

  it("creates tmux session on first spawn", () => {
    let callCount = 0;
    mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      callCount++;
      if (args[0] === "has-session") throw new Error("no session");
      if (args[0] === "new-session") return "pts/3\n";
      return "";
    });

    const result = wm.spawnTerminal("/home/user/project", "claude");
    expect(result.ok).toBe(true);
    expect(result.tty).toBe("pts/3");
  });

  it("splits pane for additional agents", () => {
    mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (args[0] === "has-session") return "";
      if (args[0] === "list-panes") return "%0\tpts/1\t0\t0\n";
      if (args[0] === "split-window") return "pts/4\n";
      return "";
    });

    const result = wm.spawnTerminal("/home/user/project", "codex");
    expect(result.ok).toBe(true);
    expect(result.tty).toBe("pts/4");
  });

  it("closes terminal by killing tmux pane", () => {
    mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (args[0] === "list-panes") return "%0\tpts/1\t0\t0\n";
      return "";
    });

    const result = wm.closeTerminal("pts/1");
    expect(result.ok).toBe(true);
  });

  it("handles close of nonexistent pane gracefully", () => {
    mockExecFileSync.mockImplementation(() => "");
    const result = wm.closeTerminal("pts/99");
    expect(result.ok).toBe(true); // no-op is success
  });

  it("handles tmux not installed on spawn", () => {
    mockExecFileSync.mockImplementation(() => { throw new Error("command not found: tmux"); });
    const result = wm.spawnTerminal("/home/user/project", "claude");
    expect(result.ok).toBe(false);
  });
});
