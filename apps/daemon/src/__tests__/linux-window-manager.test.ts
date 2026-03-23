import { beforeEach, describe, expect, it, vi } from "vitest";

const { execFileSync } = vi.hoisted(() => ({
  execFileSync: vi.fn(),
}));

vi.mock("child_process", () => ({
  execFileSync,
}));

import { LinuxWindowManager } from "../platform/linux/linux-window-manager.js";

describe("LinuxWindowManager", () => {
  beforeEach(() => {
    execFileSync.mockReset();
  });

  it("spawns additional agents as panes in the shared tmux swarm window", () => {
    execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      switch (args[0]) {
        case "has-session":
          return "";
        case "list-panes":
          return "%1\t/dev/pts/0\t0\t0\n";
        case "split-window":
          return "/dev/pts/1\n";
        default:
          return "";
      }
    });

    const manager = new LinuxWindowManager();
    const result = manager.spawnTerminal("/tmp/demo", "codex", 2);

    expect(result).toEqual({ ok: true, tty: "/dev/pts/1" });
    expect(execFileSync).toHaveBeenCalledWith(
      "tmux",
      expect.arrayContaining(["split-window", "-v", "-P", "-F", "#{pane_tty}"]),
      expect.objectContaining({ encoding: "utf-8" }),
    );
    expect(execFileSync).not.toHaveBeenCalledWith(
      "tmux",
      expect.arrayContaining(["new-window"]),
      expect.anything(),
    );
  });

  it("kills panes instead of whole tmux windows", () => {
    execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      switch (args[0]) {
        case "list-panes":
          return "%2\t/dev/pts/2\t0\t1\n";
        default:
          return "";
      }
    });

    const manager = new LinuxWindowManager();
    const result = manager.closeTerminal("pts/2");

    expect(result).toEqual({ ok: true });
    expect(execFileSync).toHaveBeenCalledWith(
      "tmux",
      ["kill-pane", "-t", "%2"],
      expect.objectContaining({ encoding: "utf-8" }),
    );
    expect(execFileSync).not.toHaveBeenCalledWith(
      "tmux",
      expect.arrayContaining(["kill-window"]),
      expect.anything(),
    );
  });
});
