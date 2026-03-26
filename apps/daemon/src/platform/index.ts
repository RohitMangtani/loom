import { platform } from "os";
import { createLinuxPlatform } from "./linux/index.js";
import { createMacOSPlatform } from "./macos/index.js";
import { createWindowsPlatform } from "./windows/index.js";
import type { LoadedPlatform } from "./interfaces.js";

function createPlatform(): LoadedPlatform {
  const os = platform();
  if (os === "win32") return createWindowsPlatform();
  if (os === "linux") return createLinuxPlatform();
  return createMacOSPlatform();
}

const platformInstance = createPlatform();

export function loadPlatform(): LoadedPlatform {
  return platformInstance;
}

export { platformInstance };
