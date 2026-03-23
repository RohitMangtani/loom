import { createReadStream, existsSync, mkdirSync, openSync, readFileSync, statSync } from "fs";
import { extname, join, normalize } from "path";
import { homedir } from "os";
import { spawn } from "child_process";
import http from "http";

const runtimeRoot = process.env.HIVE_RUNTIME_ROOT;
if (!runtimeRoot) {
  throw new Error("HIVE_RUNTIME_ROOT is required.");
}

const mode = process.env.HIVE_DESKTOP_MODE || "fresh";
const primaryUrl = process.env.HIVE_DESKTOP_PRIMARY_URL || "";
const primaryToken = process.env.HIVE_DESKTOP_PRIMARY_TOKEN || "";
const dashboardPort = Number(process.env.HIVE_DASHBOARD_PORT || 3310);
const hiveRoot = join(runtimeRoot, "hive");
const daemonEntry = join(hiveRoot, "apps", "daemon", "dist", "index.js");
const dashboardRoot = join(hiveRoot, "apps", "dashboard", "out");
const logsDir = join(homedir(), ".hive", "logs");
const adminTokenPath = join(homedir(), ".hive", "token");

mkdirSync(logsDir, { recursive: true });

const daemonLog = openSync(join(logsDir, "desktop-daemon.log"), "a");
const launcherLog = openSync(join(logsDir, "desktop-launcher.log"), "a");

const daemonArgs = [daemonEntry];
if (mode === "connect") {
  if (!primaryUrl || !primaryToken) {
    throw new Error("Connect mode requires primary URL and token.");
  }
  daemonArgs.push("--satellite", primaryUrl, primaryToken);
}

const daemon = spawn(process.execPath, daemonArgs, {
  cwd: hiveRoot,
  env: {
    ...process.env,
    HIVE_DESKTOP_WRAPPER: "1",
  },
  stdio: ["ignore", daemonLog, daemonLog],
});

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
};

function sendJson(res, payload) {
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function bootstrapHtml(token) {
  const safeToken = JSON.stringify(token);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Hive Bootstrap</title>
    <style>
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #07090d; color: #f8fafc; font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      p { color: #9aa4b2; }
    </style>
  </head>
  <body>
    <div>
      <h1>Bootstrapping Hive…</h1>
      <p>Persisting the local admin token and loading the dashboard.</p>
    </div>
    <script>
      localStorage.setItem("hive_token", ${safeToken});
      localStorage.setItem("hive_mode", "admin");
      location.replace("/");
    </script>
  </body>
</html>`;
}

function serveFile(res, filePath) {
  const extension = extname(filePath);
  const contentType = contentTypes[extension] || "application/octet-stream";
  const stat = statSync(filePath);
  res.writeHead(200, {
    "Content-Length": stat.size,
    "Content-Type": contentType,
  });
  createReadStream(filePath).pipe(res);
}

let dashboardServer = null;

if (mode === "fresh") {
  dashboardServer = http.createServer((req, res) => {
    const url = new URL(req.url || "/", `http://127.0.0.1:${dashboardPort}`);

    if (url.pathname === "/health") {
      sendJson(res, {
        mode,
        dashboardPort,
        tokenReady: existsSync(adminTokenPath),
      });
      return;
    }

    if (url.pathname === "/bootstrap" || url.pathname === "/bootstrap.html") {
      const token = url.searchParams.get("token") || (existsSync(adminTokenPath) ? readFileSync(adminTokenPath, "utf8").trim() : "");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(bootstrapHtml(token));
      return;
    }

    let filePath = normalize(join(dashboardRoot, url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "")));
    if (!filePath.startsWith(dashboardRoot)) {
      res.writeHead(403).end("Forbidden");
      return;
    }

    if (!existsSync(filePath)) {
      filePath = join(dashboardRoot, "index.html");
    }

    serveFile(res, filePath);
  });

  dashboardServer.listen(dashboardPort, "127.0.0.1");
}

let shuttingDown = false;

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;

  if (dashboardServer) {
    dashboardServer.close();
  }

  try {
    daemon.kill("SIGTERM");
  } catch {
    // Best effort only.
  }

  setTimeout(() => {
    try {
      daemon.kill("SIGKILL");
    } catch {
      // Best effort only.
    }
    process.exit(0);
  }, 4_000);
}

daemon.on("exit", (code) => {
  if (!shuttingDown && code && code !== 0) {
    process.stderr.write(`Hive desktop daemon exited with code ${code}\n`);
  }
  shutdown();
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Keep the launcher alive even in satellite mode when only the daemon child is active.
setInterval(() => {
  const timestamp = new Date().toISOString();
  process.stdout.write(`[desktop-launcher] ${timestamp} ${mode}\n`);
}, 60_000).unref();

process.stdout.write(`Hive desktop launcher running in ${mode} mode.\n`);
process.stdout.write(`Logs: ${logsDir}\n`);
process.stdout.write(`Launcher log fd: ${launcherLog}\n`);
