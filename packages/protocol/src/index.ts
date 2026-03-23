/**
 * @hive/protocol — Typed definitions for the Hive daemon protocol.
 *
 * This package defines every REST endpoint, WebSocket message, satellite
 * command, and hook event in the Hive system. Third-party clients,
 * dashboard implementations, and plugins can import these types to
 * build compatible integrations.
 *
 * Protocol version: 1
 */

export { PROTOCOL_VERSION } from "./version.js";

// REST API types
export type {
  // Shared
  WorkerStatus,
  WorkerState,
  WorkerContextSnapshot,
  MachineCapabilities,
  ReviewItem,
  ScratchpadEntry,
  // Workers
  GetWorkersResponse,
  // Messaging
  SendMessageBody,
  SendMessageResponse,
  GetMessageQueueResponse,
  CancelMessageResponse,
  // Queue
  QueueTaskBody,
  QueuedTask,
  QueueTaskResponse,
  GetQueueResponse,
  // Coordination
  AcquireLockBody,
  AcquireLockResponse,
  GetLocksResponse,
  SetScratchpadBody,
  ConflictCheckResponse,
  GetArtifactsResponse,
  // Learnings
  PostLearningBody,
  SearchLearningsResponse,
  // Reviews
  PostReviewBody,
  // Swarm
  SpawnBody,
  KillBody,
  ExecBody,
  ExecResponse,
  SatelliteRepairBody,
  ProjectsResponse,
  ModelsResponse,
  CapabilitiesResponse,
  // Diagnostics
  SignalsResponse,
  AuditResponse,
  DebugResponse,
} from "./rest-api.js";

// WebSocket message types
export type {
  // Dashboard ↔ Daemon
  DashboardMessage,
  DaemonBroadcast,
  PushSubscription,
  ChatEntry,
  AgentModel,
  ConnectedMachine,
  UploadedFileRef,
  // Satellite protocol
  SatelliteUpMessage,
  SatelliteDownMessage,
} from "./ws-messages.js";

// Hook types
export type {
  HookEventName,
  NotificationType,
  HookEventBody,
  HookResponse,
  RegisterTtyBody,
} from "./hooks.js";
