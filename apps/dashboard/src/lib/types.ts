export interface WorkerState {
  id: string;
  pid: number;
  project: string;
  projectName: string;
  status: "working" | "waiting" | "stuck" | "idle";
  currentAction: string | null;
  lastAction: string;
  lastActionAt: number;
  errorCount: number;
  startedAt: number;
  task: string | null;
}

export interface DaemonMessage {
  type: "spawn" | "kill" | "message" | "list" | "orchestrator";
  workerId?: string;
  project?: string;
  task?: string;
  content?: string;
  token: string;
}

export interface DaemonResponse {
  type: "workers" | "worker_update" | "chat" | "orchestrator" | "error";
  workers?: WorkerState[];
  worker?: WorkerState;
  workerId?: string;
  content?: string;
  error?: string;
}
