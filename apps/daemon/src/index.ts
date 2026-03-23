import { execFile } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";
import { homedir, platform as osPlatform } from "os";
import { TelemetryReceiver } from "./telemetry.js";
import { ProcessManager } from "./process-mgr.js";
import { SessionStreamer } from "./session-stream.js";
import { WsServer } from "./ws-server.js";
import { ProcessDiscovery } from "./discovery.js";
import { AutoPilot } from "./auto-pilot.js";
import { Watchdog } from "./watchdog.js";
import { StateStore } from "./state-store.js";
import { NotificationManager } from "./notifications.js";
import { WebPushManager } from "./web-push.js";
import { Collector } from "./collector.js";
import { OutboxScanner } from "./outbox.js";
import { loadOrCreateToken, deriveViewerToken, patchHookUrls } from "./auth.js";
import { SatelliteClient } from "./satellite.js";
import { acquireRuntimeSingleton } from "./runtime-singleton.js";
import { loadPlatform } from "./platform/index.js";
import { UserRegistry } from "./user-registry.js";
import { ReplayManager } from "./replay.js";
import { RevertHistory } from "./revert-history.js";

// ── Satellite mode ──────────────────────────────────────────────────
// Usage: npx tsx apps/daemon/src/index.ts --satellite wss://URL TOKEN

