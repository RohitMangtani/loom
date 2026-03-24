// Re-export all types from the shared package
export type {
  WorkerState,
  WorkerContextSnapshot,
  ChatEntry,
  DaemonMessage,
  DaemonResponse,
  ReviewItem,
  ConnectedMachine,
  UploadedFileRef,
  HiveUser,
  RegisteredDevice,
  DeviceEvent,
  DeviceType,
  DeviceHitbox,
} from "@hive/types";

/** Available agent type for the spawn dialog (sent by daemon over WS). */
export interface AgentModel {
  id: string;
  label: string;
}
