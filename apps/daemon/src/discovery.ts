import { execFileSync } from "child_process";
import { appendFileSync, readdirSync, statSync } from "fs";
import { basename, dirname, join } from "path";
import type { TelemetryReceiver } from "./telemetry.js";
import type { SessionStreamer } from "./session-stream.js";
import type { WorkerState } from "./types.js";
import { readTail } from "./utils.js";

/** Quadrant Audit — logs every status transition with full decision context */
interface AuditEntry {
  ts: string;
  tty: string;
  from: string;
  to: string;
  reason: string;
  context: Record<string, unknown>;
}

const HOME = process.env.HOME || `/Users/${process.env.USER}`;
const AUDIT_LOG_PATH = join(HOME, ".hive", "quadrant-audit.log");
const AUDIT_MAX_ENTRIES = 500;

interface ProcessInfo {
  pid: number;
  cpuPercent: number;
  startedAt: number;
  tty: string;
  cwd: string;
  project: string;
  projectName: string;
  sessionIds: string[];
  jsonlFile: string | null;
}

/** Parsed context from a session JSONL tail */
interface SessionContext {
  projectName: string | null;
  latestAction: string | null;
  lastDirection: string | null;
  status: "working" | "idle";
  fileAgeMs: number;
  /** true when status="working" comes from a definitive signal (tool_use at tail,
   *  fresh user input). false when it's a low-confidence fallback (no-pattern,
   *  noise-driven mid-stream, stale file heuristic). runJsonlAnalysis uses this
   *  to decide whether JSONL alone can override a stable idle state. */
  highConfidence: boolean;
}

export class ProcessDiscovery {
  private telemetry: TelemetryReceiver;
  private streamer: SessionStreamer;
  private discoveredPids = new Set<number>();
  private daemonPid = process.pid;
  private prevStatus = new Map<string, string>();
  private auditLog: AuditEntry[] = [];
  // Hysteresis: count consecutive idle signals per worker.
  // Require 2+ before transitioning working→idle (prevents single-scan flapping).
  private consecutiveIdleChecks = new Map<string, number>();
  // Cooldown: timestamp of last confirmed working state per worker.
  // Prevents working→idle flicker during API thinking gaps where hooks
  // go stale but the agent is still processing.
  private lastConfirmedWorking = new Map<string, number>();
  // PTY stdout byte offset tracking for output flow detection.
  // Stores the last known FD 1 offset per PID. If the offset increases
  // between scans, the process is writing to the terminal = working.
  private prevPtyOffset = new Map<number, number>();

  constructor(telemetry: TelemetryReceiver, streamer: SessionStreamer) {
    this.telemetry = telemetry;
    this.streamer = streamer;
  }

  /** Record a status transition with full decision context */
  private audit(
    tty: string,
    workerId: string,
    from: string,
    to: string,
    reason: string,
    context: Record<string, unknown>
  ): void {
    const entry: AuditEntry = {
      ts: new Date().toISOString(),
      tty,
      from,
      to,
      reason,
      context,
    };
    this.auditLog.push(entry);
    if (this.auditLog.length > AUDIT_MAX_ENTRIES) {
      this.auditLog = this.auditLog.slice(-300);
    }
    // Also append to file for persistence across restarts
    try {
      appendFileSync(AUDIT_LOG_PATH, JSON.stringify(entry) + "\n");
    } catch { /* non-critical */ }
    console.log(`[audit] ${tty}: ${from} → ${to} — ${reason}`);
  }

  /** Check if status changed and log the transition */
  private checkTransition(
    workerId: string,
    tty: string,
    newStatus: string,
    reason: string,
    context: Record<string, unknown>
  ): void {
    const prev = this.prevStatus.get(workerId) || "unknown";
    if (prev !== newStatus) {
      this.audit(tty, workerId, prev, newStatus, reason, context);
      this.prevStatus.set(workerId, newStatus);
    }
  }

  /** Get streamer's cached session files per worker (for debug endpoint) */
  getSessionFiles(): Record<string, string> {
    const files: Record<string, string> = {};
    for (const w of this.telemetry.getAll()) {
      const f = this.streamer.getSessionFile(w.id);
      if (f) files[w.id] = basename(f);
    }
    return files;
  }

  /** Get the audit log (for WebSocket API / debugging) */
  getAuditLog(tty?: string): AuditEntry[] {
    if (tty) return this.auditLog.filter(e => e.tty === tty);
    return [...this.auditLog];
  }

