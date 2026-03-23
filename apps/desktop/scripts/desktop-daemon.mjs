import { execFile } from "child_process";

const runtimeRoot = process.env.HIVE_RUNTIME_ROOT;
if (!runtimeRoot) {
  throw new Error("HIVE_RUNTIME_ROOT is required.");
}

const daemonPort = Number(process.env.HIVE_DAEMON_PORT || 3001);
const wsPort = Number(process.env.HIVE_WS_PORT || 3002);

const { TelemetryReceiver } = await import(new URL("../hive/apps/daemon/dist/telemetry.js", import.meta.url));
const { ProcessManager } = await import(new URL("../hive/apps/daemon/dist/process-mgr.js", import.meta.url));
const { SessionStreamer } = await import(new URL("../hive/apps/daemon/dist/session-stream.js", import.meta.url));
const { WsServer } = await import(new URL("../hive/apps/daemon/dist/ws-server.js", import.meta.url));
const { ProcessDiscovery } = await import(new URL("../hive/apps/daemon/dist/discovery.js", import.meta.url));
const { AutoPilot } = await import(new URL("../hive/apps/daemon/dist/auto-pilot.js", import.meta.url));
const { Watchdog } = await import(new URL("../hive/apps/daemon/dist/watchdog.js", import.meta.url));
const { StateStore } = await import(new URL("../hive/apps/daemon/dist/state-store.js", import.meta.url));
const { NotificationManager } = await import(new URL("../hive/apps/daemon/dist/notifications.js", import.meta.url));
const { WebPushManager } = await import(new URL("../hive/apps/daemon/dist/web-push.js", import.meta.url));
const { Collector } = await import(new URL("../hive/apps/daemon/dist/collector.js", import.meta.url));
const { OutboxScanner } = await import(new URL("../hive/apps/daemon/dist/outbox.js", import.meta.url));
const { loadOrCreateToken, deriveViewerToken, patchHookUrls } = await import(new URL("../hive/apps/daemon/dist/auth.js", import.meta.url));
const { acquireRuntimeSingleton } = await import(new URL("../hive/apps/daemon/dist/runtime-singleton.js", import.meta.url));

try {
  execFile("/usr/bin/osascript", ["-e", 'tell application "Terminal" to get name of first window'], { timeout: 5000 }, () => {});
} catch {
  // Best effort only.
}

const token = loadOrCreateToken();
const viewerToken = deriveViewerToken(token);
if (daemonPort === 3001) {
  patchHookUrls(token);
}

const daemonLock = acquireRuntimeSingleton("daemon");
if (!daemonLock.ok) {
  const owner = daemonLock.conflict.metadata;
  const ownerText = owner ? `PID ${owner.pid}` : "another process";
  console.log(`[desktop-daemon] Runtime already owned by ${ownerText}. Exiting duplicate instance.`);
  process.exit(0);
}

const telemetry = new TelemetryReceiver(daemonPort, token);
const procMgr = new ProcessManager(telemetry);
const streamer = new SessionStreamer();
const ws = new WsServer(telemetry, procMgr, streamer, wsPort, token, viewerToken);
const discovery = new ProcessDiscovery(telemetry, streamer);
const pushMgr = new WebPushManager();
const notifications = new NotificationManager();
notifications.setPushManager(pushMgr);
ws.setDiscovery(discovery);
ws.setPushManager(pushMgr);
const autoPilot = new AutoPilot(telemetry, streamer);
const watchdog = new Watchdog(telemetry);
const collector = new Collector();
const outbox = new OutboxScanner(telemetry);
const stateStore = new StateStore();

telemetry.start();
telemetry.registerProcessManager(procMgr);
telemetry.registerApi(procMgr, discovery);
telemetry.registerCollector(collector);
telemetry.setStreamer(streamer);
telemetry.onRemoval((workerId) => streamer.clearWorker(workerId));
ws.start();

const snapshot = StateStore.load();
if (snapshot) {
  telemetry.importState(snapshot);
}

notifications.register(telemetry);
ws.onSatelliteStatusChange((workerId, worker, prevStatus) => {
  notifications.handleSatelliteStatusChange(workerId, worker, prevStatus);
});

discovery.scan();
console.log(`Hive desktop daemon running on ${daemonPort}/${wsPort}.`);

const interval = setInterval(() => {
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

telemetry.writeWorkersFile();
stateStore.startPeriodicSave(() => telemetry.exportState());

const shutdown = () => {
  clearInterval(interval);
  daemonLock.claim.release();
  stateStore.save();
  stateStore.stop();
  for (const id of procMgr.listIds()) {
    procMgr.kill(id);
  }
  setTimeout(() => process.exit(0), 1500);
};

process.on("exit", daemonLock.claim.release);
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
