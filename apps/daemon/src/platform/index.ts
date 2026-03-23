import { platform } from "os";
import { createLinuxPlatform } from "./linux/index.js";
import { createMacOSPlatform } from "./macos/index.js";
import type { LoadedPlatform } from "./interfaces.js";

function createPlatform(): LoadedPlatform {
  return platform() === "linux"
    ? createLinuxPlatform()
    : createMacOSPlatform();
}

const platformInstance = createPlatform();

export function loadPlatform(): LoadedPlatform {
  return platformInstance;
}

export { platformInstance };
