/**
 * Tunnel health monitor.
 *
 * Checks every tick (3s) whether the ngrok/cloudflared tunnel process is alive.
 * If the tunnel dies, auto-restarts it so satellite connections recover.
 *
 * Only runs on the primary (satellite mode has no tunnel).
 */

import { execFileSync, spawn } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const HIVE_DIR = join(homedir(), ".hive");
const TUNNEL_PID_FILE = join(HIVE_DIR, "tunnel.pid");
const TUNNEL_URL_FILE = join(HIVE_DIR, "tunnel-url.txt");
const NGROK_LOG = join(HIVE_DIR, "ngrok.log");
const CLOUDFLARED_LOG = join(HIVE_DIR, "cloudflared.log");
const NGROK_DOMAIN_FILE = join(HIVE_DIR, "ngrok-domain");

// Don't check more than once every 15s to avoid spamming
const CHECK_INTERVAL_MS = 15_000;
// After restart, wait before checking again
const POST_RESTART_COOLDOWN_MS = 30_000;

export class TunnelHealthMonitor {
  private lastCheckAt = 0;
  private restartCount = 0;
  private lastRestartAt = 0;

  /** Called every 3s tick. Only acts every CHECK_INTERVAL_MS. */
  tick(): void {
    const now = Date.now();
    if (now - this.lastCheckAt < CHECK_INTERVAL_MS) return;
    if (now - this.lastRestartAt < POST_RESTART_COOLDOWN_MS) return;
    this.lastCheckAt = now;

    if (!this.isTunnelExpected()) return;
    if (this.isTunnelAlive()) return;

    console.log(`[tunnel-health] Tunnel process dead. Restarting... (restart #${this.restartCount + 1})`);
    this.restart();
  }

  /** A tunnel is expected if we have a tunnel PID file or URL file. */
  private isTunnelExpected(): boolean {
    return existsSync(TUNNEL_PID_FILE) || existsSync(TUNNEL_URL_FILE);
  }

