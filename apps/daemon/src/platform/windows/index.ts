import { WindowsProcessDiscoverer } from "./windows-process-discoverer.js";
import { WindowsTerminalIO } from "./windows-terminal-io.js";
import { WindowsWindowManager } from "./windows-window-manager.js";
import type { LoadedPlatform } from "../interfaces.js";

export function createWindowsPlatform(): LoadedPlatform {
  return {
    terminal: new WindowsTerminalIO(),
    discovery: new WindowsProcessDiscoverer(),
    windows: new WindowsWindowManager(),
  };
}
