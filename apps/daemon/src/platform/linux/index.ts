import { LinuxProcessDiscoverer } from "./linux-process-discoverer.js";
import { LinuxTerminalIO } from "./linux-terminal-io.js";
import { LinuxWindowManager } from "./linux-window-manager.js";
import type { ProcessDiscoverer, TerminalIO, WindowManager } from "../interfaces.js";

export function createLinuxPlatform(): { terminal: TerminalIO; discovery: ProcessDiscoverer; windows: WindowManager } {
  return {
    terminal: new LinuxTerminalIO(),
    discovery: new LinuxProcessDiscoverer(),
    windows: new LinuxWindowManager(),
  };
}