  scan(): void {
    const processes = this.findClaudeProcesses();
    const alivePids = new Set<number>();

    for (const proc of processes) {
      alivePids.add(proc.pid);
      const id = `discovered_${proc.pid}`;

      // Register session→worker mappings for hook lookups
      for (const sid of proc.sessionIds) {
        this.telemetry.registerSession(sid, id);
      }

      // Register session file with streamer for chat history.
      // Priority: lsof JSONL path > session ID match > birthtime match.
      // Never use "most recently modified in cwd dir" — when multiple workers
      // share the same cwd (e.g. home dir), it picks the wrong worker's file.
      let sessionFile: string | null = proc.jsonlFile; // Direct from lsof — most reliable
      if (!sessionFile && proc.sessionIds.length > 0) {
        sessionFile = this.streamer.findSessionFile(proc.sessionIds);
        if (!sessionFile) {
          const jsonl = this.findBestJsonlFile(proc.sessionIds);
          if (jsonl) sessionFile = jsonl.path;
        }
      }
      // Fallback: match JSONL by creation time closest to process start.
      // Each Claude session creates a fresh JSONL, so birthtime ≈ startedAt.
      // Safe even with shared cwd — birthtimes are unique per session.
      if (!sessionFile) {
        sessionFile = this.findSessionFileByStartTime(proc.cwd, proc.startedAt);
      }

      // Stale-file recovery: when context compaction creates a new session,
      // the old JSONL stops being written to. If the cached file is stale
      // (>2min), search for a successor JSONL in the same directory.
      // DO NOT reduce below 120s — long subagent chains (Task tool) cause
      // 30-90s gaps in JSONL writes. At 30s, stale-file recovery triggers
      // mid-task and grabs ANOTHER worker's file (cross-contamination)
      // when multiple workers share the same project directory.
      const effectiveFile = sessionFile || this.streamer.getSessionFile(id);
      if (effectiveFile) {
        try {
          const age = Date.now() - statSync(effectiveFile).mtimeMs;
          if (age > 120_000) {
            const newer = this.findNewerSessionFile(effectiveFile, id);
            if (newer) sessionFile = newer;
          }
        } catch { /* file gone */ }
      }

      if (sessionFile) {
        this.streamer.setSessionFile(id, sessionFile);

        // Register the JSONL filename UUID as a session→worker mapping.
        // This is critical: lsof only catches file handles that are open at
        // the moment of the scan (appendFileSync opens+closes instantly).
        // Many workers have 0 lsof-derived session IDs. But the JSONL filename
        // IS the session UUID that Claude Code sends in hook payloads.
        // Registering it here ensures hooks route by session ID — not the
        // ambiguous CWD fallback that causes cross-contamination.
        const fileUuid = basename(sessionFile, ".jsonl");
        if (/^[0-9a-f-]{36}$/.test(fileUuid)) {
          this.telemetry.registerSession(fileUuid, id);
        }
      }

      if (this.discoveredPids.has(proc.pid)) {
        const existing = this.telemetry.get(id);
        if (existing) {
          // Re-identify project on every scan
          if (proc.projectName !== "unknown") {
            existing.project = proc.project;
            existing.projectName = proc.projectName;
          }

          // Use streamer's cached session file — guaranteed to be THIS worker's
          // file. Never use findBestJsonlFile for status detection; its cwd
          // fallback can pick another worker's file (cross-contamination).
          const cachedPath = this.streamer.getSessionFile(id);
          let cachedMtime = 0;
          if (cachedPath) {
            try { cachedMtime = statSync(cachedPath).mtimeMs; } catch { /* file gone */ }
          }

          // LAYER 1: JSONL mtime heartbeat — refresh lastActionAt so
          // telemetry.tick() doesn't interfere while discovery is active.
          if (cachedMtime > 0 && Date.now() - cachedMtime < 30_000) {
            existing.lastActionAt = Date.now();
          }

          // LAYER 2: Deep JSONL analysis when hooks are stale.
          // When no hooks have EVER arrived, treat as very stale (60s) so JSONL
          // analysis runs. Avoids both extremes: 0 (thinks hooks fresh, skips
          // JSONL) and Date.now() (1.7B ms → bogus audit entries).
          const lastHook = this.telemetry.getLastHookTime(id);
          const hookAge = lastHook ? Date.now() - lastHook : 60_000;
          const tty = existing.tty || "?";
          const auditCtx = {
            hookAgeMs: Math.round(hookAge),
            cachedPath: cachedPath ? basename(cachedPath) : null,
            fileAgeMs: cachedMtime > 0 ? Math.round(Date.now() - cachedMtime) : null,
            prevStatus: existing.status,
            action: existing.currentAction,
          };

          if (hookAge < 5_000) {
            // Hooks are live (<5s) — trust hook-set status directly
            if (existing.status === "working") this.lastConfirmedWorking.set(id, Date.now());
            this.checkTransition(id, tty, existing.status, `hooks fresh (${Math.round(hookAge)}ms)`, auditCtx);
          } else if (hookAge < 15_000) {
            // Hooks recent (<15s) — trust hook state for stuck/toolInFlight
            if (existing.status === "stuck") {
              this.checkTransition(id, tty, "stuck", "hook-trusted stuck", auditCtx);
            } else if (this.telemetry.isToolInFlight(id)) {
              existing.status = "working";
              this.checkTransition(id, tty, "working", "hook-trusted toolInFlight", auditCtx);
            } else {
              // Fall through to JSONL analysis below
              this.runJsonlAnalysis(id, existing, tty, cachedPath, cachedMtime, hookAge, auditCtx);
            }
          } else {
            // Hooks stale (>15s) — check for long-running tools before JSONL analysis.
            // The Agent tool spawns a subagent that runs for minutes. During this time,
            // the parent process goes completely silent (no hooks, no JSONL writes).
            // toolInFlight persists from the PreToolUse hook — trust it up to 10 minutes.
            const inflight = this.telemetry.getToolInFlight(id);
            if (inflight && Date.now() - inflight.since < 600_000) {
              existing.status = "working";
              this.lastConfirmedWorking.set(id, Date.now());
              this.checkTransition(id, tty, "working", `toolInFlight: ${inflight.tool} (${Math.round((Date.now() - inflight.since) / 1000)}s)`, auditCtx);
            } else {
              // No tool in flight (or timed out) — JSONL analysis is the authority
              this.runJsonlAnalysis(id, existing, tty, cachedPath, cachedMtime, hookAge, auditCtx);
            }
          }

          this.telemetry.notifyExternal(existing);
        }
        continue;
      }

      // New process — read JSONL for initial status
      const ctx = this.readSessionContext(proc.sessionIds, proc.cwd);

      const worker: WorkerState = {
        id,
        pid: proc.pid,
        project: proc.project,
        projectName: ctx.projectName || proc.projectName,
        status: ctx.status,
        currentAction: ctx.status === "working" ? (ctx.latestAction || "Working...") : null,
        lastAction: ctx.latestAction || "Discovered on machine",
        lastActionAt: Date.now(),
        errorCount: 0,
        startedAt: proc.startedAt,
        task: null,
        managed: false,
        tty: proc.tty,
        lastDirection: ctx.lastDirection || undefined,
      };

      this.telemetry.registerDiscovered(id, worker);
      this.discoveredPids.add(proc.pid);

      // If the worker is already idle at discovery (e.g. daemon restart while
      // agents are waiting for input), set idleConfirmed so the 120s grace
      // period in runJsonlAnalysis doesn't phantom-green them. Without this,
      // noise JSONL writes (file-history-snapshot) keep fileAge fresh and the
      // grace fires, making an idle agent flash green every scan cycle.
      if (ctx.status === "idle") {
        this.telemetry.setIdleConfirmed(id, true);
      }
    }

    // Remove dead processes
    for (const pid of this.discoveredPids) {
      if (!alivePids.has(pid)) {
        this.telemetry.removeWorker(`discovered_${pid}`);
        this.discoveredPids.delete(pid);
        this.prevPtyOffset.delete(pid);
      }
    }
  }

