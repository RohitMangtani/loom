import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(scriptDir, "..");
const runtimeRoot = join(desktopDir, ".generated", "runtime");
const launcherPath = join(runtimeRoot, "launcher", "desktop-launcher.mjs");
const nodePath = join(runtimeRoot, "bin", "node");

const home = mkdtempSync(join(tmpdir(), "hive-desktop-smoke-"));
const dashboardPort = "3410";
const daemonPort = "3411";
const wsPort = "3412";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(url, attempts = 60) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {
      // Retry.
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise((resolve) => child.once("exit", resolve));
}

const child = spawn(nodePath, [launcherPath], {
  env: {
    ...process.env,
    HOME: home,
    HIVE_RUNTIME_ROOT: runtimeRoot,
    HIVE_DESKTOP_MODE: "fresh",
    HIVE_DASHBOARD_PORT: dashboardPort,
    HIVE_DAEMON_PORT: daemonPort,
    HIVE_WS_PORT: wsPort,
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => {
  stdout += chunk.toString();
});
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

let ok = false;

try {
  const health = await waitFor(`http://127.0.0.1:${dashboardPort}/health`);
  const healthJson = await health.json();
  if (!healthJson.tokenReady) {
    throw new Error("Smoke test health endpoint did not report a token.");
  }

  const bootstrap = await waitFor(`http://127.0.0.1:${dashboardPort}/bootstrap.html`);
  const bootstrapHtml = await bootstrap.text();
  if (!bootstrapHtml.includes("Bootstrapping Hive")) {
    throw new Error("Bootstrap page missing expected copy.");
  }

  await waitFor(`http://127.0.0.1:${dashboardPort}/manifest.json`);

  const token = readFileSync(join(home, ".hive", "token"), "utf8").trim();
  if (!token || token.length !== 64) {
    throw new Error("Desktop smoke test token was not generated correctly.");
  }

  console.log(JSON.stringify({
    ok: true,
    dashboardPort,
    daemonPort,
    wsPort,
    home,
  }));
  ok = true;
} finally {
  child.kill("SIGTERM");
  await waitForExit(child);
  if (!ok) {
    if (stdout.trim()) console.error(stdout.trim());
    if (stderr.trim()) console.error(stderr.trim());
    console.error(`Smoke temp HOME preserved at ${home}`);
  } else {
    rmSync(home, { recursive: true, force: true });
  }
}
