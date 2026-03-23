/**
 * Hive REST API Protocol
 *
 * All endpoints are on port 3001 and require Bearer token authentication
 * (Authorization header or ?token= query param). Token stored at ~/.hive/token.
 *
 * Organized by domain: workers, messaging, queue, coordination, reviews,
 * swarm control, and diagnostics.
 */

// ── Shared types (re-exported from @hive/types for convenience) ──────

export type WorkerStatus = "working" | "idle" | "stuck" | "waiting";

export interface WorkerState {
  id: string;
  pid: number;
  project: string;
  projectName: string;
  status: WorkerStatus;
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
  model?: string;
  quadrant?: number;
  promptType?: "trust" | "sandbox" | null;
  promptMessage?: string;
  terminalPreview?: string;
  machine?: string;
  machineLabel?: string;
}

// ── Workers ──────────────────────────────────────────────────────────

/** GET /api/workers → WorkerState[] */
export type GetWorkersResponse = WorkerState[];

/** GET /api/context?workerId=X&history=1&historyLimit=6 */
export interface WorkerContextSnapshot {
  workerId: string;
  quadrant?: number;
  tty?: string;
  model: string;
  project: string;
  projectName: string;
  status: WorkerStatus;
  currentAction: string | null;
  lastAction: string;
  lastDirection?: string;
  recentArtifacts: Array<{ path: string; action: string; ts: number }>;
  recentMessages: Array<{ role: "user" | "agent" | "tool"; text: string; timestamp?: number }>;
  contextSummary: string;
}

// ── Messaging ────────────────────────────────────────────────────────

/** POST /api/message */
export interface SendMessageBody {
  workerId: string;
  content: string;
  /** Source worker ID (for peer-to-peer dispatch). */
  from?: string;
  /** Include context from these workers in the message. */
  contextWorkerIds?: string[];
  /** Include sender's context automatically. */
  includeSenderContext?: boolean;
}

export type SendMessageResponse =
  | { ok: true; queued?: boolean; id?: string; position?: number }
  | { ok: false; error: string };

/** GET /api/message-queue */
export type GetMessageQueueResponse = Record<string, Array<{
  id: string;
  preview: string;
  source: string;
  queuedAt: number;
}>>;

/** DELETE /api/message-queue/:id */
export type CancelMessageResponse =
  | { ok: true; cancelled: string }
  | { error: string };

// ── Task Queue ───────────────────────────────────────────────────────

/** POST /api/queue */
export interface QueueTaskBody {
  task: string;
  project?: string;
  priority?: number;
  /** ID of another task that must complete first. */
  blockedBy?: string;
  /** Group tasks into a sequential workflow. */
  workflowId?: string;
  /** Run verification after task completion. */
  verify?: boolean;
  maxVerifyAttempts?: number;
  /** Auto-commit artifacts on completion. */
  autoCommit?: boolean;
  /** Required machine capabilities (e.g., ["gpu", "docker"]). */
  requires?: string[];
  /** Preferred machine for dispatch. */
  preferMachine?: string;
  /** Preferred agent model ("claude", "codex", etc.). */
  model?: string;
}

export interface QueuedTask {
  id: string;
  task: string;
  project?: string;
  priority: number;
  blockedBy?: string;
  workflowId?: string;
  createdAt: number;
  verify?: boolean;
  maxVerifyAttempts?: number;
  autoCommit?: boolean;
  requires?: string[];
  preferMachine?: string;
  model?: string;
}

export type QueueTaskResponse = { ok: true; task: QueuedTask; remaining: number };
export type GetQueueResponse = QueuedTask[];

// ── Coordination ─────────────────────────────────────────────────────

/** POST /api/locks */
export interface AcquireLockBody {
  workerId: string;
  path: string;
}

export type AcquireLockResponse =
  | { ok: true; locked: string }
  | { error: string; holder: { workerId: string; tty?: string; lockedAt: number } };

/** GET /api/locks */
export type GetLocksResponse = Array<{
  path: string;
  workerId: string;
  tty?: string;
  lockedAt: number;
}>;

/** POST /api/scratchpad */
export interface SetScratchpadBody {
  key: string;
  value: string;
  setBy: string;
}

export interface ScratchpadEntry {
  value: string;
  setBy: string;
  setAt: number;
  expiresAt: number;
}

/** GET /api/conflicts?path=X&excludeWorker=Y */
export interface ConflictCheckResponse {
  path: string;
  conflicts: Array<{ workerId: string; tty?: string; action: string; ts: number }>;
  hasConflict: boolean;
}

/** GET /api/artifacts?workerId=X */
export type GetArtifactsResponse =
  | Array<{ path: string; action: string; ts: number }>
  | Record<string, Array<{ path: string; action: string; ts: number }>>;

// ── Learnings ────────────────────────────────────────────────────────

/** POST /api/learning */
export interface PostLearningBody {
  project: string;
  lesson: string;
}

/** GET /api/learnings?q=keyword&project=X&limit=5 */
export interface SearchLearningsResponse {
  query: string | null;
  count: number;
  total: number;
  results: Array<{ project: string; entry: string; score: number }>;
}

// ── Reviews ──────────────────────────────────────────────────────────

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
  artifacts?: Array<{ path: string; action: string }>;
}

/** POST /api/reviews */
export interface PostReviewBody {
  summary: string;
  url?: string;
  type?: ReviewItem["type"];
  workerId?: string;
}

// ── Swarm Control ────────────────────────────────────────────────────

/** POST /api/spawn */
export interface SpawnBody {
  project?: string;
  model?: string;
  task?: string;
  targetQuadrant?: number;
  /** Target machine. Omit or "local" for this computer. */
  machine?: string;
}

/** POST /api/kill */
export interface KillBody {
  workerId: string;
}

/** POST /api/exec */
export interface ExecBody {
  command: string;
  cwd?: string;
  timeoutMs?: number;
  machine?: string;
}

export interface ExecResponse {
  ok: boolean;
  machine: string;
  command: string;
  cwd: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  error?: string;
}

/** POST /api/satellites/repair */
export interface SatelliteRepairBody {
  machine: string;
  action?: string;
}

/** GET /api/projects */
export interface ProjectsResponse {
  projects: Array<{
    name: string;
    path: string;
    machines?: Record<string, string>;
  }>;
}

/** GET /api/models */
export type ModelsResponse = Array<{ id: string; label: string }>;

/** GET /api/capabilities */
export interface MachineCapabilities {
  gpu?: boolean;
  gpuName?: string;
  ramGb?: number;
  cpuCores?: number;
  diskFreeGb?: number;
  ffmpeg?: boolean;
  docker?: boolean;
  python?: boolean;
  node?: boolean;
  pytorch?: boolean;
  tensorflow?: boolean;
  tags?: string[];
  platform?: string;
  arch?: string;
  projects?: Record<string, string>;
}

export type CapabilitiesResponse = Record<string, MachineCapabilities>;

// ── Diagnostics ──────────────────────────────────────────────────────

/** GET /api/signals?workerId=X */
export type SignalsResponse = Record<string, Array<{ ts: number; signal: string; detail: string }>>;

/** GET /api/audit?tty=X */
export type AuditResponse = Array<{
  ts: string;
  tty: string;
  from: string;
  to: string;
  reason: string;
  context: Record<string, unknown>;
}>;

/** GET /api/debug */
export interface DebugResponse {
  sessionToWorker: Record<string, string>;
  sessionFiles: Record<string, string>;
  lastHookTime: Record<string, number>;
  signalCounts: Record<string, number>;
  pendingHookQueue: Record<string, number>;
}