  /**
   * Core status decision from JSONL tail analysis.
   * Called when hooks are stale/absent and we need ground truth.
   *
   * Philosophy: GREEN until proven RED.
   *   - tool_use at tail = working (regardless of file age — tools can run hours)
   *   - tool_result/user at tail = thinking (generous 5min threshold for subagents)
   *   - assistant-text at tail + file fresh (<30s) = mid-stream (working)
   *   - assistant-text at tail + file stale (>30s) = likely idle
   *   - idleConfirmed from hook = definitive idle
   */
  private runJsonlAnalysis(
    id: string,
    existing: WorkerState,
    tty: string,
    cachedPath: string | null,
    cachedMtime: number,
    hookAge: number,
    auditCtx: Record<string, unknown>,
  ): void {
    if (!cachedPath) {
      // No JSONL at all — keep last known status
      this.checkTransition(id, tty, existing.status, "no cachedPath, keep last", auditCtx);
      return;
    }

    const ctx = this.readSessionContextFromFile(cachedPath);
    const tailCtx = { ...auditCtx, tailStatus: ctx.status, tailAction: ctx.latestAction, tailFileAgeMs: Math.round(ctx.fileAgeMs) };

    if (ctx.projectName) {
      existing.projectName = ctx.projectName;
    }
    if (ctx.lastDirection) {
      existing.lastDirection = ctx.lastDirection;
    }

    // idleConfirmed = idle_prompt hook fired OR hysteresis confirmed idle.
    // Definitive RED — unless we know new input was just sent OR the process
    // is actively consuming CPU/PTY (agent thinking without tool calls).
    const isIdleConfirmed = this.telemetry.isIdleConfirmed(id);
    if (isIdleConfirmed) {
      // Don't enforce idleConfirmed if input was sent recently — the agent
      // is about to (or just did) receive new work. Let normal analysis decide.
      const lastInput = this.telemetry.getLastInputSent(id);
      const recentInput = lastInput > 0 && Date.now() - lastInput < 15_000;
      // Also override if JSONL tail shows high-confidence working (e.g., user
      // typed directly in Terminal — no markInputSent, but JSONL has real user
      // input at tail). Safe: highConfidence=false for noise, so phantom green
      // can't sneak through.
      const jsonlOverride = ctx.status === "working" && ctx.highConfidence;
      // LAYER 8 override: CPU/PTY activity can break out of idleConfirmed.
      // This catches the case where an idle agent starts thinking (high CPU)
      // but no hooks fire because it hasn't called any tools yet.
      const cpuPct = this.getCpuForPid(existing.pid);
      const ptyDelta = this.getPtyOutputDelta(existing.pid);
      const cpuOverride = cpuPct > 8 || ptyDelta > 100;
      if (!recentInput && !jsonlOverride && !cpuOverride) {
        if (ctx.latestAction) existing.lastAction = ctx.latestAction;
        existing.status = "idle";
        existing.currentAction = null;
        this.telemetry.recordSignal(id, "jsonl_analysis", `idle (idleConfirmed) fileAge=${Math.round(ctx.fileAgeMs/1000)}s cpu=${cpuPct.toFixed(1)}%`);
        this.checkTransition(id, tty, "idle", `idleConfirmed=true fileAge=${Math.round(ctx.fileAgeMs/1000)}s cpu=${cpuPct.toFixed(1)}%`, tailCtx);
        return;
      }
      if (cpuOverride) {
        // CPU/PTY active — clear idleConfirmed and fall through to normal analysis
        this.telemetry.setIdleConfirmed(id, false);
        const signal = ptyDelta > 100 ? `PTY +${ptyDelta}B` : `CPU ${cpuPct.toFixed(1)}%`;
        this.telemetry.recordSignal(id, cpuPct > 8 ? "cpu_wakeup" : "pty_wakeup", signal);
      }
      // Recent input / JSONL / CPU overrides idleConfirmed — fall through to normal analysis
    }

    // Guard: External input sent recently, JSONL hasn't caught up
    const lastInput = this.telemetry.getLastInputSent(id);
    if (lastInput > 0 && cachedMtime < lastInput && Date.now() - lastInput < 15_000) {
      this.checkTransition(id, tty, existing.status, "input-sent guard (keep)", { ...tailCtx, lastInputMs: Math.round(Date.now() - lastInput) });
      return;
    }

    if (ctx.status === "working") {
      // FIX 1 — Corroboration guard: when the agent is stable-idle and JSONL
      // returns a low-confidence working signal (noise-driven "Thinking...",
      // no-pattern fallback), require corroboration from hooks or input_sent
      // before flipping green. Prevents phantom green flicker.
      if (existing.status === "idle" && !ctx.highConfidence) {
        const lastInput = this.telemetry.getLastInputSent(id);
        const recentInput = lastInput > 0 && Date.now() - lastInput < 15_000;
        const hooksFresh = hookAge < 5_000;
        if (!recentInput && !hooksFresh) {
          this.checkTransition(id, tty, "idle", `JSONL tail working but low-confidence, staying idle (hookAge=${Math.round(hookAge/1000)}s)`, tailCtx);
          return;
        }
      }
      // JSONL tail says working (tool_use at tail, or user/tool_result with fresh file)
      this.consecutiveIdleChecks.set(id, 0); // reset hysteresis
      // Only set lastConfirmedWorking from high-confidence signals (tool_use at
      // tail, real hooks). Low-confidence signals (mid-stream heuristic, noise-
      // driven) must NOT set the cooldown timer — otherwise a 1s "ok" response
      // keeps the agent green for 25s because the mid-stream check touched it.
      if (ctx.highConfidence) {
        this.lastConfirmedWorking.set(id, Date.now());
      }
      existing.status = "working";
      existing.currentAction = ctx.latestAction || "Thinking...";
      existing.lastAction = ctx.latestAction || existing.lastAction;
      existing.lastActionAt = Date.now();
      // FIX 3 (partial) — Clear idleConfirmed when we have real evidence of work.
      // Ensures genuine transitions aren't blocked by stale idleConfirmed.
      this.telemetry.setIdleConfirmed(id, false);
      this.checkTransition(id, tty, "working", `JSONL tail: ${ctx.latestAction || "thinking"}`, tailCtx);
    } else {
      // JSONL tail says idle (assistant-text at tail, no tool_use).
      // Hysteresis: require 2 consecutive idle signals before transitioning
      // working→idle. Prevents single-scan flapping where "file is fresh"
      // momentarily overrides a hook-confirmed idle, then hooks re-set idle.
      const idleCount = (this.consecutiveIdleChecks.get(id) || 0) + 1;
      this.consecutiveIdleChecks.set(id, idleCount);

      // If already idle (e.g. hooks set it), don't override to working
      // just because the file is fresh. The "idle but fresh" grace only
      // applies when we're currently working and unsure if we should go idle.
      if (existing.status === "idle") {
        // LAYER 8 — idle→working recovery: even when idle, check if the
        // process woke up (high CPU or PTY output). This catches agents that
        // start thinking after being idle — no hooks fire during thinking,
        // but CPU spikes immediately.
        const cpuPct = this.getCpuForPid(existing.pid);
        const ptyDelta = this.getPtyOutputDelta(existing.pid);
        if (cpuPct > 8 || ptyDelta > 100) {
          const signal = ptyDelta > 100 ? `PTY +${ptyDelta}B` : `CPU ${cpuPct.toFixed(1)}%`;
          existing.status = "working";
          existing.currentAction = "Thinking...";
          existing.lastActionAt = Date.now();
          this.consecutiveIdleChecks.set(id, 0);
          this.telemetry.setIdleConfirmed(id, false);
          this.telemetry.recordSignal(id, cpuPct > 8 ? "cpu_wakeup" : "pty_wakeup", signal);
          this.checkTransition(id, tty, "working", `Idle→working via ${signal}`, { ...tailCtx, cpuPct, ptyDelta });
        } else {
          if (ctx.latestAction) existing.lastAction = ctx.latestAction;
          this.checkTransition(id, tty, "idle", `JSONL tail idle, already idle (count=${idleCount}) cpu=${cpuPct.toFixed(1)}%`, tailCtx);
        }
      } else if (ctx.fileAgeMs < 120_000 && idleCount < 2 && hookAge < 30_000) {
        // File written in last 2 min AND first idle signal AND hooks recently
        // active (<30s) — stay GREEN. All three conditions required:
        //   - fileAgeMs < 120s: covers subagent chains (30-90s JSONL gaps)
        //   - idleCount < 2: hysteresis prevents single-scan flapping
        //   - hookAge < 30s: ensures hooks confirm the agent is actually working.
        //     Without this, noise JSONL writes (file-history-snapshot, system)
        //     keep fileAge fresh even when idle → phantom green.
        existing.status = "working";
        existing.currentAction = ctx.latestAction || "Thinking...";
        existing.lastAction = ctx.latestAction || existing.lastAction;
        existing.lastActionAt = Date.now();
        this.checkTransition(id, tty, "working", `JSONL tail idle but fresh (${Math.round(ctx.fileAgeMs/1000)}s) hookAge=${Math.round(hookAge/1000)}s hysteresis=${idleCount}/2`, tailCtx);
      } else {
        // FIX 2 — Extended cooldown: 25s after last confirmed tool activity,
        // keep green. Covers the gap where Claude is generating text after
        // its last tool call (no hooks fire during text generation).
        // Was 10s which was too aggressive — complex responses take 15-30s.
        const lastWorking = this.lastConfirmedWorking.get(id) || 0;
        const workingCooldown = Date.now() - lastWorking;
        if (workingCooldown < 25_000 && existing.status === "working") {
          existing.currentAction = ctx.latestAction || "Thinking...";
          existing.lastAction = ctx.latestAction || existing.lastAction;
          existing.lastActionAt = Date.now();
          this.checkTransition(id, tty, "working", `JSONL tail idle but cooldown active (${Math.round(workingCooldown/1000)}s/25s since last confirmed working)`, tailCtx);
        } else {
          // LAYER 8 — CPU + PTY signal: check if the process is actively consuming
          // CPU or writing output to the terminal before going/staying idle.
          // Cap at 3 minutes to prevent permanent green from runaway processes.
          const cpuPct = this.getCpuForPid(existing.pid);
          const ptyDelta = this.getPtyOutputDelta(existing.pid);
          const isActive = (cpuPct > 8 || ptyDelta > 100) && workingCooldown < 180_000;

          if (isActive) {
            existing.status = "working";
            existing.currentAction = ctx.latestAction || "Generating response...";
            existing.lastAction = ctx.latestAction || existing.lastAction;
            existing.lastActionAt = Date.now();
            this.consecutiveIdleChecks.set(id, 0);
            this.telemetry.setIdleConfirmed(id, false);
            const signal = ptyDelta > 100 ? `PTY +${ptyDelta}B` : `CPU ${cpuPct.toFixed(1)}%`;
            this.telemetry.recordSignal(id, ptyDelta > 100 ? "pty_keepalive" : "cpu_keepalive", signal);
            this.checkTransition(id, tty, "working", `Output active (${signal}) — generation detected`, { ...tailCtx, cpuPct, ptyDelta });
          } else {
            // File >2 min stale OR 2+ consecutive idle signals OR cooldown expired OR CPU+PTY idle → RED
            if (ctx.latestAction) existing.lastAction = ctx.latestAction;
            existing.status = "idle";
            existing.currentAction = null;
            // FIX 3 — Lock idle after hysteresis: once the full hysteresis process
            // confirms idle (2+ checks + cooldown expired), set idleConfirmed.
            // This prevents phantom green from re-triggering on subsequent scans.
            // Only real hooks (PreToolUse/PostToolUse) or high-confidence JSONL
            // signals can clear it.
            this.telemetry.setIdleConfirmed(id, true);
            this.checkTransition(id, tty, "idle", `JSONL tail idle: fileAge=${Math.round(ctx.fileAgeMs/1000)}s hookAge=${Math.round(hookAge/1000)}s idleCount=${idleCount} cooldown=${Math.round(workingCooldown/1000)}s cpuPct=${cpuPct.toFixed(1)} ptyDelta=${ptyDelta}`, tailCtx);
          }
        }
      }
    }
  }

