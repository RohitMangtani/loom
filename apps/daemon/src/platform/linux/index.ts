import { LinuxProcessDiscoverer } from "./linux-process-discoverer.js";
import { LinuxTerminalIO } from "./linux-terminal-io.js";
import { LinuxWindowManager } from "./linux-window-manager.js";
import type { LoadedPlatform } from "../interfaces.js";

export function createLinuxPlatform(): LoadedPlatform {
  return {
    terminal: new LinuxTerminalIO(),
    discovery: new LinuxProcessDiscoverer(),
    windows: new LinuxWindowManager(),
  };
}