  /** Check if the tunnel is actually working — not just PID alive but reachable. */
  private isTunnelAlive(): boolean {
    // Step 1: check if PID is alive
    try {
      const pidStr = readFileSync(TUNNEL_PID_FILE, "utf-8").trim();
      const pid = parseInt(pidStr, 10);
      if (!pid || isNaN(pid)) return false;
      process.kill(pid, 0);
    } catch {
      return false;
    }

    // Step 2: verify the tunnel is actually functional (not just process alive).
    // ngrok can be running but broken (ERR_6030: multiple endpoints, ERR_8012: etc.)
    // Check the ngrok local API to verify tunnel status.
    try {
      const raw = execFileSync("curl", ["-s", "--connect-timeout", "2", "http://127.0.0.1:4040/api/tunnels"], {
        encoding: "utf-8",
        timeout: 5000,
      });
      const data = JSON.parse(raw);
      if (!data.tunnels || data.tunnels.length === 0) {
        console.log("[tunnel-health] ngrok running but no active tunnels — restarting");
        return false;
      }
      return true;
    } catch {
      // ngrok API not responding — might be cloudflared, check URL reachability instead
      try {
        const url = readFileSync(TUNNEL_URL_FILE, "utf-8").trim();
        if (!url) return true; // no URL to check, trust PID
        const status = execFileSync("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", "--connect-timeout", "3", url + "/health"], {
          encoding: "utf-8",
          timeout: 8000,
        }).trim();
        // Any HTTP response (even 426 Upgrade Required) means tunnel works
        if (status !== "000") return true;
        console.log("[tunnel-health] Tunnel URL unreachable (status 000) — restarting");
        return false;
      } catch {
        return true; // can't verify, trust PID
      }
    }
  }

  /** Restart the tunnel. Kills ALL existing tunnel processes first to prevent
   *  the "multiple endpoints" race (ERR_NGROK_6030), then starts fresh. */
  private restart(): void {
    this.restartCount++;
    this.lastRestartAt = Date.now();

    // Kill ALL existing ngrok/cloudflared processes to prevent duplicates.
    // This is the fix for ERR_NGROK_6030 ("multiple endpoints but not all
    // have pooling enabled") which happens when a stale process lingers.
    try {
      if (process.platform === "win32") {
        execFileSync("taskkill", ["/IM", "ngrok.exe", "/F"], { timeout: 5000, stdio: "pipe" });
      } else {
        execFileSync("pkill", ["-f", "ngrok"], { timeout: 5000, stdio: "pipe" });
      }
    } catch { /* no ngrok running — fine */ }
    try {
      if (process.platform === "win32") {
        execFileSync("taskkill", ["/IM", "cloudflared.exe", "/F"], { timeout: 5000, stdio: "pipe" });
      } else {
        execFileSync("pkill", ["-f", "cloudflared"], { timeout: 5000, stdio: "pipe" });
      }
    } catch { /* no cloudflared running — fine */ }

    // Wait a moment for processes to fully die before starting new ones
    try { execFileSync("sleep", ["2"], { timeout: 5000 }); } catch { /* Windows */ }

    // Read stable domain if configured
    let ngrokDomain = "";
    try {
      ngrokDomain = readFileSync(NGROK_DOMAIN_FILE, "utf-8").trim();
    } catch { /* none */ }

    // Try ngrok
    if (this.hasCommand("ngrok")) {
      try {
        const args = ngrokDomain
          ? ["http", "3002", "--domain", ngrokDomain, "--log=stdout"]
          : ["http", "3002", "--log=stdout"];

        const child = spawn("ngrok", args, {
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });

        // Pipe stdout to log file
        const { createWriteStream } = require("fs") as typeof import("fs");
        const logStream = createWriteStream(NGROK_LOG, { flags: "a" });
        child.stdout?.pipe(logStream);
        child.stderr?.pipe(logStream);
        child.unref();

        if (child.pid) {
          writeFileSync(TUNNEL_PID_FILE, String(child.pid));
        }

        // Wait for ngrok to produce a URL (poll the API)
        setTimeout(() => this.captureNgrokUrl(), 5000);
        console.log(`[tunnel-health] ngrok restarted (PID ${child.pid})`);
        return;
      } catch (err) {
        console.log(`[tunnel-health] ngrok restart failed: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Try cloudflared
    if (this.hasCommand("cloudflared")) {
      try {
        const child = spawn("cloudflared", [
          "tunnel", "--url", "http://localhost:3002", "--no-autoupdate",
        ], {
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });

        const { createWriteStream } = require("fs") as typeof import("fs");
        const logStream = createWriteStream(CLOUDFLARED_LOG, { flags: "a" });
        child.stdout?.pipe(logStream);
        child.stderr?.pipe(logStream);
        child.unref();

        if (child.pid) {
          writeFileSync(TUNNEL_PID_FILE, String(child.pid));
        }

        // Cloudflared logs the URL to stderr
        setTimeout(() => this.captureCloudflaredUrl(), 10000);
        console.log(`[tunnel-health] cloudflared restarted (PID ${child.pid})`);
        return;
      } catch (err) {
        console.log(`[tunnel-health] cloudflared restart failed: ${err instanceof Error ? err.message : err}`);
      }
    }

    console.log("[tunnel-health] No tunnel tool available (ngrok or cloudflared)");
  }

  private captureNgrokUrl(): void {
    try {
      const raw = execFileSync("curl", ["-s", "http://127.0.0.1:4040/api/tunnels"], {
        encoding: "utf-8",
        timeout: 5000,
      });
      const data = JSON.parse(raw);
      for (const t of data.tunnels || []) {
        if (t.public_url && t.public_url.startsWith("https://")) {
          writeFileSync(TUNNEL_URL_FILE, t.public_url);
          console.log(`[tunnel-health] Tunnel URL captured: ${t.public_url}`);
          return;
        }
      }
    } catch {
      console.log("[tunnel-health] Failed to capture ngrok URL — will retry next tick");
    }
  }

  private captureCloudflaredUrl(): void {
    try {
      const log = readFileSync(CLOUDFLARED_LOG, "utf-8");
      const match = log.match(/https:\/\/[-a-z0-9.]+trycloudflare\.com/);
      if (match) {
        writeFileSync(TUNNEL_URL_FILE, match[0]);
        console.log(`[tunnel-health] Tunnel URL captured: ${match[0]}`);
      }
    } catch {
      console.log("[tunnel-health] Failed to capture cloudflared URL");
    }
  }

  private hasCommand(cmd: string): boolean {
    try {
      execFileSync(process.platform === "win32" ? "where" : "which", [cmd], {
        timeout: 3000,
        encoding: "utf-8",
        stdio: "pipe",
      });
      return true;
    } catch {
      return false;
    }
  }
}