  /**
   * Layer 8a: Get instantaneous CPU usage for a process.
   * Returns 0 on any error (process gone, permission denied).
   * Lightweight — single `ps` call, ~5ms.
   */
  private getCpuForPid(pid: number): number {
    try {
      const out = execFileSync("ps", ["-p", String(pid), "-o", "%cpu="], {
        encoding: "utf-8",
        timeout: 2000,
      }).trim();
      return parseFloat(out) || 0;
    } catch {
      return 0;
    }
  }

  /**
   * Layer 8b: Detect terminal output flow via PTY stdout byte offset.
   * Reads the FD 1 (stdout) byte offset from lsof and compares to
   * the previous scan. If bytes increased, the process is writing
   * to the terminal = actively generating output.
   *
   * Non-invasive — reads kernel FD metadata, does not consume output.
   * Returns the byte delta (0 = no output, >0 = bytes written since last check).
   */
  private getPtyOutputDelta(pid: number): number {
    try {
      const out = execFileSync("lsof", ["-a", "-p", String(pid), "-d", "1"], {
        encoding: "utf-8",
        timeout: 2000,
      }).trim();
      // Parse the SIZE/OFF column (7th field) — format is "0t12345678"
      const lastLine = out.split("\n").pop();
      if (!lastLine) return 0;
      const fields = lastLine.trim().split(/\s+/);
      const offsetStr = fields[6] || "";
      const offset = parseInt(offsetStr.replace(/^0t/, ""), 10);
      if (isNaN(offset)) return 0;

      const prev = this.prevPtyOffset.get(pid) ?? offset;
      this.prevPtyOffset.set(pid, offset);
      return offset - prev;
    } catch {
      return 0;
    }
  }

