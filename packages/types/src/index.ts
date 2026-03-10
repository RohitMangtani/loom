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
  /** Which AI tool this worker is running (e.g. "claude", "codex"). Defaults to "claude". */
  model?: string;
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
  type: "spawn" | "kill" | "message" | "selection" | "list" | "orchestrator" | "subscribe" | "unsubscribe" | "suggestion_feedback";
  workerId?: string;
  project?: string;
  task?: string;
  content?: string;
  optionIndex?: number;
  /** Phase 4: which suggestion label was applied */
  appliedLabel?: string;
  /** Phase 4: all suggestion labels that were shown */
  shownLabels?: string[];
}

export interface ChatEntry {
  role: "user" | "agent" | "tool";
  text: string;
  timestamp?: number;
  /** Client-only: tracks optimistic entries for dedup against server echoes */
  _optimisticId?: string;
}

export interface DaemonResponse {
  type: "workers" | "worker_update" | "chat" | "chat_history" | "orchestrator" | "error" | "queued" | "auth";
  workers?: WorkerState[];
  worker?: WorkerState;
  workerId?: string;
  content?: string;
  messages?: ChatEntry[];
  full?: boolean;
  error?: string;
  position?: number;
  admin?: boolean;
}
