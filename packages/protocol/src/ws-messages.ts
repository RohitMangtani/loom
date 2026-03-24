/**
 * Hive WebSocket Protocol
 *
 * WebSocket server runs on port 3002. Clients connect with token auth
 * via query param: ws://localhost:3002?token=XXX
 *
 * Two client types:
 * - Dashboard clients: send commands, receive state broadcasts
 * - Satellite clients: bidirectional worker state sync + command relay
 *
 * All messages are JSON. The `type` field is the discriminant.
 */

import type { WorkerState, WorkerContextSnapshot, ReviewItem, MachineCapabilities } from "./rest-api.js";
import type { HiveUser } from "@hive/types";

// ── Dashboard → Daemon (client sends) ───────────────────────────────

export type DashboardMessage =
  | { type: "spawn"; project?: string; model?: string; task?: string; targetQuadrant?: number; machine?: string }
  | { type: "kill"; workerId: string }
  | { type: "message"; workerId: string; content: string }
  | { type: "selection"; workerId: string; optionIndex: number }
  | { type: "approve_prompt"; workerId: string }
  | { type: "subscribe"; workerId: string }
  | { type: "unsubscribe"; workerId: string }
  | { type: "list" }
  | { type: "suggestion_feedback"; workerId?: string; appliedLabel?: string; shownLabels?: string[] }
  | { type: "review_seen"; reviewId: string }
  | { type: "review_dismiss"; reviewId: string }
  | { type: "review_seen_all" }
  | { type: "review_clear_all" }
  | { type: "push_subscribe"; subscription: PushSubscription; pushLabel?: string }
  | { type: "push_unsubscribe" }
  | { type: "worker_context"; workerId: string; includeHistory?: boolean; historyLimit?: number }
  | { type: "upload_file"; requestId: string; workerId: string; fileName: string; mimeType?: string; size: number; dataBase64: string }
  | { type: "orchestrator"; action: string; [key: string]: unknown };

export interface PushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

// ── Daemon → Dashboard (server sends) ───────────────────────────────

export type DaemonBroadcast =
  | { type: "workers"; workers: WorkerState[] }
  | { type: "worker_update"; worker: WorkerState }
  | { type: "worker_removed"; workerId: string }
  | { type: "chat"; workerId: string; content: string }
  | { type: "chat_history"; workerId: string; messages: ChatEntry[]; full?: boolean }
  | { type: "auth"; admin: boolean; role?: "admin" | "operator" | "viewer" }
  | { type: "reviews"; reviews: ReviewItem[] }
  | { type: "review_added"; review: ReviewItem }
  | { type: "models"; models: AgentModel[] }
  | { type: "machines"; machines: ConnectedMachine[] }
  | { type: "vapid_key"; vapidKey: string }
  | { type: "push_status"; subscribed: boolean }
  | { type: "worker_context"; workerId: string; context: WorkerContextSnapshot | null }
  | { type: "upload_result"; requestId: string; ok: boolean; upload?: UploadedFileRef; error?: string }
  | { type: "presence"; users: Array<Pick<HiveUser, "id" | "name" | "role" | "createdAt">> }
  | { type: "activity"; userId: string; userName: string; action: string; timestamp: number }
  | { type: "orchestrator"; [key: string]: unknown }
  | { type: "error"; error: string };

export interface ChatEntry {
  role: "user" | "agent" | "tool";
  text: string;
  timestamp?: number;
}

export interface AgentModel {
  id: string;
  label: string;
}

export interface ConnectedMachine {
  id: string;
  hostname: string;
  workerCount: number;
  capabilities?: MachineCapabilities;
}

export interface UploadedFileRef {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  path: string;
  machine?: string;
}

// ── Satellite → Primary (upstream messages) ──────────────────────────

export type SatelliteUpMessage =
  | { type: "satellite_hello"; machineId: string; hostname: string; platform?: string; capabilities?: MachineCapabilities; version?: string }
  | { type: "satellite_workers"; workers: WorkerState[] }
  | { type: "satellite_heartbeat"; ts: number }
  | { type: "satellite_chat"; workerId: string; messages: ChatEntry[]; full?: boolean }
  | { type: "satellite_result"; requestId: string; ok: boolean; error?: string; [key: string]: unknown }
  | { type: "satellite_projects"; projects: string[] }
  | { type: "satellite_api_request"; requestId: string; method: string; path: string; body?: unknown }
  | { type: "satellite_context_response"; requestId: string; context: WorkerContextSnapshot | null };

// ── Primary → Satellite (downstream commands) ────────────────────────

export type SatelliteDownMessage =
  | { type: "satellite_message"; workerId?: string; localWorkerId?: string; content: string; requestId?: string }
  | { type: "satellite_selection"; workerId?: string; localWorkerId?: string; optionIndex: number }
  | { type: "satellite_spawn"; project?: string; model?: string; targetQuadrant?: number; initialMessage?: string; requestId?: string }
  | { type: "satellite_kill"; workerId?: string; localWorkerId?: string; requestId?: string }
  | { type: "satellite_update"; requestId?: string }
  | { type: "satellite_maintenance"; action?: string; requestId?: string }
  | { type: "satellite_exec"; command: string; cwd?: string; timeoutMs?: number; requestId?: string }
  | { type: "satellite_context"; workerId?: string; localWorkerId?: string; requestId: string; includeHistory?: boolean; historyLimit?: number }
  | { type: "satellite_primary_url"; primaryUrl: string }
  | { type: "satellite_heartbeat_ack" }
  | { type: "satellite_autocommit"; localWorkerId?: string; project: string; requestId?: string }
  | { type: "satellite_api_response"; requestId: string; data: unknown };