  private findClaudeProcesses(): ProcessInfo[] {
    try {
      const raw = execFileSync("ps", ["-eo", "pid,pcpu,lstart,tty,command"], {
        encoding: "utf-8",
        timeout: 5000,
      }).trim();

      if (!raw) return [];
      const results: ProcessInfo[] = [];

      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.endsWith("claude") && !trimmed.match(/claude\s*$/)) continue;
        if (trimmed.includes("grep")) continue;

        const parts = trimmed.split(/\s+/);
        if (parts.length < 9) continue;

        const pid = parseInt(parts[0], 10);
        if (isNaN(pid) || pid === this.daemonPid) continue;

        const cpuPercent = parseFloat(parts[1]);
        const mon = parts[3];
        const day = parseInt(parts[4], 10);
        const time = parts[5];
        const year = parseInt(parts[6], 10);
        const startedAt = new Date(`${mon} ${day}, ${year} ${time}`).getTime();

        // Extract TTY from ps output (e.g., "ttys001", "??")
        const psTty = parts[7] || "";

        const info = this.getProcessInfo(pid);
        if (!info) {
          // lsof failed (process still initializing) — use ps data as fallback.
          // This ensures newly opened Claude instances get picked up immediately
          // instead of being silently skipped until lsof starts working.
          if (psTty && psTty !== "??" && psTty.startsWith("ttys")) {
            const homeDir = process.env.HOME || `/Users/${process.env.USER}`;
            results.push({
              pid, cpuPercent, startedAt,
              tty: psTty,
              cwd: homeDir,
              project: homeDir + "/unknown",
              projectName: "unknown",
              sessionIds: [],
              jsonlFile: null,
            });
          }
          continue;
        }

        // If lsof missed the TTY but ps has it, use ps
        if (!info.tty && psTty && psTty !== "??" && psTty.startsWith("ttys")) {
          info.tty = psTty;
        }

        results.push({ pid, cpuPercent, startedAt, ...info });
      }

