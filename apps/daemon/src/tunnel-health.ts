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

  /** Check if the stored tunnel PID is alive. */
  private isTunnelAlive(): boolean {
    try {
      const pidStr = readFileSync(TUNNEL_PID_FILE, "utf-8").trim();
      const pid = parseInt(pidStr, 10);
      if (!pid || isNaN(pid)) return false;
      // Signal 0 checks if process exists without killing it
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /** Restart the tunnel. Tries ngrok first, then cloudflared. */
  private restart(): void {
    this.restartCount++;
    this.lastRestartAt = Date.now();

    // Read stable domain if configured
    let ngrokDomain = "";
    try {
      ngrokDomain = readFileSync(NGROK_DOMAIN_FILE, "utf-8").trim();
    } catch { /* none */ }

    // Try ngrok
    if (this.hasCommand("ngrok")) {
      try {
        const args = ngrokDomain
          ? ["http", "3002", "--url", ngrokDomain, "--log=stdout"]
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
