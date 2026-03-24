/**
 * Device Layer — entry point.
 *
 * Usage in daemon index.ts:
 *
 *   import { DeviceLayer } from "./devices/index.js";
 *
 *   const devices = new DeviceLayer();
 *   devices.registerRoutes(app, requireAuth);
 *   devices.setTaskBridge((event) => { ... });
 *
 *   // In the 3s tick loop:
 *   devices.tick();
 */

export { DeviceLayer } from "./routes.js";
export { DeviceRegistry } from "./registry.js";
export { DeviceIngest } from "./ingest.js";
export type {
  DeviceRegistration,
  RegisteredDevice,
  DeviceType,
  DataType,
  DeviceDataPayload,
  DeviceEvent,
  Hitbox,
} from "./types.js";
