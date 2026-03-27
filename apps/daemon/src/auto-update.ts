import { execFile, execFileSync } from "child_process";
import { join } from "path";
import { existsSync, readFileSync } from "fs";
import type { WorkerState } from "@hive/types";

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

// ---------------------------------------------------------------------------
//  Pipeline Check System
//
//  Runs a comprehensive verification of the entire Hive pipeline and returns
//  a structured pass/fail report. Called via GET /api/check or after auto-update.
// ---------------------------------------------------------------------------

export interface CheckResult {
  name: string;
  pass: boolean;
  detail: string;
}

export interface PipelineReport {
  ts: number;
  version: string;
  overall: "pass" | "fail" | "warn";
  checks: CheckResult[];
  satellites: SatelliteReport[];
}

interface SatelliteReport {
  machine: string;
  version: string;
  versionMatch: boolean;
  workers: number;
  connected: boolean;
}

export function runPipelineCheck(deps: {
  getWorkers: () => WorkerState[];
  getSatellites: () => Array<{ machineId: string; hostname: string; version?: string; workers: WorkerState[] }>;
  hasDiscovery: boolean;
  hookCount: () => number;
  tokenPath: string;
}): PipelineReport {
  const checks: CheckResult[] = [];
  const primaryVersion = getHealthStatus().version;

  // 1. Daemon running
  checks.push({
    name: "daemon_running",
    pass: true,
    detail: `PID ${process.pid}, uptime ${Math.round(process.uptime())}s`,
  });

  // 2. Git version
  checks.push({
    name: "git_version",
    pass: primaryVersion !== "unknown",
    detail: primaryVersion !== "unknown" ? primaryVersion : "git not available or not a repo",
  });

  // 3. Build output exists
  const distIndex = join(REPO_DIR, "apps", "daemon", "dist", "index.js");
  const buildExists = existsSync(distIndex);
  checks.push({
    name: "build_output",
    pass: buildExists,
    detail: buildExists ? "dist/index.js exists" : "dist/index.js missing — run npm build",
  });

  // 4. Auth token
  const tokenExists = existsSync(deps.tokenPath);
  checks.push({
    name: "auth_token",
    pass: tokenExists,
    detail: tokenExists ? "~/.hive/token exists" : "Missing — run install.sh",
  });

  // 5. Discovery active
  checks.push({
    name: "discovery",
    pass: deps.hasDiscovery,
    detail: deps.hasDiscovery ? "Process scanner active" : "Discovery not initialized",
  });

  // 6. Workers detected
  const workers = deps.getWorkers();
  const localWorkers = workers.filter(w => !w.id.includes(":"));
  checks.push({
    name: "local_workers",
    pass: localWorkers.length > 0,
    detail: `${localWorkers.length} local worker(s) detected`,
  });

  // 7. Hook pipeline
  const hookTotal = deps.hookCount();
  checks.push({
    name: "hook_pipeline",
    pass: hookTotal > 0,
    detail: hookTotal > 0 ? `${hookTotal} hooks received this session` : "No hooks received — check settings.json",
  });

  // 8. Status detection — check for any stuck-in-wrong-state workers
  const wrongState = workers.filter(w =>
    w.status === "working" && w.lastActionAt < Date.now() - 120_000
  );
  checks.push({
    name: "status_accuracy",
    pass: wrongState.length === 0,
    detail: wrongState.length === 0
      ? "No stale-working workers"
      : `${wrongState.length} worker(s) show working but last action >2min ago: ${wrongState.map(w => w.id).join(", ")}`,
  });

  // 9. Workers.json file
  const workersJson = join(REPO_DIR, "..", "..", "..", ".hive", "workers.json");
  const wjExists = existsSync(workersJson);
  checks.push({
    name: "workers_json",
    pass: wjExists,
    detail: wjExists ? "~/.hive/workers.json exists" : "Missing — identity hook may fail",
  });

  // 10. Satellites
  const sats = deps.getSatellites();
  const satelliteReports: SatelliteReport[] = sats.map(s => ({
    machine: s.hostname || s.machineId,
    version: s.version || "unknown",
    versionMatch: s.version === primaryVersion,
    workers: s.workers.length,
    connected: true,
  }));

  if (sats.length > 0) {
    const allMatch = satelliteReports.every(s => s.versionMatch);
    checks.push({
      name: "satellite_versions",
      pass: allMatch,
      detail: allMatch
        ? `${sats.length} satellite(s), all on ${primaryVersion}`
        : `Version mismatch: ${satelliteReports.filter(s => !s.versionMatch).map(s => `${s.machine}=${s.version}`).join(", ")}`,
    });

    const totalSatWorkers = satelliteReports.reduce((n, s) => n + s.workers, 0);
    checks.push({
      name: "satellite_workers",
      pass: totalSatWorkers > 0,
      detail: `${totalSatWorkers} worker(s) across ${sats.length} satellite(s)`,
    });
  }

  // Overall verdict
  const failCount = checks.filter(c => !c.pass).length;
  const overall: PipelineReport["overall"] =
    failCount === 0 ? "pass" : failCount <= 2 ? "warn" : "fail";

  return {
    ts: Date.now(),
    version: primaryVersion,
    overall,
    checks,
    satellites: satelliteReports,
  };
}
