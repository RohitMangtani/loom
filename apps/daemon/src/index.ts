import { TelemetryReceiver } from "./telemetry.js";
import { ProcessManager } from "./process-mgr.js";
import { SessionStreamer } from "./session-stream.js";
import { WsServer } from "./ws-server.js";
import { ProcessDiscovery } from "./discovery.js";
import { AutoPilot } from "./auto-pilot.js";
import { Watchdog } from "./watchdog.js";
import { StateStore } from "./state-store.js";
import { NotificationManager } from "./notifications.js";
import { Collector } from "./collector.js";
import { OutboxScanner } from "./outbox.js";
import { loadOrCreateToken, deriveViewerToken, patchHookUrls } from "./auth.js";

const token = loadOrCreateToken();
const viewerToken = deriveViewerToken(token);
patchHookUrls(token);

const telemetry = new TelemetryReceiver(3001, token);
const procMgr = new ProcessManager(telemetry);
const streamer = new SessionStreamer();
const ws = new WsServer(telemetry, procMgr, streamer, 3002, token, viewerToken);
const discovery = new ProcessDiscovery(telemetry, streamer);
ws.setDiscovery(discovery);
const autoPilot = new AutoPilot(telemetry, streamer);
const watchdog = new Watchdog(telemetry);
const collector = new Collector();
const outbox = new OutboxScanner(telemetry);
const stateStore = new StateStore();
const notifications = new NotificationManager();

telemetry.start();
telemetry.registerProcessManager(procMgr);
telemetry.registerApi(procMgr, discovery);
telemetry.registerCollector(collector);
telemetry.setStreamer(streamer);
ws.start();

// Restore state from previous daemon run (if fresh enough)
const snapshot = StateStore.load();
if (snapshot) {
  telemetry.importState(snapshot);
}

// Register push notifications on stuck transitions
notifications.register(telemetry);

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
  stateStore.save();
  stateStore.stop();
  for (const id of procMgr.listIds()) {
    procMgr.kill(id);
  }
  setTimeout(() => process.exit(0), 2000);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
