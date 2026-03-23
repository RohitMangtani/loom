/**
 * Hive Hook Protocol
 *
 * Claude Code hooks deliver telemetry to the daemon via HTTP POST to /hook.
 * Each hook event includes session_id, hook_event_name, and optional tool metadata.
 *
 * Hook events are the fastest status signal (~350ms latency).
 * JSONL tail analysis runs on a 3s scan interval as a second layer.
 */

/** Events that Claude Code fires via hooks. */
export type HookEventName =
  | "SessionStart"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PostToolUse"
  | "Stop"
  | "SubagentStart"
  | "SubagentStop"
  | "Notification";

/** Notification subtypes delivered via the Notification hook. */
export type NotificationType =
  | "permission_prompt"   // Agent waiting for user approval → status: stuck
  | "idle_prompt";        // Between-turns waiting → NOT stuck (do not auto-respond)

/** Body of a hook POST to /hook. */
export interface HookEventBody {
  session_id: string;
  hook_event_name: HookEventName;
  /** Tool name for PreToolUse/PostToolUse. */
  tool_name?: string;
  /** Tool input parameters for PreToolUse. */
  tool_input?: Record<string, unknown>;
  /** Working directory of the Claude Code session. */
  cwd?: string;
  /** Notification-specific fields. */
  notifType?: NotificationType;
  notifMessage?: string;
  /** Summary text for Stop events. */
  summary?: string;
}

/**
 * Hook response  --  can influence tool execution.
 *
 * PreToolUse hooks can return a decision to allow/block the tool call.
 * Most hooks return undefined (no influence on execution).
 */
export interface HookResponse {
  decision?: "allow" | "block";
  reason?: string;
}

/** Body of a POST to /api/register-tty (called by identity.sh). */
export interface RegisterTtyBody {
  session_id: string;
  tty: string;
}
