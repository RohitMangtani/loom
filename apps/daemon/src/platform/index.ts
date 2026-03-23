import { platform } from "os";
import { createLinuxPlatform } from "./linux/index.js";
import { createMacOSPlatform } from "./macos/index.js";
import type { LoadedPlatform } from "./interfaces.js";

export function loadPlatform(): LoadedPlatform {
  return platform() === "linux"
    ? createLinuxPlatform()
    : createMacOSPlatform();
}