      return results;
    } catch {
      return [];
    }
  }

  private getProcessInfo(pid: number): {
    tty: string;
    cwd: string;
    project: string;
    projectName: string;
    sessionIds: string[];
    jsonlFile: string | null;
  } | null {
    try {
      const raw = execFileSync("lsof", ["-p", String(pid), "-Fn"], {
        encoding: "utf-8",
        timeout: 5000,
      }).trim();

      const lines = raw.split("\n");
      let cwd: string | null = null;
      let tty = "";
      const sessionIds: string[] = [];
      let jsonlFile: string | null = null;

      for (let i = 0; i < lines.length; i++) {
        if (lines[i] === "fcwd" && i + 1 < lines.length && lines[i + 1].startsWith("n/")) {
          cwd = lines[i + 1].slice(1);
        }
        if (lines[i].startsWith("n/dev/tty") && !tty) {
          tty = lines[i].slice(1).replace("/dev/", "");
        }
        // Match session IDs from .claude/tasks/ OR .claude/projects/*/ paths
        const taskMatch = lines[i].match(/^n.*\/.claude\/(?:tasks|projects\/[^/]+)\/([0-9a-f-]{36})/);
        if (taskMatch && !sessionIds.includes(taskMatch[1])) {
          sessionIds.push(taskMatch[1]);
        }
        // Direct JSONL file detection — most reliable session file source
        const jsonlMatch = lines[i].match(/^n(.*\.claude\/projects\/[^/]+\/[0-9a-f-]{36}\.jsonl)$/);
        if (jsonlMatch && !jsonlFile) {
          jsonlFile = jsonlMatch[1];
        }
      }

      if (!cwd) return null;

      const projectName = this.projectNameFromCwd(cwd);
      const homeDir = process.env.HOME || `/Users/${process.env.USER}`;
      const project = (cwd === homeDir || cwd === "/")
        ? `${homeDir}/factory/projects/${projectName}`
        : cwd;

      return { tty, cwd, project, projectName, sessionIds, jsonlFile };
    } catch {
      return null;
    }
  }

  /**
   * Find the most recently modified JSONL session file.
   * Tries session IDs first (exact match), falls back to cwd-based
   * project directory search (finds agents even when lsof misses task files).
   */
  private findBestJsonlFile(sessionIds: string[], cwd?: string): { path: string; mtimeMs: number } | null {
    const homeDir = process.env.HOME || `/Users/${process.env.USER}`;
    const projectsDir = join(homeDir, ".claude", "projects");
    let bestFile: string | null = null;
    let bestMtime = 0;

    try {
      // Primary: search by session ID across all project dirs
      if (sessionIds.length > 0) {
        for (const projectDir of readdirSync(projectsDir)) {
          const fullDir = join(projectsDir, projectDir);
          for (const sessionId of sessionIds) {
            try {
              const stat = statSync(join(fullDir, `${sessionId}.jsonl`));
              if (stat.mtimeMs > bestMtime) {
                bestMtime = stat.mtimeMs;
                bestFile = join(fullDir, `${sessionId}.jsonl`);
              }
            } catch { /* doesn't exist */ }
          }
        }
      }

      // Fallback: search by cwd → Claude project directory
      // Claude Code encodes /Users/foo/bar as -Users-foo-bar
      if (!bestFile && cwd) {
        const encoded = cwd.replace(/\//g, "-");
        const candidateDir = join(projectsDir, encoded);
        try {
          for (const file of readdirSync(candidateDir)) {
            if (!file.endsWith(".jsonl")) continue;
            try {
              const stat = statSync(join(candidateDir, file));
              if (stat.mtimeMs > bestMtime) {
                bestMtime = stat.mtimeMs;
                bestFile = join(candidateDir, file);
              }
            } catch { /* skip */ }
          }
        } catch { /* dir doesn't exist */ }
      }
    } catch { /* projectsDir doesn't exist */ }

    return bestFile ? { path: bestFile, mtimeMs: bestMtime } : null;
  }

  /**
   * Find session file by matching JSONL creation time to process start time.
   * Each Claude Code session creates a fresh JSONL file on launch, so the
   * file's birthtime should be within ~30s of the process startedAt.
   * This is safe for shared-cwd scenarios (multiple home-dir sessions)
   * because birthtimes are unique per file, unlike mtime which changes constantly.
   */
  private findSessionFileByStartTime(cwd: string, startedAt: number): string | null {
    const homeDir = process.env.HOME || `/Users/${process.env.USER}`;
    const projectsDir = join(homeDir, ".claude", "projects");
    const encoded = cwd.replace(/\//g, "-");
    const candidateDir = join(projectsDir, encoded);

    let bestFile: string | null = null;
    let bestDelta = Infinity;
    const MAX_DELTA = 60_000; // 60s tolerance between process start and file creation

    try {
      for (const file of readdirSync(candidateDir)) {
        if (!file.endsWith(".jsonl")) continue;
        try {
          const stat = statSync(join(candidateDir, file));
          const delta = Math.abs(stat.birthtimeMs - startedAt);
          if (delta < MAX_DELTA && delta < bestDelta) {
            bestDelta = delta;
            bestFile = join(candidateDir, file);
          }
        } catch { /* skip */ }
      }
    } catch { /* dir doesn't exist */ }

    return bestFile;
  }

  /**
   * When the current cached JSONL is stale (>2min no writes), search the same
   * directory for a successor session file. Context compaction creates a new
   * JSONL that lsof/sessionId/birthtime detection can't find because:
   *   - lsof doesn't hold the file open continuously
   *   - Session IDs (task files) may not be created yet
   *   - Birthtime matching targets process start, not compaction time
   *
   * Safety guards against cross-contamination:
   *   1. Only picks files created AFTER the current one (successor sessions)
   *   2. Only picks actively-written files (mtime < 5 min)
   *   3. Excludes files already assigned to other workers
   *   4. Candidate mtime must be newer than current file's mtime (prevents
   *      grabbing abandoned files from other workers that happen to be born later)
   *   5. Candidate UUID must not be registered to a different worker
   *   6. Candidate must be born within 30s of current file's last modification
   *      (real compaction successors are born <1s after old file's last write;
   *      cross-contamination files from other workers have much larger gaps)
   */
  private findNewerSessionFile(currentPath: string, workerId: string): string | null {
    try {
      const dir = dirname(currentPath);
      const currentStat = statSync(currentPath);

      // Collect session files used by other workers
      const usedFiles = new Set<string>();
      for (const w of this.telemetry.getAll()) {
        if (w.id === workerId) continue;
        const f = this.streamer.getSessionFile(w.id);
        if (f) usedFiles.add(f);
      }

      let bestFile: string | null = null;
      let bestMtime = 0;
      // Fallback: newest born-after file regardless of recency (for stale compaction chains)
      let fallbackFile: string | null = null;
      let fallbackBirth = 0;

      for (const file of readdirSync(dir)) {
        if (!file.endsWith(".jsonl")) continue;
        const fullPath = join(dir, file);
        if (fullPath === currentPath) continue;
        if (usedFiles.has(fullPath)) continue;

        // Exclude files whose UUID is registered to a different worker.
        // Prevents cross-contamination when old files from other workers
        // are born after the current file but no longer actively used.
        const fileUuid = basename(file, ".jsonl");
        if (/^[0-9a-f-]{36}$/.test(fileUuid) && this.telemetry.isSessionOwnedByOther(fileUuid, workerId)) {
          continue;
        }

        try {
          const stat = statSync(fullPath);
          // Must be created AFTER the current file (successor session)
          if (stat.birthtimeMs <= currentStat.birthtimeMs) continue;

          // Must be modified MORE RECENTLY than the current file.
          // A file born after the current one but with an older mtime was
          // abandoned before the current file was last active — not a successor.
          if (stat.mtimeMs <= currentStat.mtimeMs) continue;

          // Proximity check: real compaction successors are born within seconds
          // of the old file's last write. Cross-contamination from other workers
          // shows gaps of 30s+ (e.g. 83s in observed case). Reject candidates
          // born too long after our file went stale.
          const birthGapMs = stat.birthtimeMs - currentStat.mtimeMs;
          if (birthGapMs > 30_000) continue;

          // Primary: actively-written successor (< 5 min old)
          if (Date.now() - stat.mtimeMs <= 300_000) {
            if (stat.mtimeMs > bestMtime) {
              bestMtime = stat.mtimeMs;
              bestFile = fullPath;
            }
          }

          // Fallback: newest born-after file within last hour (covers stale
          // compaction chains where successor itself went stale before scan)
          if (Date.now() - stat.birthtimeMs < 3_600_000 && stat.birthtimeMs > fallbackBirth) {
            fallbackBirth = stat.birthtimeMs;
            fallbackFile = fullPath;
          }
        } catch { /* skip */ }
      }

      return bestFile || fallbackFile;
    } catch {
      return null;
    }
  }

  /**
   * Read session context from a known file path (no rediscovery).
   * Used for existing workers where the streamer already cached the file.
   */
  private readSessionContextFromFile(filePath: string): SessionContext {
    const result: SessionContext = {
      projectName: null, latestAction: null, lastDirection: null,
      status: "idle", fileAgeMs: Infinity, highConfidence: false,
    };

    try {
      const stat = statSync(filePath);
      result.fileAgeMs = Date.now() - stat.mtimeMs;
      return this.analyzeJsonlTail(filePath, result);
    } catch {
      return result;
    }
  }

  /**
   * Read session context by discovering the best JSONL file.
   * Used for new workers (first scan) where no cached file exists yet.
   */
  private readSessionContext(sessionIds: string[], cwd?: string): SessionContext {
    const result: SessionContext = {
      projectName: null, latestAction: null, lastDirection: null,
      status: "idle", fileAgeMs: Infinity, highConfidence: false,
    };

    const best = this.findBestJsonlFile(sessionIds, cwd);
    if (!best) return result;

    result.fileAgeMs = Date.now() - best.mtimeMs;
    return this.analyzeJsonlTail(best.path, result);
  }

  /**
   * Core JSONL tail analysis — shared by both readSessionContext variants.
   *
   * Reads 50KB tail and scans backward for conversation patterns to determine
   * whether Claude is working (green) or idle (red).
   */
  private analyzeJsonlTail(filePath: string, result: SessionContext): SessionContext {
    try {
      let tail = readTail(filePath, 50_000);

      // Long-running Bash commands flood the JSONL with progress entries.
      // If 50KB yields zero real entries after filtering, read a bigger chunk
      // to find the actual conversation state buried underneath the noise.
      const hasRealEntry = /"type"\s*:\s*"(assistant|user)"/.test(tail);
      if (!hasRealEntry) {
        tail = readTail(filePath, 500_000);
      }

      // Extract project name from cwd field
      const cwdMatch = tail.match(/"cwd"\s*:\s*"([^"]+)"/);
      if (cwdMatch) {
        const cwd = cwdMatch[1];
        const factoryMatch = cwd.match(/\/factory\/projects\/([^/]+)/);
        if (factoryMatch) {
          result.projectName = factoryMatch[1];
        } else {
          const segments = cwd.split("/").filter(Boolean);
          const last = segments[segments.length - 1];
          if (last && last !== "rmgtni" && last !== "Users") {
            result.projectName = last;
          }
        }
      }

      const allLines = tail.split("\n").filter(Boolean);

      // Skip truncated first line. JSONL lines always start with '{'.
      // If the first line doesn't, it's a mid-line fragment from the tail cut.
      const rawLines = (allLines.length > 0 && !allLines[0].trimStart().startsWith("{"))
        ? allLines.slice(1)
        : allLines;

      // Filter out noise entries — progress/system/file-history-snapshot are
      // bookkeeping that Claude Code writes periodically even while idle.
      // They flood the scan window AND their writes keep file mtime fresh,
      // which causes phantom green via the 120s grace period.
      const isNoiseLine = (l: string) =>
        l.includes('"type":"progress"') ||
        l.includes('"type":"system"') ||
        l.includes('"type":"file-history-snapshot"') ||
        l.includes('"type":"hook_progress"');
      const lines = rawLines.filter(l => !isNoiseLine(l));

      // Check if the file's mtime freshness is from noise writes (progress,
      // system, etc.) rather than real content. When the last raw line is noise,
      // fileAgeMs is unreliable — noise keeps it artificially fresh.
      const lastRawLine = rawLines[rawLines.length - 1] || "";
      const fileAgeIsFromNoise = isNoiseLine(lastRawLine);

      // Extract latest action for display
      for (let i = lines.length - 1; i >= Math.max(0, lines.length - 20); i--) {
        const action = this.parseActionFromLine(lines[i]);
        if (action) { result.latestAction = action; break; }
      }

      // Extract last human direction — the most recent user-typed message.
      // Human messages have "type":"user" with content as a plain string.
      // Tool results also have "type":"user" but content is an array.
      // Scan backward through lines (not just filtered 20) to find the last one.
      for (let i = lines.length - 1; i >= Math.max(0, lines.length - 80); i--) {
        const line = lines[i];
        if (!line.includes('"type":"user"') && !line.includes('"type": "user"')) continue;
        // Skip tool_result entries (content is an array with tool_result blocks)
        if (line.includes('"tool_result"')) continue;
        // Extract the content string — human messages have "content":"some text"
        const contentMatch = line.match(/"content"\s*:\s*"([^"]{3,})"/);
        if (contentMatch) {
          let direction = contentMatch[1]
            .replace(/\\n/g, " ")
            .replace(/\\"/g, '"')
            .trim();
          // Skip session continuation boilerplate
          if (direction.startsWith("This session is being continued")) continue;
          // Truncate for display — 2 lines at 10px ≈ 60 chars
          if (direction.length > 60) direction = direction.slice(0, 57) + "...";
          result.lastDirection = direction;
          break;
        }
      }

      // Tail analysis is the sole status engine. No mtime shortcut —
      // the conversation pattern in JSONL is ground truth for every state.
      // Two "still working" patterns:
      //
      // 1. TOOL IN FLIGHT: last assistant message has tool_use with no
      //    tool_result after it → long-running command (Bash, build, etc.)
      //
      // 2. THINKING: last meaningful entry is a "user" message (or
      //    tool_result) with no subsequent "assistant" message → Claude
      //    received input and is processing tokens on the API server.
      //    No hooks fire and nothing gets written to JSONL during this gap.

      let lastUser = false;    // saw "user" or tool_result more recently than "assistant"
      let lastAssistant = false;
      let foundAnyPattern = false;

      for (let i = lines.length - 1; i >= Math.max(0, lines.length - 20); i--) {
        const line = lines[i];

        // Pattern 1: tool in flight (tool_use without tool_result after it)
        if (line.includes('"tool_result"')) {
          foundAnyPattern = true;
          // Tool result = user input to Claude. Always counts as "user" input
          // regardless of whether we already saw an assistant message above.
          // Pattern: tool_result → assistant (text) means Claude received input
          // and responded. If the file is fresh, Claude may still be mid-turn.
          lastUser = true;
          break;
        }
        // Only treat tool_use as "in flight" if no assistant response came AFTER it.
        // Once we've seen an assistant text response (lastAssistant=true), any tool_use
        // before it is historical — the agent already responded and is done.
        if (!lastAssistant && line.includes('"tool_use"') && line.includes('"assistant"')) {
          result.status = "working";
          result.highConfidence = true; // tool_use at tail = definitive working
          return result;
        }

        // Pattern 2: thinking — track last message type
        if (!lastUser && !lastAssistant) {
          if (line.includes('"type":"user"') || line.includes('"type": "user"')) {
            lastUser = true;
            foundAnyPattern = true;
          } else if (line.includes('"type":"assistant"') || line.includes('"type": "assistant"')) {
            lastAssistant = true;
            foundAnyPattern = true;
          }
        }
      }

      // If the last meaningful entry was user input (or tool_result) and
      // Claude hasn't responded yet, it's thinking — show green.
      // BUT: if the file is very stale (>2 min), this is likely a compacted
      // session where Claude already responded in a NEW file.
      if (lastUser && !lastAssistant && result.fileAgeMs < 120_000) {
        result.status = "working";
        result.highConfidence = !fileAgeIsFromNoise; // noise freshness = low confidence
        result.latestAction = "Thinking...";
        return result;
      }

      // Assistant message at tail — but if the file was JUST modified (<4s),
      // Claude is mid-stream (still writing its response, or about to call
      // a tool). Don't flip to idle until the file has been quiet for 4s.
      // NEVER set this above 5s or below 2s — documented in hive-daemon.md.
      // Skip this check when freshness is from noise writes (progress/system).
      if (lastAssistant && result.fileAgeMs < 4_000 && !fileAgeIsFromNoise) {
        result.status = "working";
        result.highConfidence = false; // mid-stream heuristic, not definitive
        result.latestAction = result.latestAction || "Working...";
        return result;
      }

      // No recognizable patterns found in the tail (after filtering out
      // progress/system entries). This means the 50KB window is dominated
      // by a single huge JSONL line (e.g., a massive tool_result from
      // reading a large file). If the file was recently modified (< 2 min)
      // by a REAL write (not noise), Claude almost certainly just received
      // that content — show green.
      if (!foundAnyPattern && result.fileAgeMs < 120_000 && !fileAgeIsFromNoise) {
        result.status = "working";
        result.highConfidence = false;
        result.latestAction = "Thinking...";
        return result;
      }

      result.status = "idle";
      return result;
    } catch {
      return result;
    }
  }

  /** Try to extract a human-readable action from a JSONL line */
  private parseActionFromLine(line: string): string | null {
    try {
      // Quick checks to avoid parsing irrelevant lines
      if (!line.includes("tool_use")) return null;

      // JSONL tool_use format: {"type":"tool_use","name":"Bash","input":{...}}
      // Match "name" that appears after "tool_use" context
      const toolMatch = line.match(/"tool_use"[^}]*?"name"\s*:\s*"([^"]+)"/);
      if (!toolMatch) return null;

      const toolName = toolMatch[1];
      const fileMatch = line.match(/"file_path"\s*:\s*"([^"]+)"/);
      const descMatch = line.match(/"description"\s*:\s*"([^"]{1,60})"/);
      const cmdMatch = line.match(/"command"\s*:\s*"([^"]{1,60})"/);
      const patternMatch = line.match(/"pattern"\s*:\s*"([^"]{1,30})"/);

      switch (toolName) {
        case "Bash":
          return descMatch ? descMatch[1] : cmdMatch ? cmdMatch[1] : "Running command";
        case "Edit":
          return fileMatch ? `Editing ${basename(fileMatch[1])}` : "Editing file";
        case "Write":
          return fileMatch ? `Writing ${basename(fileMatch[1])}` : "Writing file";
        case "Read":
          return fileMatch ? `Reading ${basename(fileMatch[1])}` : "Reading file";
        case "Grep":
          return patternMatch ? `Searching "${patternMatch[1]}"` : "Searching code";
        case "Glob":
          return patternMatch ? `Finding ${patternMatch[1]}` : "Finding files";
        case "WebFetch":
          return "Fetching web page";
        case "WebSearch":
          return "Searching web";
        case "Task":
          return "Running subagent";
        case "AskUserQuestion":
          return "Asking you a question";
        default:
          return toolName.replace(/^mcp__\w+__/, "");
      }
    } catch {
      return null;
    }
  }

  private projectNameFromCwd(cwd: string): string {
    const homeDir = process.env.HOME || `/Users/${process.env.USER}`;
    if (cwd === homeDir || cwd === "/") return "unknown";
    return cwd.split("/").pop() || cwd;
  }
}