const satFlagIdx = process.argv.indexOf("--satellite");
if (satFlagIdx !== -1) {
  let primaryUrl = process.argv[satFlagIdx + 1] || "";
  let primaryToken = process.argv[satFlagIdx + 2] || "";

  // Fall back to stored config
  const hiveDir = join(homedir(), ".hive");
  if (!primaryUrl) {
    try { primaryUrl = readFileSync(join(hiveDir, "primary-url"), "utf-8").trim(); } catch { /* */ }
  }
  if (!primaryToken) {
    try { primaryToken = readFileSync(join(hiveDir, "primary-token"), "utf-8").trim(); } catch { /* */ }
  }

  if (!primaryUrl || !primaryToken) {
    console.error("Usage: --satellite <wss://primary-url> <token>");
    console.error("  Or store in ~/.hive/primary-url and ~/.hive/primary-token");
    process.exit(1);
  }

  // Convert https:// to wss:// if needed
  if (primaryUrl.startsWith("https://")) {
    primaryUrl = primaryUrl.replace("https://", "wss://");
  }

  if (osPlatform() === "darwin") {
    execFile("/usr/bin/osascript", ["-e",
      'tell application "Terminal" to get name of first window'
    ], { timeout: 5000 }, () => { });
  }

  const localToken = loadOrCreateToken();
  const platform = loadPlatform();
  const satLock = acquireRuntimeSingleton("satellite", { primaryUrl });
  if (!satLock.ok) {
    const owner = satLock.conflict.metadata;
    const ownerText = owner ? `PID ${owner.pid}` : "another process";
    console.log(`[satellite] Runtime already owned by ${ownerText}. Exiting duplicate instance.`);
    process.exit(0);
  }
  const satellite = new SatelliteClient(primaryUrl, primaryToken, localToken, platform);
  satellite.start();

  console.log("Hive satellite running.");
  console.log(`  Primary: ${primaryUrl}`);
  console.log("  Local hooks: http://127.0.0.1:3001");

  // Prevent crashes from unhandled errors  --  log and continue
  process.on("uncaughtException", (err) => {
    console.log(`[satellite] Uncaught exception: ${err.message}`);
  });
  process.on("unhandledRejection", (reason) => {
    console.log(`[satellite] Unhandled rejection: ${reason instanceof Error ? reason.message : reason}`);
  });

  const shutdown = () => {
    console.log("\nShutting down satellite...");
    satLock.claim.release();
    satellite.stop();
    setTimeout(() => process.exit(0), 1000);
  };

  process.on("exit", satLock.claim.release);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

} else {

  // ── Primary mode (default) ──────────────────────────────────────────

  if (osPlatform() === "darwin") {
    // Probe Automation permission early  --  macOS shows the approval dialog on first
    // use, so we trigger it at startup rather than waiting for the user to click X.
    execFile("/usr/bin/osascript", ["-e",
      'tell application "Terminal" to get name of first window'
    ], { timeout: 5000 }, () => { /* result doesn't matter  --  the dialog is the point */ });
  }

  const token = loadOrCreateToken();
  const viewerToken = deriveViewerToken(token);
  patchHookUrls(token);
  const platform = loadPlatform();
  const userRegistry = new UserRegistry();
  const daemonLock = acquireRuntimeSingleton("daemon");
  if (!daemonLock.ok) {
    const owner = daemonLock.conflict.metadata;
    const ownerText = owner ? `PID ${owner.pid}` : "another process";
    console.log(`[daemon] Runtime already owned by ${ownerText}. Exiting duplicate instance.`);
    process.exit(0);
  }

  const replayManager = new ReplayManager();
  const telemetry = new TelemetryReceiver(3001, token, {
    terminal: platform.terminal,
    windows: platform.windows,
    userRegistry,
    replayManager,
  });
  const revertHistory = new RevertHistory();
  telemetry.setRevertHook((payload) => revertHistory.add(payload));
  const procMgr = new ProcessManager(telemetry);
  const streamer = new SessionStreamer();
  const ws = new WsServer(telemetry, procMgr, streamer, 3002, token, viewerToken, userRegistry, replayManager, {
    terminal: platform.terminal,
    windows: platform.windows,
  });
  const discovery = new ProcessDiscovery(telemetry, streamer, {
    discovery: platform.discovery,
    terminal: platform.terminal,
  });
  const pushMgr = new WebPushManager();
  const notifications = new NotificationManager();
  notifications.setPushManager(pushMgr);
  ws.setDiscovery(discovery);
  ws.setPushManager(pushMgr);
  const autoPilot = new AutoPilot(telemetry, streamer, platform.terminal);
  const watchdog = new Watchdog(telemetry);
  const collector = new Collector();
  const outbox = new OutboxScanner(telemetry);
  const stateStore = new StateStore();

  telemetry.start();
  telemetry.registerProcessManager(procMgr);
  telemetry.registerApi(procMgr, discovery, revertHistory);
  telemetry.registerCollector(collector);
  telemetry.setStreamer(streamer);
  telemetry.onRemoval((workerId) => streamer.clearWorker(workerId));
  ws.start();

  // Restore state from previous daemon run (if fresh enough)
  const snapshot = StateStore.load();
  if (snapshot) {
    telemetry.importState(snapshot);
  }

  // Register push notifications on stuck transitions (local workers)
  notifications.register(telemetry);

  // Register push notifications for satellite workers (working→idle, stuck)
  ws.onSatelliteStatusChange((workerId, worker, prevStatus) => {
    notifications.handleSatelliteStatusChange(workerId, worker, prevStatus);
  });

  // Initial scan for existing Claude processes
  discovery.scan();
  console.log(`  Found ${telemetry.getAll().length} existing Claude instance(s)`);

  // Periodic: status updates + re-scan for new/dead processes + auto-respond
  setInterval(() => {
    telemetry.tick();
    procMgr.tick();
    discovery.scan();
    telemetry.writeWorkersFile();
    ws.pushState();
    autoPilot.tick();
    watchdog.tick();
    collector.tick();
    outbox.tick();
  }, 3_000);

  // Write initial workers file immediately after first scan
  telemetry.writeWorkersFile();

  // Start periodic state snapshots (every 30s, separate from the 3s tick)
  stateStore.startPeriodicSave(() => telemetry.exportState());

  console.log("Hive daemon running.");
  console.log("  Token: ~/.hive/token");
  console.log("  Telemetry: http://127.0.0.1:3001");
  console.log("  WebSocket: ws://127.0.0.1:3002");

  const shutdown = () => {
    console.log("\nShutting down...");
    daemonLock.claim.release();
    stateStore.save();
    stateStore.stop();
    for (const id of procMgr.listIds()) {
      procMgr.kill(id);
    }
    setTimeout(() => process.exit(0), 2000);
  };

  process.on("exit", daemonLock.claim.release);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
