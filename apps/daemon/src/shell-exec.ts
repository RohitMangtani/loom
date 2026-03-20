import { execFile } from "child_process";
import { existsSync, realpathSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export interface ShellExecRequest {
  command: string;
  cwd?: string;
  timeoutMs?: number;
}

export interface ShellExecResult {
  ok: boolean;
  command: string;
  cwd: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_CHARS = 64_000;

function truncateOutput(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  const omitted = text.length - MAX_OUTPUT_CHARS;
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n...[truncated ${omitted} chars]`;
}

export function normalizeExecTimeout(timeoutMs?: number): number {
  if (!Number.isFinite(timeoutMs)) return DEFAULT_TIMEOUT_MS;
  return Math.max(1_000, Math.min(MAX_TIMEOUT_MS, Number(timeoutMs)));
}

export function resolveExecCwd(
  rawCwd: string | undefined,
  resolveProjectPath?: (value: string) => string,
  options?: { validateExists?: boolean },
): { cwd?: string; error?: string } {
  if (!rawCwd || rawCwd === "~") {
    return { cwd: homedir() };
  }

  let candidate = rawCwd.startsWith("~/")
    ? join(homedir(), rawCwd.slice(2))
    : rawCwd;

  if (!candidate.startsWith("/")) {
    candidate = resolveProjectPath ? resolveProjectPath(candidate) : join(homedir(), candidate);
  }

  if (options?.validateExists !== false) {
    if (!existsSync(candidate)) {
      return { error: `Working directory not found: ${candidate}` };
    }

    try {
      candidate = realpathSync(candidate);
    } catch {
      // Keep the original candidate if realpath resolution fails.
    }
  }

  return { cwd: candidate };
}

export function runShellExec(request: ShellExecRequest): Promise<ShellExecResult> {
  const timeoutMs = normalizeExecTimeout(request.timeoutMs);
  const cwd = request.cwd || homedir();
  const startedAt = Date.now();

  return new Promise((resolve) => {
    execFile(
      "/bin/zsh",
      ["-lc", request.command],
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        encoding: "utf-8",
      },
      (err, stdout = "", stderr = "") => {
        const durationMs = Date.now() - startedAt;
        const exitCode = err && typeof err.code === "number" ? err.code : (err ? null : 0);
        const timedOut = Boolean(err && "killed" in err && err.killed && "signal" in err && err.signal === "SIGTERM");
        const truncatedStdout = truncateOutput(stdout);
        let truncatedStderr = truncateOutput(stderr);
        if (err && !truncatedStderr && err.message) {
          truncatedStderr = truncateOutput(err.message);
        }

        resolve({
          ok: !err,
          command: request.command,
          cwd,
          stdout: truncatedStdout,
          stderr: truncatedStderr,
          exitCode,
          timedOut,
          durationMs,
          ...(err ? { error: err.message } : {}),
        });
      },
    );
  });
}
