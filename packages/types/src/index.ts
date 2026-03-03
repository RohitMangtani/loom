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
  type: "spawn" | "kill" | "message" | "selection" | "list" | "orchestrator" | "subscribe" | "unsubscribe";
  workerId?: string;
  project?: string;
  task?: string;
  content?: string;
  optionIndex?: number;
}

export interface ChatEntry {
  role: "user" | "agent" | "tool";
  text: string;
  timestamp?: number;
}

export interface DaemonResponse {
  type: "workers" | "worker_update" | "chat" | "chat_history" | "orchestrator" | "error" | "queued";
  workers?: WorkerState[];
  worker?: WorkerState;
  workerId?: string;
  content?: string;
  messages?: ChatEntry[];
  error?: string;
  position?: number;
}
