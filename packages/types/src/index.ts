export interface Suggestion {
  label: string;
  message: string;
  reason?: string;
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
  /** Server-assigned quadrant (1-4). Dashboard should use this for slot ordering. */
  quadrant?: number;
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

export interface DaemonMessage {
  type: "spawn" | "kill" | "message" | "selection" | "list" | "orchestrator" | "subscribe" | "unsubscribe" | "suggestion_feedback" | "review_seen" | "review_dismiss" | "review_seen_all" | "review_clear_all";
  workerId?: string;
  project?: string;
  task?: string;
  content?: string;
  /** Model to spawn: "claude", "codex", or "openclaw". Defaults to "claude". */
  model?: string;
  /** Target quadrant (1-4) for spawn. If set, places the terminal in this quadrant. */
  targetQuadrant?: number;
  optionIndex?: number;
  /** Phase 4: which suggestion label was applied */
  appliedLabel?: string;
  /** Phase 4: all suggestion labels that were shown */
  shownLabels?: string[];
  /** Review ID for review mutations */
  reviewId?: string;
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
}

export interface DaemonResponse {
  type: "workers" | "worker_update" | "chat" | "chat_history" | "orchestrator" | "error" | "queued" | "auth" | "reviews" | "review_added";
  workers?: WorkerState[];
  worker?: WorkerState;
  workerId?: string;
  content?: string;
  messages?: ChatEntry[];
  full?: boolean;
  error?: string;
  position?: number;
  admin?: boolean;
  reviews?: ReviewItem[];
  review?: ReviewItem;
}
