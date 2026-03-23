export interface Suggestion {
  label: string;
  message: string;
  reason?: string;
}

export interface HiveUser {
  id: string;
  name: string;
  role: "admin" | "operator" | "viewer";
  createdAt: number;
}

export interface WorkerArtifact {
  path: string;
  action: string;
  ts: number;
}

export interface UploadedFileRef {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  path: string;
  machine?: string;
}

export interface WorkerState {
  id: string;
  pid: number;
  project: string;
  projectName: string;
  status: "working" | "idle" | "stuck" | "waiting";
  currentAction: string | null;
  lastAction: string;
  lastActionAt: number;
  errorCount: number;
  startedAt: number;
  task: string | null;
  managed: boolean;
  tty?: string;
  stuckMessage?: string;
  lastDirection?: string;
  suggestions?: Suggestion[];
  /** Which AI tool this worker is running (e.g. "claude", "codex", "openclaw"). Defaults to "claude". */
  model?: string;
  /** Server-assigned slot (1-8). Dashboard should use this for grid ordering. */
  quadrant?: number;
  /** Pre-session prompt awaiting user approval (trust folder, sandbox, etc.). */
  promptType?: "trust" | "sandbox" | null;
  /** Human-readable prompt message to display on the dashboard. */
  promptMessage?: string;
  /** Raw terminal output for agents with no session yet (shows CLI prompts). */
  terminalPreview?: string;
  /** Stable machine ID used for routing remote workers. */
  machine?: string;
  /** Human-readable machine label for peer summaries and workers.json snapshots. */
  machineLabel?: string;
}

export interface WorkerContextSnapshot {
  workerId: string;
  quadrant?: number;
  tty?: string;
  model: string;
  project: string;
  projectName: string;
  status: WorkerState["status"];
  currentAction: string | null;
  lastAction: string;
  lastDirection?: string;
  recentArtifacts: WorkerArtifact[];
  recentMessages: ChatEntry[];
  contextSummary: string;
}

export interface TelemetryEvent {
  worker_id: string;
  session_id: string;
  event:
    | "SessionStart"
    | "UserPromptSubmit"
    | "PreToolUse"
    | "PostToolUse"
    | "Stop"
    | "SubagentStart"
    | "SubagentStop";
  tool_name?: string;
  summary?: string;
  timestamp: number;
}

/** Hardware/software capabilities a machine can advertise. */
export interface MachineCapabilities {
  /** Hardware */
  gpu?: boolean;
  gpuName?: string;
  ramGb?: number;
  cpuCores?: number;
  diskFreeGb?: number;
  /** Software  --  true means the tool is installed and accessible */
  ffmpeg?: boolean;
  docker?: boolean;
  python?: boolean;
  node?: boolean;
  /** Python ML/AI libraries */
  pytorch?: boolean;
  tensorflow?: boolean;
  /** Custom tags  --  user-defined capabilities (e.g., "vpn", "prod-access", "gpu-render") */
  tags?: string[];
  /** OS platform */
  platform?: string;
  /** Architecture (arm64, x86_64) */
  arch?: string;
  /** Projects available on this machine: name → absolute path.
   *  Auto-detected from git repos + overridable via ~/.hive/capabilities.json.
   *  Enables path-agnostic dispatch: "work on crawler" resolves to the correct
   *  local path regardless of which machine runs the task. */
  projects?: Record<string, string>;
}

/** A connected satellite machine (sent to dashboard for spawn routing). */
export interface ConnectedMachine {
  id: string;
  hostname: string;
  workerCount: number;
  /** Auto-detected and user-defined capabilities */
  capabilities?: MachineCapabilities;
}

export interface DaemonMessage {
  type: "spawn" | "kill" | "message" | "selection" | "list" | "orchestrator" | "subscribe" | "unsubscribe" | "suggestion_feedback" | "review_seen" | "review_dismiss" | "review_seen_all" | "review_clear_all" | "approve_prompt" | "push_subscribe" | "push_unsubscribe" | "worker_context" | "upload_file";
  workerId?: string;
  project?: string;
  task?: string;
  content?: string;
  /** Model to spawn: "claude", "codex", or "openclaw". Defaults to "claude". */
  model?: string;
  /** Target slot (1-8) for spawn. If set, places the terminal in this slot. */
  targetQuadrant?: number;
  /** Target machine for spawn. Omit or "local" for this computer. */
  machine?: string;
  optionIndex?: number;
  /** Phase 4: which suggestion label was applied */
  appliedLabel?: string;
  /** Phase 4: all suggestion labels that were shown */
  shownLabels?: string[];
  /** Review ID for review mutations */
  reviewId?: string;
  /** Web Push subscription object from browser */
  subscription?: {
    endpoint: string;
    keys: { p256dh: string; auth: string };
  };
  /** Label for the push subscription (e.g. "iPhone", "iPad") */
  pushLabel?: string;
  /** Include recent conversation history in a worker context response. */
  includeHistory?: boolean;
  /** Max history entries to include in a worker context response. */
  historyLimit?: number;
  /** Correlates an upload_file request with its upload_result response. */
  requestId?: string;
  /** Upload metadata for upload_file messages. */
  fileName?: string;
  mimeType?: string;
  size?: number;
  /** Base64-encoded file payload for upload_file messages. */
  dataBase64?: string;
}

export interface ChatEntry {
  role: "user" | "agent" | "tool";
  text: string;
  timestamp?: number;
  /** Client-only: tracks optimistic entries for dedup against server echoes */
  _optimisticId?: string;
}

export interface ReviewItem {
  id: string;
  summary: string;
  url?: string;
  type: "deploy" | "commit" | "pr" | "push" | "review-needed" | "general";
  workerId: string;
  quadrant?: number;
  projectName: string;
  createdAt: number;
  seen: boolean;
  /** Recent file changes by this worker at review time */
  artifacts?: Array<{ path: string; action: string }>;
}

export interface DaemonResponse {
  type: "workers" | "worker_update" | "worker_removed" | "chat" | "chat_history" | "orchestrator" | "error" | "queued" | "auth" | "reviews" | "review_added" | "vapid_key" | "push_status" | "machines" | "worker_context" | "upload_result" | "presence" | "activity";
  workers?: WorkerState[];
  worker?: WorkerState;
  /** Connected satellite machines (for spawn dialog machine picker). */
  machines?: ConnectedMachine[];
  workerId?: string;
  content?: string;
  messages?: ChatEntry[];
  full?: boolean;
  error?: string;
  position?: number;
  admin?: boolean;
  reviews?: ReviewItem[];
  review?: ReviewItem;
  /** VAPID public key for Web Push subscription */
  vapidKey?: string;
  /** Whether push is subscribed on this connection */
  subscribed?: boolean;
  /** On-demand worker context snapshot used by the dashboard viewer. */
  context?: WorkerContextSnapshot | null;
  requestId?: string;
  ok?: boolean;
  upload?: UploadedFileRef;
  /** Presence payload for connected users. */
  users?: HiveUser[];
  /** Activity feed payload. */
  userId?: string;
  userName?: string;
  action?: string;
  timestamp?: number;
}
