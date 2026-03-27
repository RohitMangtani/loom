import { execFile } from "child_process";
import { join } from "path";
import { existsSync } from "fs";

/**
 * Auto-update: rebuild the primary daemon after a hive repo push,
 * then restart via launchd so the new code takes effect.
 *
 * Flow:
 * 1. Agent pushes code → review-manager detects "git push" for hive repo
 * 2. review-manager calls onPrimaryRebuild → this module
 * 3. npm -w apps/daemon run build (async, non-blocking)
 * 4. launchctl kickstart -k the daemon service → daemon restarts with fresh build
 * 5. Satellites are updated in parallel via ws-server.updateAllSatellites()
 */

const REPO_DIR = join(import.meta.dirname, "..", "..", "..");

let rebuildInFlight = false;

export function rebuildAndRestart(): void {
  if (rebuildInFlight) {
    console.log("[auto-update] Rebuild already in flight — skipping");
    return;
  }
  rebuildInFlight = true;

  console.log("[auto-update] Building daemon...");
  execFile("npm", ["-w", "apps/daemon", "run", "build"], {
    cwd: REPO_DIR,
    timeout: 60_000,
  }, (buildErr, buildStdout, buildStderr) => {
    if (buildErr) {
      console.log(`[auto-update] Build failed: ${buildErr.message.slice(0, 200)}`);
      if (buildStderr) console.log(`[auto-update] stderr: ${buildStderr.slice(0, 200)}`);
      rebuildInFlight = false;
      return;
    }
    console.log("[auto-update] Build succeeded — restarting daemon in 2s...");

    // Delay restart slightly so the current request cycle completes
    setTimeout(() => {
      const uid = process.getuid?.() ?? 501;

      // Try launchctl kickstart first (macOS with launchd service)
      if (process.platform === "darwin") {
        execFile("launchctl", ["kickstart", "-k", `gui/${uid}/com.hive.daemon`], {
          timeout: 10_000,
        }, (launchdErr) => {
          if (launchdErr) {
            console.log(`[auto-update] launchctl restart failed (expected if no plist): ${launchdErr.message.slice(0, 100)}`);
            // Fallback: if no launchd service, just log — the agent pushed from
            // a live terminal so the daemon IS this process. A manual restart is needed.
            console.log("[auto-update] No launchd service found — build complete but manual restart needed");
          } else {
            console.log("[auto-update] Daemon restart triggered via launchctl");
          }
          rebuildInFlight = false;
        });
      } else if (process.platform === "linux") {
        // Try systemd restart
        execFile("systemctl", ["--user", "restart", "hive-daemon"], {
          timeout: 10_000,
        }, (systemdErr) => {
          if (systemdErr) {
            console.log("[auto-update] systemctl restart failed — manual restart needed");
          } else {
            console.log("[auto-update] Daemon restart triggered via systemctl");
          }
          rebuildInFlight = false;
        });
      } else {
        console.log("[auto-update] Build complete — manual restart needed on this platform");
        rebuildInFlight = false;
      }
    }, 2000);
  });
}

/**
 * Health check: returns the current git hash so callers can verify
 * all instances are on the same version.
 */
export function getHealthStatus(): {
  version: string;
  repoDir: string;
  platform: string;
  uptime: number;
} {
  let version = "unknown";
  try {
    const { execFileSync } = require("child_process");
    version = execFileSync("git", ["rev-parse", "--short=8", "HEAD"], {
      cwd: REPO_DIR,
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
  } catch { /* git not available */ }

  return {
    version,
    repoDir: REPO_DIR,
    platform: process.platform,
    uptime: process.uptime(),
  };
}
