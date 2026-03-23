import { platform } from "os";

export function loadPlatform() {
  if (platform() === "linux") {
    return require("./linux/index.js").createLinuxPlatform();
  }
  return require("./macos/index.js").createMacOSPlatform();
}
