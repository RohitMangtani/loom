import { execFileSync } from "child_process";
import { appendFileSync, existsSync, readFileSync, readdirSync, statSync, unlinkSync } from "fs";
import { basename, dirname, join } from "path";
import type { TelemetryReceiver } from "./telemetry.js";
import type { SessionStreamer } from "./session-stream.js";
import type { WorkerState } from "./types.js";
import { readTail, describeBashCommand } from "./utils.js";
import type { ProcessDiscoverer, TerminalIO } from "./platform/interfaces.js";
import { homedir } from "os";

/** Quadrant Audit  --  logs every status transition with full decision context */
interface AuditEntry {
  ts: string;
  tty: string;
  from: string;
  to: string;
  reason: string;
  context: Record<string, unknown>;
}

const HOME = process.env.HOME || process.env.USERPROFILE || homedir();
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
  /** Which AI tool ("claude", "codex", etc.). Defaults to "claude". */
  model?: string;
}

/** Parsed context from a session JSONL tail */
interface SessionContext {
  projectName: string | null;
  projectPath: string | null;
  latestAction: string | null;
  lastDirection: string | null;
  status: "working" | "idle";
  fileAgeMs: number;
  /** true when status="working" comes from a definitive signal (tool_use at tail,
   *  fresh user input). false when it's a low-confidence fallback (no-pattern,
   *  noise-driven mid-stream, stale file heuristic). runJsonlAnalysis uses this
   *  to decide whether JSONL alone can override a stable idle state. */
  highConfidence: boolean;
  /** true if the JSONL tail is dominated by noise entries (progress/sys) that
   *  keep the file mtime fresh; keeps noise-induced freshness from auto-green. */
  fileAgeIsFromNoise: boolean;
}

function extractTurnId(line: string): string | null {
  const match = line.match(/"turn_id"\s*:\s*"([^"]+)"/);
  return match ? match[1] : null;
}

export class ProcessDiscovery {
  private telemetry: TelemetryReceiver;
  private streamer: SessionStreamer;
  private readonly platformDiscovery?: ProcessDiscoverer;
  private readonly terminal?: TerminalIO;
  private discoveredPids = new Set<number>();
  private daemonPid = process.pid;

  /** Pre-seed discoveredPids from state import so restored workers go through
   *  the existing-worker path (not new-worker) on the first scan after restart.
   *  Prevents the new-worker path from overwriting clean imported state. */
  seedFromImport(pids: number[]): void {
    for (const pid of pids) {
      if (pid > 0) this.discoveredPids.add(pid);
    }
  }
  private prevStatus = new Map<string, string>();
  private auditLog: AuditEntry[] = [];
  // Hysteresis: count consecutive idle signals per worker.
  // Require 2+ before transitioning working→idle (prevents single-scan flapping).
  private consecutiveIdleChecks = new Map<string, number>();
  // Reverse hysteresis: count consecutive CPU-active signals per idle worker.
  // Require 2+ before transitioning idle→working (prevents false green flickers
  // from brief CPU spikes like GC or shell init).
  private consecutiveActiveChecks = new Map<string, number>();
  // Cooldown: timestamp of last confirmed working state per worker.
  // Prevents working→idle flicker during API thinking gaps where hooks
  // go stale but the agent is still processing.
  private lastConfirmedWorking = new Map<string, number>();
  // PTY stdout byte offset tracking for output flow detection.
  // Stores the last known FD 1 offset per PID. If the offset increases
  // between scans, the process is writing to the terminal = working.
  private prevPtyOffset = new Map<number, number>();
  // Per-tick caches  --  cleared at start of each scan() call.
  // Prevents redundant execFileSync calls (ps, lsof) when the same PID
  // is checked multiple times in one tick (idleConfirmed, idle→working, cooldown).
  private tickCpuCache = new Map<number, number>();
  private tickPtyCache = new Map<number, number>();
  // Codex session file cache  --  persists across ticks. Only re-scanned if
  // not found yet (null) or every 30s for staleness.
  private codexSessionCache = new Map<number, { file: string | null; checkedAt: number }>();
  // OpenClaw session file cache  --  same semantics as Codex cache.
  private openclawSessionCache = new Map<number, { file: string | null; checkedAt: number }>();
  private geminiSessionCache = new Map<number, { file: string | null; checkedAt: number }>();
  // Generic session file cache for custom agents  --  keyed by "model:pid".
  private customSessionCache = new Map<string, { file: string | null; checkedAt: number }>();

  /** Custom agent definitions loaded from ~/.hive/agents.json */
  private static customAgents: { id: string; label: string; processPattern: string; spawnCommand: string; sessionDir?: string }[] = [];
  private static customAgentsLoadedAt = 0;

  /** Load or reload custom agent definitions from ~/.hive/agents.json */
  static loadCustomAgents(): void {
    const configPath = join(HOME, ".hive", "agents.json");
    try {
      const stat = statSync(configPath);
      if (stat.mtimeMs <= ProcessDiscovery.customAgentsLoadedAt) return;
      const raw = readFileSync(configPath, "utf-8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        ProcessDiscovery.customAgents = parsed.filter(
          (a: Record<string, unknown>) => a.id && a.processPattern && a.spawnCommand
        );
        ProcessDiscovery.customAgentsLoadedAt = stat.mtimeMs;
        console.log(`[discovery] Loaded ${ProcessDiscovery.customAgents.length} custom agent(s) from agents.json`);
      }
    } catch {
      // File doesn't exist or invalid JSON  --  fine, use built-ins only
    }
  }

  /** Get custom agent config by model id */
  static getCustomAgent(model: string): { id: string; label: string; processPattern: string; spawnCommand: string; sessionDir?: string } | undefined {
    return ProcessDiscovery.customAgents.find(a => a.id === model);
  }

  /** Get all custom agents (for dashboard spawn dialog) */
  static getCustomAgents(): { id: string; label: string; processPattern: string; spawnCommand: string; sessionDir?: string }[] {
    ProcessDiscovery.loadCustomAgents();
    return ProcessDiscovery.customAgents;
  }

  // Track TTYs we've already detected prompts for (avoid repeated AppleScript calls)
  private promptCheckedTtys = new Map<string, { checkedAt: number; result: "trust" | "sandbox" | null }>();
  // Suppress prompt detection after dashboard approval (prevents re-detecting stale prompt text).
  // Permanent per TTY  --  once approved, the terminal buffer retains stale prompt text
  // indefinitely, so time-based expiry doesn't work. TTYs are unique per terminal tab,
  // so a new agent in a new tab gets a fresh TTY and won't be affected.
  private promptSuppressed = new Set<string>(); // tty
  // Track when promptType was set from a spawn placeholder transfer.
  // The session-file-appearance logic must not clear it until this hold period expires,
  // because readTerminalContent() is unreliable in the first seconds of a new tab.
  private promptHoldUntil = new Map<string, number>(); // workerId → timestamp

  constructor(
    telemetry: TelemetryReceiver,
    streamer: SessionStreamer,
    platform?: { discovery: ProcessDiscoverer; terminal: TerminalIO },
  ) {
    this.telemetry = telemetry;
    this.streamer = streamer;
    this.platformDiscovery = platform?.discovery;
    this.terminal = platform?.terminal;
  }

  /**
   * Read the visible text of a Terminal.app tab by TTY device.
   * Returns the tab contents or null on failure.
   */
  readTerminalContent(tty: string): string | null {
    if (this.terminal) {
      return this.terminal.readContent(tty);
    }
    const device = tty.startsWith("/dev/") ? tty : `/dev/${tty}`;
    // Use "history" instead of "contents"  --  the contents property returns
    // a tab reference string on modern macOS instead of the visible text.
    // "history" returns the full scrollback; we trim to the tail later.
    const script = `
tell application "Terminal"
  set theText to ""
  repeat with w in windows
    repeat with t in tabs of w
      if tty of t is "${device}" then
        set theText to history of t
      end if
    end repeat
  end repeat
  return theText
end tell
`;
    try {
      const result = execFileSync("/usr/bin/osascript", ["-e", script], {
        timeout: 5000,
        encoding: "utf-8",
      });
      return (result as string).trim() || null;
    } catch {
      return null;
    }
  }

  /**
   * Detect pre-session prompts (trust folder, sandbox) from terminal content.
   * Returns the prompt type and a human-readable message, or null if no prompt detected.
   */
  detectPrompt(tty: string, opts?: { bypassCache?: boolean }): { type: "trust" | "sandbox"; message: string; content: string } | null {
    // Suppressed: dashboard approved this prompt  --  permanent per TTY
    if (this.promptSuppressed.has(tty)) return null;

    // Rate-limit: don't re-check the same TTY within 3 seconds (aligned
    // with the scan interval so each tick can get a fresh reading)
    const bypass = !!opts?.bypassCache;
    const cached = this.promptCheckedTtys.get(tty);
    if (!bypass && cached && Date.now() - cached.checkedAt < 3000) {
      if (!cached.result) return null;
      return { type: cached.result, message: cached.result === "trust" ? "Trust this folder?" : "Allow sandbox?", content: "" };
    }

    const content = this.readTerminalContent(tty);
    if (!content) {
      this.promptCheckedTtys.set(tty, { checkedAt: Date.now(), result: null });
      return null;
    }

    // Only check the last ~2000 chars of terminal history  --  if the prompt
    // text appears near the end, the agent is currently waiting at it.
    // Matching on full history would false-positive on established agents
    // that passed through the prompt minutes/hours ago.
    // Trim trailing whitespace/blank lines: Terminal.app pads history with
    // empty lines after the visible content, burying the prompt text.
    const trimmed = content.trimEnd();
    const tail = trimmed.slice(-2000);
    const tailLower = tail.toLowerCase();

    // Claude CLI trust prompt patterns
    if (tailLower.includes("yes, i trust") ||
        tailLower.includes("trust this folder") ||
        tailLower.includes("trust this project folder") ||
        tailLower.includes("is this a project you created") ||
        tailLower.includes("enter to confirm")) {
      this.promptCheckedTtys.set(tty, { checkedAt: Date.now(), result: "trust" });
      return { type: "trust", message: "Trust this project folder?", content };
    }

    // Claude CLI sandbox prompt patterns
    if (tailLower.includes("sandboxed") ||
        (tailLower.includes("sandbox") && tailLower.includes("bash"))) {
      this.promptCheckedTtys.set(tty, { checkedAt: Date.now(), result: "sandbox" });
      return { type: "sandbox", message: "Allow bash commands?", content };
    }

    this.promptCheckedTtys.set(tty, { checkedAt: Date.now(), result: null });
    return null;
  }

  /**
   * Detect provider-level errors from terminal output (quota exhaustion,
   * billing issues, rate limits). Returns a human-readable error string
   * or null if no provider error is detected.
   *
   * Only checks the last ~1500 chars of terminal history to avoid
   * false-positives on old error messages that have scrolled up.
   * Caches results for 10 seconds (avoids AppleScript spam).
   */
  /**
   * Read terminal content for a worker with no session yet.
   * Returns the visible text trimmed to the last meaningful lines.
   */
  readTerminalPreview(tty: string): string | null {
    const cached = this.promptCheckedTtys.get(tty);
    if (cached && Date.now() - cached.checkedAt < 3000) return null; // avoid re-reading too fast
    const content = this.readTerminalContent(tty);
    if (!content) return null;
    // Trim to last ~15 lines (skip shell noise at top)
    const lines = content.split("\n").filter(l => l.trim());
    return lines.slice(-15).join("\n").trim().slice(0, 500) || null;
  }

  /** Clear prompt detection cache for a TTY (call after approving) */
  clearPromptCache(tty: string): void {
    this.promptCheckedTtys.delete(tty);
  }

  /** Permanently suppress prompt detection for a TTY (call after dashboard approval).
   *  Permanent because the terminal buffer retains stale prompt text indefinitely.
   *  Each terminal tab has a unique TTY, so new agents aren't affected. */
  suppressPrompt(tty: string): void {
    this.promptSuppressed.add(tty);
    this.promptCheckedTtys.delete(tty);
    // Clear any hold timer for workers on this TTY
    for (const w of this.telemetry.getAll()) {
      if (w.tty === tty) this.promptHoldUntil.delete(w.id);
    }
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
    console.log(`[audit] ${tty}: ${from} → ${to}  --  ${reason}`);
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
    // Clear per-tick caches so each scan gets fresh readings
    this.tickCpuCache.clear();
    this.tickPtyCache.clear();

    const processes = this.findClaudeProcesses();
    const alivePids = new Set<number>();

    // Sort by startedAt so earliest worker gets first pick at birthtime matching.
    // This prevents all workers from grabbing the same JSONL when they start
    // within seconds of each other (e.g. after a system restart).
    const sorted = [...processes].sort((a, b) => a.startedAt - b.startedAt);

    // Track JSONL files already claimed this scan cycle.
    // Passed to findSessionFileByStartTime to prevent multiple workers
    // from matching the same file when birthtimes are clustered.
    const claimedFiles = new Set<string>();

    // Content-based TTY→file map: read JSONL tails for identity hook output
    // ("You are Q{N} (ttysXXX, project)") to build ground-truth assignments.
    // This survives daemon restarts and doesn't depend on birthtime heuristics.
    const ttyToFile = this.buildTtyFileMap(sorted);

    for (const proc of sorted) {
      alivePids.add(proc.pid);
      const id = `discovered_${proc.pid}`;

      // Register session→worker mappings for hook lookups
      for (const sid of proc.sessionIds) {
        this.telemetry.registerSession(sid, id);
      }

      // If register-tty has pinned this worker's session (ground truth from identity.sh),
      // skip heuristic session file resolution  --  the pin is authoritative.
      const pinnedSession = this.telemetry.getPinnedSessionForWorker(id);
      let sessionFile: string | null = null;

      if (pinnedSession) {
        // Use the pinned session file directly
        const cachedFile = this.streamer.getSessionFile(id);
        if (cachedFile) {
          claimedFiles.add(cachedFile);
          sessionFile = cachedFile; // Already set correctly by register-tty
        }
      } else {
        // Fresh spawns: suppress heuristic session file resolution so the agent
        // starts with blank chat history. Only authoritative sources (lsof, session
        // ID from process args) are used during the grace period. The identity hook
        // will pin the correct session once it fires on the first prompt.
        // Also treat never-before-seen PIDs as fresh (covers externally-started agents).
        const isFreshSpawn = this.telemetry.isRecentSpawn(proc.tty) || !this.discoveredPids.has(proc.pid);

        // Priority 0: content-based match (ground truth from identity hook in JSONL).
        // Overrides all heuristics because it matches TTY↔file using actual content.
        // Skip for non-Claude workers: markers in ~/.hive/sessions/ are written by Claude's
        // identity.sh hook, which never fires for Codex or OpenClaw. Any marker found for
        // a non-Claude worker's TTY is stale from a previous Claude session  --  using it
        // would map the wrong chat history (the old Claude session instead of the current one).
        // Also skip for fresh spawns: marker may be stale from the previous session on this TTY.
        if (proc.tty && proc.model === "claude" && !isFreshSpawn) {
          const contentMatch = ttyToFile.get(proc.tty);
          if (contentMatch && !claimedFiles.has(contentMatch)) {
            sessionFile = contentMatch;
          }
        }

        if (!sessionFile) {
          // Register session file with streamer for chat history.
          // Priority: lsof JSONL path > session ID match > birthtime match.
          // Never use "most recently modified in cwd dir"  --  when multiple workers
          // share the same cwd (e.g. home dir), it picks the wrong worker's file.
          sessionFile = proc.jsonlFile; // Direct from lsof  --  most reliable

          // For non-Claude workers, search their native session dirs BEFORE Claude
          // heuristics. These agents use appendFileSync (open+close instantly) so lsof
          // rarely catches the JSONL handle. Without this, Claude heuristics search
          // .claude/projects/ and can grab a stale JSONL  --  causing cross-contamination.
          if (!sessionFile && proc.model === "codex") {
            sessionFile = this.findCodexSessionFile(proc.pid, proc.startedAt);
          }
          if (!sessionFile && proc.model === "openclaw") {
            sessionFile = this.findOpenClawSessionFile(proc.pid, proc.startedAt);
          }
          if (!sessionFile && proc.model === "gemini") {
            sessionFile = this.findGeminiSessionFile(proc.pid, proc.startedAt);
          }
          // Custom agents with a sessionDir config
          if (!sessionFile && proc.model && proc.model !== "claude" && proc.model !== "codex" && proc.model !== "openclaw" && proc.model !== "gemini") {
            sessionFile = this.findCustomSessionFile(proc.model, proc.pid, proc.startedAt);
          }

          // Claude-specific heuristics: session ID match and birthtime fallback.
          // Skip for non-Claude models  --  these search .claude/projects/ and can
          // grab stale Claude JSONL files, cross-contaminating the session mapping.
          // Skip birthtime fallback for fresh spawns  --  it picks up old JSONL files.
          if (!sessionFile && (!proc.model || proc.model === "claude")) {
            if (proc.sessionIds.length > 0) {
              sessionFile = this.streamer.findSessionFile(proc.sessionIds);
              if (!sessionFile) {
                const jsonl = this.findBestJsonlFile(proc.sessionIds);
                if (jsonl) sessionFile = jsonl.path;
              }
            }
            // Fallback: match JSONL by creation time closest to process start.
            // Skip for fresh spawns  --  birthtime heuristic grabs stale files.
            if (!sessionFile && !isFreshSpawn) {
              sessionFile = this.findSessionFileByStartTime(proc.cwd, proc.startedAt, claimedFiles);
            }
          }
        }

        // Stale-file recovery: when context compaction creates a new session,
        // the old JSONL stops being written to. If the cached file is stale
        // (>2min), search for a successor JSONL in the same directory.
        // Only for Claude  --  non-Claude models have their own session file finders.
        // Skip for fresh spawns  --  no stale file to recover from.
        const effectiveFile = sessionFile || this.streamer.getSessionFile(id);
        if (effectiveFile && (!proc.model || proc.model === "claude") && !isFreshSpawn) {
          try {
            const age = Date.now() - statSync(effectiveFile).mtimeMs;
            if (age > 120_000) {
              const newer = this.findNewerSessionFile(effectiveFile, id);
              if (newer) sessionFile = newer;
            }
          } catch { /* file gone */ }
        }
      }

      // Reject heuristic session files that are already mapped to another live
      // worker in the streamer. claimedFiles only tracks this scan cycle  --  if a
      // pinned worker's file wasn't added to claimedFiles (e.g., getSessionFile
      // returned null), the heuristic can still grab it. This guard catches that.
      if (sessionFile && !pinnedSession && this.streamer.isFileMappedToOther(sessionFile, id)) {
        sessionFile = null;
      }

      if (sessionFile && !pinnedSession) {
        claimedFiles.add(sessionFile);
        this.streamer.setSessionFile(id, sessionFile);

        // Register the JSONL filename UUID as a session→worker mapping.
        // This is critical: lsof only catches file handles that are open at
        // the moment of the scan (appendFileSync opens+closes instantly).
        // Many workers have 0 lsof-derived session IDs. But the JSONL filename
        // IS the session UUID that Claude Code sends in hook payloads.
        // Registering it here ensures hooks route by session ID  --  not the
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

          // Check for pre-session prompts on workers with no session file yet.
          // Once a session file appears, clear the prompt state  --  the CLI has
          // passed the trust/sandbox prompts and started a real session.
          const cachedSessionFile = this.streamer.getSessionFile(id);
          if (existing.promptType && cachedSessionFile) {
            // Hold timer: placeholder-transferred prompts are kept for 20s
            // because readTerminalContent() is unreliable in the first
            // seconds of a new terminal tab. Without this, the session file
            // appearing immediately clears the prompt and the dashboard
            // never shows the approval button.
            const holdExpiry = this.promptHoldUntil.get(id);
            const holdActive = holdExpiry !== undefined && Date.now() < holdExpiry;
            if (holdActive) {
              this.telemetry.notifyExternal(existing);
              continue;
            }
            if (holdExpiry && !holdActive) {
              this.promptHoldUntil.delete(id);
            }
              // If the agent is young (<10min), verify the prompt is actually
              // gone before clearing. Older agents always clear  --  their
              // terminal history contains stale prompt text.
            if (!holdActive && proc.tty && Date.now() - proc.startedAt < 600_000) {
              const stillPrompt = this.detectPrompt(proc.tty, { bypassCache: true });
              if (stillPrompt) {
                this.promptHoldUntil.set(id, Date.now() + 20_000);
                this.telemetry.notifyExternal(existing);
                continue;
              }
            }
              if (!holdActive) {
                existing.promptType = null;
                existing.promptMessage = undefined;
                existing.terminalPreview = undefined;
                this.clearPromptCache(proc.tty);
              }
          } else if (!cachedSessionFile && proc.tty && !existing.promptType) {
            // No session file, no prompt set  --  check for trust/sandbox prompts.
            // No age limit: an agent can sit at the trust prompt indefinitely.
            // The 500-char tail in detectPrompt prevents false positives on old agents.
            // Skip if hooks have been received: the agent is established and
            // any prompt text in the terminal is stale from initialization.
            if (!this.telemetry.hasReceivedHook(id)) {
              const prompt = this.detectPrompt(proc.tty, { bypassCache: true });
              if (prompt) {
                existing.status = "waiting";
                existing.promptType = prompt.type;
                existing.promptMessage = prompt.message;
                existing.currentAction = prompt.message;
                existing.terminalPreview = prompt.content.split("\n").filter((l: string) => l.trim()).slice(-15).join("\n").trim().slice(0, 500) || undefined;
                this.telemetry.notifyExternal(existing);
                this.promptHoldUntil.set(id, Date.now() + 20_000);
                continue;
              }
            }
          }

          // Use streamer's cached session file  --  guaranteed to be THIS worker's
          // file. Never use findBestJsonlFile for status detection; its cwd
          // fallback can pick another worker's file (cross-contamination).
          const cachedPath = cachedSessionFile;
          let cachedMtime = 0;
          if (cachedPath) {
            try { cachedMtime = statSync(cachedPath).mtimeMs; } catch { /* file gone */ }
          }

          // LAYER 1: JSONL mtime heartbeat  --  refresh lastActionAt so
          // telemetry.tick() doesn't interfere while discovery is active.
          if (cachedMtime > 0 && Date.now() - cachedMtime < 30_000) {
            existing.lastActionAt = Date.now();
          }

          // LAYER 2: Deep JSONL analysis when hooks are stale.
          // When no hooks have EVER arrived, treat as very stale (60s) so JSONL
          // analysis runs. Avoids both extremes: 0 (thinks hooks fresh, skips
          // JSONL) and Date.now() (1.7B ms → bogus audit entries).
          const lastHook = this.telemetry.hasReceivedHook(id)
            ? this.telemetry.getLastHookTime(id)
            : undefined;
          const hookAge = lastHook ? Date.now() - lastHook : 60_000;
          const tty = existing.tty || "?";
          const auditCtx = {
            hookAgeMs: Math.round(hookAge),
            cachedPath: cachedPath ? basename(cachedPath) : null,
            fileAgeMs: cachedMtime > 0 ? Math.round(Date.now() - cachedMtime) : null,
            prevStatus: existing.status,
            action: existing.currentAction,
          };

          // Non-Claude models don't fire hooks. Any "fresh" hooks on their worker
          // are cross-contaminated from another Claude session. Skip hook-trusted
          // paths entirely and go straight to session/CPU analysis.
          const hasNativeHooks = !existing.model || existing.model === "claude";

          if (hasNativeHooks && hookAge < 5_000) {
            // Hooks are live (<5s)  --  trust hook-set status, but apply hysteresis
            // for working→idle transitions to prevent flapping (58 transitions/15min).
            if (existing.status === "working") {
              this.lastConfirmedWorking.set(id, Date.now());
              this.consecutiveIdleChecks.set(id, 0);
              this.checkTransition(id, tty, "working", `hooks fresh (${Math.round(hookAge)}ms)`, auditCtx);
            } else if (existing.status === "idle") {
              const prevTrans = this.prevStatus.get(id);
              if (prevTrans === "working") {
                // Require 3 consecutive idle checks before transitioning (was 2).
                // 3 checks = ~9s at the 3s scan interval. This prevents the brief
                // red flash between tool calls when hooks go stale for a few seconds.
                const idleCount = (this.consecutiveIdleChecks.get(id) || 0) + 1;
                this.consecutiveIdleChecks.set(id, idleCount);
                if (idleCount < 3) {
                  this.checkTransition(id, tty, "working", `hooks fresh idle but hysteresis (${idleCount}/3)`, auditCtx);
                } else {
                  this.checkTransition(id, tty, "idle", `hooks fresh (${Math.round(hookAge)}ms) hysteresis=${idleCount}`, auditCtx);
                }
              } else {
                this.checkTransition(id, tty, "idle", `hooks fresh (${Math.round(hookAge)}ms)`, auditCtx);
              }
            } else {
              // stuck, waiting  --  pass through
              this.checkTransition(id, tty, existing.status, `hooks fresh (${Math.round(hookAge)}ms)`, auditCtx);
            }
          } else if (hasNativeHooks && hookAge < 15_000) {
            // Hooks recent (<15s)  --  trust hook state for stuck/toolInFlight
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
            // Hooks stale (>15s) or non-hook model  --  session/CPU analysis is the authority.
            // The Agent tool spawns a subagent that runs for minutes. During this time,
            // the parent process goes completely silent (no hooks, no JSONL writes).
            // toolInFlight persists from the PreToolUse hook  --  trust it up to 10 minutes.
            const inflight = this.telemetry.getToolInFlight(id);
            if (inflight && Date.now() - inflight.since < 600_000) {
              existing.status = "working";
              this.lastConfirmedWorking.set(id, Date.now());
              this.checkTransition(id, tty, "working", `toolInFlight: ${inflight.tool} (${Math.round((Date.now() - inflight.since) / 1000)}s)`, auditCtx);
            } else {
              // No tool in flight (or timed out)  --  JSONL analysis is the authority
              this.runJsonlAnalysis(id, existing, tty, cachedPath, cachedMtime, hookAge, auditCtx);
            }
          }

          this.telemetry.notifyExternal(existing);
        }
        continue;
      }

      // New process  --  read JSONL for initial status
      const ctx = this.readSessionContext(proc.sessionIds, proc.cwd);

      // If the process just started (< 30s ago) and the JSONL analysis returned
      // low-confidence "working" (typically from the no-pattern fallback on a
      // fresh file with only system/startup noise), override to idle. The agent
      // is sitting at its idle prompt waiting for the first message  --  not working.
      const processAge = Date.now() - proc.startedAt;
      let initialStatus = ctx.status;
      if (initialStatus === "working" && !ctx.highConfidence && processAge < 30_000) {
        initialStatus = "idle";
      }
      // Stronger guard: if markSpawn was called for this TTY (dashboard spawn or
      // satellite spawn), force idle regardless of JSONL confidence. Claude's
      // initialization writes (system prompt, context) create high-confidence
      // "user at tail" patterns that bypass the processAge guard above.
      // The spawn grace period (60s) is cleared once the identity hook fires,
      // which only happens on real user input  --  not initialization.
      if (initialStatus === "working" && this.telemetry.isRecentSpawn(proc.tty)) {
        initialStatus = "idle";
      }

      const worker: WorkerState = {
        id,
        pid: proc.pid,
        project: ctx.projectPath || proc.project,
        projectName: ctx.projectName || proc.projectName,
        status: initialStatus,
        currentAction: initialStatus === "working" ? (ctx.latestAction || "Working...") : null,
        lastAction: ctx.latestAction || "Discovered on machine",
        lastActionAt: Date.now(),
        errorCount: 0,
        startedAt: proc.startedAt,
        task: null,
        managed: false,
        tty: proc.tty,
        lastDirection: ctx.lastDirection || undefined,
        model: proc.model,
      };

      // Clean up any spawn placeholder for this TTY and register the real worker
      // as a single atomic operation. Using silentRemoveWorker + registerDiscoveredAtomic
      // ensures only ONE "workers" broadcast goes out with the final state  --  no
      // intermediate frame where both placeholder and real worker coexist.
      let replacedPlaceholder = false;
      if (proc.tty) {
        const placeholderId = `spawning_${proc.tty.replace(/\//g, "_")}`;
        const placeholder = this.telemetry.get(placeholderId);
        if (placeholder) {
          // Transfer prompt/preview state from placeholder to real worker.
          // Set a hold timer so the session-file-clear logic doesn't immediately
          // wipe the promptType  --  readTerminalContent() is unreliable in the
          // first seconds of a new terminal tab.
          if (placeholder.promptType && !worker.promptType) {
            worker.promptType = placeholder.promptType;
            worker.promptMessage = placeholder.promptMessage;
            worker.terminalPreview = placeholder.terminalPreview;
            worker.status = "waiting";
            worker.currentAction = placeholder.currentAction;
            this.promptHoldUntil.set(id, Date.now() + 20_000);
          } else if (placeholder.terminalPreview && !worker.terminalPreview) {
            worker.terminalPreview = placeholder.terminalPreview;
          } else {
            // Freshly spawned agent  --  start as idle (red) until it receives work.
            worker.status = "idle";
            worker.currentAction = null;
          }
          // Silent remove: no broadcast, no onRemoval listeners
          this.telemetry.silentRemoveWorker(placeholderId);
          replacedPlaceholder = true;
        }
      }

      // Register real worker. If replacing a placeholder, use atomic variant
      // that suppresses the individual worker_update notification  --  the full
      // workers list broadcast below is the only message the dashboard sees.
      if (replacedPlaceholder) {
        this.telemetry.registerDiscoveredSilent(id, worker);
        // Force a single full-state broadcast so the dashboard atomically
        // swaps placeholder → real worker with no intermediate state.
        this.telemetry.forceFullBroadcast();
      } else {
        this.telemetry.registerDiscovered(id, worker);
      }
      this.discoveredPids.add(proc.pid);

      // Clear stale TTY session marker so this new worker starts with
      // fresh chat history instead of inheriting a previous session.
      if (proc.tty) {
        const ttyName = proc.tty.replace("/dev/", "");
        const markerPath = join(HOME, ".hive", "sessions", ttyName);
        try {
          const mtime = statSync(markerPath).mtimeMs;
          if (mtime < proc.startedAt) {
            unlinkSync(markerPath);
          }
        } catch { /* marker doesn't exist  --  fine */ }
      }

      // If the worker is idle at discovery (e.g. daemon restart while agents
      // are waiting for input, or freshly spawned), set idleConfirmed so the
      // 120s grace period in runJsonlAnalysis doesn't phantom-green them.
      if (initialStatus === "idle") {
        this.telemetry.setIdleConfirmed(id, true);
      }

      // Check for pre-session prompts (trust folder, sandbox) on new workers.
      // Always check regardless of sessionFile — heuristic session resolution can
      // cross-contaminate and set sessionFile even when the agent is genuinely at
      // the trust prompt. The prompt patterns only match recent terminal text, so
      // false positives on established agents are prevented by the 500-char tail limit.
      if (proc.tty) {
        const prompt = this.detectPrompt(proc.tty);
        if (prompt) {
          worker.status = "waiting";
          worker.promptType = prompt.type;
          worker.promptMessage = prompt.message;
          worker.currentAction = prompt.message;
          worker.terminalPreview = prompt.content.split("\n").filter((l: string) => l.trim()).slice(-15).join("\n").trim().slice(0, 500) || undefined;
        }
      }
    }

    // Remove dead processes  --  both discovered and state-restored workers.
    // State-restored workers (from importState) aren't in discoveredPids,
    // so we also scan the telemetry map for any discovered_* workers whose
    // PIDs are no longer in the ps output.
    for (const pid of this.discoveredPids) {
      if (!alivePids.has(pid)) {
        this.telemetry.removeWorker(`discovered_${pid}`);
        this.discoveredPids.delete(pid);
        this.prevPtyOffset.delete(pid);
      }
    }
    for (const w of this.telemetry.getAll()) {
      if (!w.id.startsWith("discovered_")) continue;
      const pid = parseInt(w.id.replace("discovered_", ""), 10);
      if (!isNaN(pid) && !alivePids.has(pid) && !this.discoveredPids.has(pid)) {
        this.telemetry.removeWorker(w.id);
      }
    }
  }

  /**
   * Core status decision from JSONL tail analysis.
   * Called when hooks are stale/absent and we need ground truth.
   *
   * Philosophy: GREEN until proven RED.
   *   - tool_use at tail = working (regardless of file age  --  tools can run hours)
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
      // No cached JSONL path. For non-Claude workers, try finding their session file
      // before falling back to CPU-only. For Claude, fresh hooks are usually enough
      // to bridge startup/compaction gaps, but once hooks go stale we must not keep
      // a stale "working" state forever  --  fall back to CPU analysis instead.
      if (existing.model && existing.model !== "claude") {
        const codexFile = existing.model === "openclaw"
          ? this.findOpenClawSessionFile(existing.pid, existing.startedAt)
          : existing.model === "codex"
            ? this.findCodexSessionFile(existing.pid, existing.startedAt)
            : existing.model === "gemini"
              ? this.findGeminiSessionFile(existing.pid, existing.startedAt)
              : this.findCustomSessionFile(existing.model, existing.pid, existing.startedAt);
        if (codexFile) {
          this.streamer.setSessionFile(id, codexFile);
          // Fall through to normal JSONL analysis with the found file
          this.runJsonlAnalysis(id, existing, tty, codexFile, Date.now(), hookAge, auditCtx);
          return;
        }
        this.runCpuOnlyAnalysis(id, existing, tty, auditCtx);
      } else {
        if (hookAge < 15_000) {
          this.checkTransition(id, tty, existing.status, `no cachedPath, hooks fresh (${Math.round(hookAge / 1000)}s)`, auditCtx);
        } else {
          this.runCpuOnlyAnalysis(id, existing, tty, { ...auditCtx, missingSessionFile: true, hookAge });
        }
      }
      return;
    }

    // Gemini JSON session files need a dedicated parser  --  they're single JSON
    // objects with a messages array, not line-delimited JSONL.
    if (cachedPath.endsWith(".json")) {
      this.runGeminiSessionAnalysis(id, existing, tty, cachedPath, hookAge, auditCtx);
      return;
    }

    const ctx = this.readSessionContextFromFile(cachedPath);
    const tailCtx = {
      ...auditCtx,
      tailStatus: ctx.status,
      tailAction: ctx.latestAction,
      tailFileAgeMs: Math.round(ctx.fileAgeMs),
      tailFileAgeFromNoise: ctx.fileAgeIsFromNoise,
    };

    // Cross-contamination guard: verify the cached session file actually belongs
    // to this worker. When multiple workers share the same project directory
    // (e.g., both at ~/), session file resolution can accidentally map one
    // worker's active JSONL to another. If the file's UUID is registered to a
    // different worker, don't trust the JSONL analysis  --  fall through to CPU.
    const fileUuid = basename(cachedPath).replace(/\.jsonl$/, "");
    if (fileUuid && this.telemetry.isSessionOwnedByOther(fileUuid, id)) {
      this.telemetry.recordSignal(id, "jsonl_analysis", `session file ${fileUuid.slice(0, 8)} owned by another worker  --  skipping JSONL`);
      this.checkTransition(id, tty, existing.status, `JSONL file cross-contamination detected (${fileUuid.slice(0, 8)} belongs to another worker)`, tailCtx);
      // Don't clear subscriptions  --  just invalidate the cached path so
      // discovery re-resolves on the next scan via findNewerSessionFile.
      this.streamer.clearSessionPath(id);
      return;
    }

    if (ctx.projectName && ctx.projectPath) {
      existing.project = ctx.projectPath;
      existing.projectName = ctx.projectName;
    } else if (ctx.projectName) {
      existing.projectName = ctx.projectName;
    }
    if (ctx.lastDirection) {
      existing.lastDirection = ctx.lastDirection;
    }

    // idleConfirmed = idle_prompt hook fired OR hysteresis confirmed idle.
    // Definitive RED  --  unless we know new input was just sent OR the process
    // is actively consuming CPU/PTY (agent thinking without tool calls).
    const isIdleConfirmed = this.telemetry.isIdleConfirmed(id);
    if (isIdleConfirmed) {
      // Don't enforce idleConfirmed if input was sent recently  --  the agent
      // is about to receive new work. But if the worker just definitively ended
      // the session or reached an idle prompt, trust that idle signal until we
      // see real working evidence. Otherwise stale terminal/JSONL noise can
      // drag a finished satellite worker back to green right after completion.
      const lastInput = this.telemetry.getLastInputSent(id);
      const recentInput = lastInput > 0 && Date.now() - lastInput < 15_000;
      const stickyIdle =
        existing.lastAction === "Session ended" ||
        existing.lastAction === "Waiting for input";
      // Also override if JSONL tail shows high-confidence working (e.g., user
      // typed directly in Terminal  --  no markInputSent, but JSONL has real user
      // input at tail). Safe: highConfidence=false for noise, so phantom green
      // can't sneak through.
      // Extra guard: even high-confidence JSONL can't override idleConfirmed
      // without corroboration when no hooks have EVER been seen for this worker.
      // This catches the startup race where session file resolution is wrong
      // and isSessionOwnedByOther can't help (neither UUID registered yet).
      const neverHadHooks = !this.telemetry.hasReceivedHook(id);
      const jsonlOverride = ctx.status === "working" && ctx.highConfidence && !neverHadHooks;
      // LAYER 8 override: CPU activity can break out of idleConfirmed.
      // This catches the case where an idle agent starts thinking (high CPU)
      // but no hooks fire because it hasn't called any tools yet.
      // PTY alone is NOT sufficient  --  user typing echoes ~900B to PTY stdout,
      // indistinguishable from agent output.
      const cpuPct = this.getCpuForPid(existing.pid);
      const ptyDelta = this.getPtyOutputDelta(existing.pid);
      // 25% threshold: typing in the terminal causes 15-21% CPU (character rendering),
      // but actual agent work (thinking/tool calls) is 30-50%+. Previous 15% threshold
      // caused false green flashes whenever the user typed in an idle terminal.
      const cpuActive = cpuPct > 25;
      // Require 2+ consecutive active ticks before CPU breaks idleConfirmed
      const activeCount = cpuActive ? (this.consecutiveActiveChecks.get(id) || 0) + 1 : 0;
      if (cpuActive) this.consecutiveActiveChecks.set(id, activeCount);
      else this.consecutiveActiveChecks.set(id, 0);
      // For Claude workers with hooks, CPU alone must NOT override idleConfirmed.
      // Claude Code idles at 30-40% CPU (Node.js event loop, MCP servers, file
      // watchers), indistinguishable from real work. UserPromptSubmit clears
      // idleConfirmed immediately when the user types, so CPU override is
      // redundant. Only allow CPU override for non-hook models (Codex, etc.)
      // where there's no hook to signal wakeup.
      const cpuOverride = cpuActive && activeCount >= 2 && neverHadHooks;
      const noiseWriteActive = ctx.fileAgeIsFromNoise && ctx.fileAgeMs < 120_000 && ptyDelta > 300;
      const recentInputOverride = recentInput && !stickyIdle;
      if (!recentInputOverride && !jsonlOverride && !cpuOverride && !noiseWriteActive) {
        if (ctx.latestAction) existing.lastAction = ctx.latestAction;
        existing.status = "idle";
        existing.currentAction = null;
        this.telemetry.recordSignal(id, "jsonl_analysis", `idle (idleConfirmed) fileAge=${Math.round(ctx.fileAgeMs/1000)}s cpu=${cpuPct.toFixed(1)}%`);
        this.checkTransition(id, tty, "idle", `idleConfirmed=true fileAge=${Math.round(ctx.fileAgeMs/1000)}s cpu=${cpuPct.toFixed(1)}%`, tailCtx);
        return;
      }
      if (cpuOverride || noiseWriteActive) {
        // CPU/PTY active  --  clear idleConfirmed and fall through to normal analysis
        this.telemetry.setIdleConfirmed(id, false);
        const signal = noiseWriteActive
          ? `noise-write ${ptyDelta}B (noise tail)`
          : (ptyDelta > 100 ? `PTY +${ptyDelta}B` : `CPU ${cpuPct.toFixed(1)}%`);
        this.telemetry.recordSignal(id, noiseWriteActive ? "pty_wakeup" : (cpuPct > 25 ? "cpu_wakeup" : "pty_wakeup"), signal);
      }
      // Recent input / JSONL / CPU overrides idleConfirmed  --  fall through to normal analysis
    }

    // Guard: External input sent recently, JSONL hasn't caught up
    const lastInput = this.telemetry.getLastInputSent(id);
    if (lastInput > 0 && cachedMtime < lastInput && Date.now() - lastInput < 15_000) {
      this.checkTransition(id, tty, existing.status, "input-sent guard (keep)", { ...tailCtx, lastInputMs: Math.round(Date.now() - lastInput) });
      return;
    }

    if (ctx.status === "working") {
      // FIX 1  --  Corroboration guard: when the agent is stable-idle and JSONL
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
      // FIX 1b  --  Spawn grace guard: during the 60s after markSpawn, even
      // high-confidence JSONL "working" is from initialization (system prompt,
      // context loading), not real user work. Suppress unless there's explicit
      // input or fresh hooks proving the agent received a real task.
      if (existing.status === "idle" && ctx.highConfidence && existing.tty &&
          this.telemetry.isRecentSpawn(existing.tty)) {
        const lastInput = this.telemetry.getLastInputSent(id);
        const recentInput = lastInput > 0 && Date.now() - lastInput < 15_000;
        const hooksFresh = hookAge < 5_000;
        if (!recentInput && !hooksFresh) {
          this.checkTransition(id, tty, "idle", `JSONL tail working (high-conf) but spawn grace active, staying idle`, tailCtx);
          return;
        }
      }
      // JSONL tail says working (tool_use at tail, or user/tool_result with fresh file)
      this.consecutiveIdleChecks.set(id, 0); // reset hysteresis
      this.consecutiveActiveChecks.set(id, 0); // reset CPU hysteresis
      // Only set lastConfirmedWorking from high-confidence signals (tool_use at
      // tail, real hooks). Low-confidence signals (mid-stream heuristic, noise-
      // driven) must NOT set the cooldown timer  --  otherwise a 1s "ok" response
      // keeps the agent green for 25s because the mid-stream check touched it.
      if (ctx.highConfidence) {
        this.lastConfirmedWorking.set(id, Date.now());
      }
      existing.status = "working";
      existing.currentAction = ctx.latestAction || "Thinking...";
      existing.lastAction = ctx.latestAction || existing.lastAction;
      existing.lastActionAt = Date.now();
      // FIX 3 (partial)  --  Clear idleConfirmed when we have real evidence of work.
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

      // High-confidence idle (e.g. Codex task_complete)  --  immediate transition,
      // bypass all cooldowns and hysteresis. This is a definitive "done" signal.
      if (ctx.highConfidence) {
        if (ctx.latestAction) existing.lastAction = ctx.latestAction;
        existing.status = "idle";
        existing.currentAction = null;
        this.consecutiveIdleChecks.set(id, 0);
        this.consecutiveActiveChecks.set(id, 0);
        this.telemetry.setIdleConfirmed(id, true);
        this.checkTransition(id, tty, "idle", `JSONL tail high-confidence idle (${existing.model || "claude"})`, tailCtx);
        return;
      }

      // If already idle (e.g. hooks set it), don't override to working
      // just because the file is fresh. The "idle but fresh" grace only
      // applies when we're currently working and unsure if we should go idle.
      if (existing.status === "idle") {
        // LAYER 8  --  idle→working recovery: even when idle, check if the
        // process woke up. Only use CPU for idle→working (not PTY alone),
        // because user typing in the terminal echoes characters to PTY stdout
        // (~900B per keystroke burst) which is indistinguishable from agent output.
        // PTY delta is still tracked for the working keepalive path below.
        const cpuPct = this.getCpuForPid(existing.pid);
        const ptyDelta = this.getPtyOutputDelta(existing.pid);
        if (cpuPct > 25) {
          const activeCount = (this.consecutiveActiveChecks.get(id) || 0) + 1;
          this.consecutiveActiveChecks.set(id, activeCount);
          if (activeCount >= 2) {
            // 2+ consecutive active ticks  --  real work, flip to working
            const signal = ptyDelta > 100 ? `PTY +${ptyDelta}B` : `CPU ${cpuPct.toFixed(1)}%`;
            existing.status = "working";
            existing.currentAction = "Thinking...";
            existing.lastActionAt = Date.now();
            this.lastConfirmedWorking.set(id, Date.now());
            this.consecutiveIdleChecks.set(id, 0);
            this.consecutiveActiveChecks.set(id, 0);
            this.telemetry.setIdleConfirmed(id, false);
            this.telemetry.recordSignal(id, cpuPct > 25 ? "cpu_wakeup" : "pty_wakeup", signal);
            this.checkTransition(id, tty, "working", `Idle→working via ${signal} (confirmed ${activeCount} ticks)`, { ...tailCtx, cpuPct, ptyDelta });
          } else {
            this.checkTransition(id, tty, "idle", `CPU active but unconfirmed (${activeCount}/2) cpu=${cpuPct.toFixed(1)}%`, tailCtx);
          }
        } else {
          this.consecutiveActiveChecks.set(id, 0);
          if (ctx.latestAction) existing.lastAction = ctx.latestAction;
          this.checkTransition(id, tty, "idle", `JSONL tail idle, already idle (count=${idleCount}) cpu=${cpuPct.toFixed(1)}%`, tailCtx);
        }
      } else if (ctx.fileAgeMs < 120_000 && idleCount < 3 && (hookAge < 30_000 || existing.model === "codex")) {
        // File written in last 2 min AND not enough idle signals AND either hooks
        // recently active OR Codex worker  --  stay GREEN.
        //   - fileAgeMs < 120s: covers subagent chains (30-90s JSONL gaps)
        //   - idleCount < 3: hysteresis prevents multi-scan flapping (was 2, raised to 3)
        //   - hookAge < 30s: ensures hooks confirm the agent is actually working.
        //     Without this, noise JSONL writes keep fileAge fresh → phantom green.
        //   - Codex only (not all non-Claude): Codex has no hooks and no JSONL
        //     idle patterns  --  only task_complete provides reliable idle.
        //     OpenClaw writes JSONL with clear assistant-at-tail idle patterns
        //     (like Claude), so it should trust its JSONL analysis.
        existing.status = "working";
        existing.currentAction = ctx.latestAction || "Thinking...";
        existing.lastAction = ctx.latestAction || existing.lastAction;
        existing.lastActionAt = Date.now();
        this.checkTransition(id, tty, "working", `JSONL tail idle but fresh (${Math.round(ctx.fileAgeMs/1000)}s) hookAge=${Math.round(hookAge/1000)}s hysteresis=${idleCount}/2`, tailCtx);
      } else {
        // FIX 2  --  Extended cooldown: 25s after last confirmed tool activity,
        // keep green. Covers the API thinking gap where no JSONL is written.
        // Applies to ALL models: Claude needs it for text generation after
        // tool calls (no hooks fire), Codex needs it for API thinking between
        // function_call sequences. For Codex, task_complete detection (high-
        // confidence idle) overrides this cooldown immediately when done.
        const lastWorking = this.lastConfirmedWorking.get(id) || 0;
        const workingCooldown = Date.now() - lastWorking;
        // Skip cooldown when JSONL confirms the agent is done.
        // ctx.status === "idle" means analyzeJsonlTail found assistant at tail
        // AND the file is >4s stale (mid-stream check already passed inside
        // analyzeJsonlTail). No need for a second fileAge check here.
        // The 25s cooldown only helps during the "thinking gap" (user→API→
        // no assistant message yet). Once the assistant response is at the tail,
        // the agent is finished  --  go red immediately.
        const jsonlConfirmsIdle = ctx.status === "idle";
        const hasJsonlIdleSignal = existing.model === "openclaw" || jsonlConfirmsIdle;
        if (workingCooldown < 25_000 && existing.status === "working" && !hasJsonlIdleSignal) {
          existing.currentAction = ctx.latestAction || "Thinking...";
          existing.lastAction = ctx.latestAction || existing.lastAction;
          existing.lastActionAt = Date.now();
          this.checkTransition(id, tty, "working", `JSONL tail idle but cooldown active (${Math.round(workingCooldown/1000)}s/25s since last confirmed working)`, tailCtx);
        } else {
          // LAYER 8  --  CPU + PTY signal: check if the process is actively consuming
          // CPU or writing output to the terminal before going/staying idle.
          // Cap at 3 minutes to prevent permanent green from runaway processes.
          const cpuPct = this.getCpuForPid(existing.pid);
          const ptyDelta = this.getPtyOutputDelta(existing.pid);
          // Working keepalive: agent was RECENTLY confirmed working (tool calls).
          // During text generation, CPU is 10-25% (lower than tool calls).
          // Use 8% threshold here (not 25%) because the agent is already confirmed
          // working  --  we just need to detect it's still alive. 25% is for idle→working
          // where we need to distinguish agent work from user typing.
          const isActive = (cpuPct > 8 || ptyDelta > 500) && workingCooldown < 180_000;

          if (isActive) {
            existing.status = "working";
            existing.currentAction = ctx.latestAction || "Generating response...";
            existing.lastAction = ctx.latestAction || existing.lastAction;
            existing.lastActionAt = Date.now();
            this.lastConfirmedWorking.set(id, Date.now());
            this.consecutiveIdleChecks.set(id, 0);
            this.telemetry.setIdleConfirmed(id, false);
            const signal = ptyDelta > 100 ? `PTY +${ptyDelta}B` : `CPU ${cpuPct.toFixed(1)}%`;
            this.telemetry.recordSignal(id, ptyDelta > 100 ? "pty_keepalive" : "cpu_keepalive", signal);
            this.checkTransition(id, tty, "working", `Output active (${signal})  --  generation detected`, { ...tailCtx, cpuPct, ptyDelta });
          } else {
            // File >2 min stale OR 2+ consecutive idle signals OR cooldown expired OR CPU+PTY idle → RED
            if (ctx.latestAction) existing.lastAction = ctx.latestAction;
            existing.status = "idle";
            existing.currentAction = null;
            // FIX 3  --  Lock idle after hysteresis: once the full hysteresis process
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
   * CPU/PTY-only status detection for non-Claude workers (Codex, etc.)
   * that have no JSONL session files or hook telemetry.
   * Reuses the same hysteresis and cooldown patterns as JSONL analysis.
   */
  /**
   * Gemini-specific status detection from its JSON session file.
   * Logic:
   *   - Last message is "user" + file modified < 30s ago → working (green)
   *   - Last message is "gemini" + file modified < 4s ago → working (mid-stream)
   *   - Last message is "gemini" + file stale → idle (red)
   *   - CPU fallback if session file can't be read
   */
  private runGeminiSessionAnalysis(
    id: string,
    existing: WorkerState,
    tty: string,
    filePath: string,
    hookAge: number,
    auditCtx: Record<string, unknown>,
  ): void {
    try {
      const stat = statSync(filePath);
      const fileAgeMs = Date.now() - stat.mtimeMs;

      const raw = readFileSync(filePath, "utf-8");
      const session = JSON.parse(raw);
      const messages = session.messages;
      if (!Array.isArray(messages) || messages.length === 0) {
        this.runCpuOnlyAnalysis(id, existing, tty, auditCtx);
        return;
      }

      const lastMsg = messages[messages.length - 1];
      const lastType = lastMsg?.type as string;
      const ctx = { ...auditCtx, geminiLastType: lastType, geminiFileAgeMs: Math.round(fileAgeMs), geminiMsgCount: messages.length };

      // Extract latest action for display
      if (lastMsg?.content && typeof lastMsg.content === "string") {
        const snippet = lastMsg.content.slice(0, 80);
        if (lastType === "gemini") {
          existing.lastAction = snippet;
          existing.lastActionAt = Date.now();
        }
      }

      // Check if the last gemini message has tool calls (still executing)
      const lastHasTools = Array.isArray(lastMsg.toolCalls) && lastMsg.toolCalls.length > 0;

      // Agent response with tool calls + file still being written → working
      if (lastType === "gemini" && lastHasTools && fileAgeMs < 300_000) {
        this.checkTransition(id, tty, "working", "gemini: tool calls in progress", ctx);
        existing.currentAction = lastMsg.content?.slice?.(0, 60) || "Running tools...";
        existing.lastActionAt = Date.now();
        return;
      }

      // Agent response at tail + stale file + no tools → idle (red)
      if (lastType === "gemini" && fileAgeMs > 3_000) {
        existing.status = "idle";
        existing.currentAction = null;
        existing.lastActionAt = Date.now();
        this.telemetry.setIdleConfirmed(id, true);
        this.checkTransition(id, tty, "idle", "gemini: response at tail, file stale", ctx);
        return;
      }

      // Agent response at tail + very fresh file → mid-stream (green)
      if (lastType === "gemini" && fileAgeMs <= 3_000) {
        this.checkTransition(id, tty, "working", "gemini: response mid-stream", ctx);
        existing.currentAction = "Thinking...";
        existing.lastActionAt = Date.now();
        return;
      }

      // User message at tail → agent is processing (green)
      if (lastType === "user") {
        this.checkTransition(id, tty, "working", "gemini: user at tail", ctx);
        existing.currentAction = "Thinking...";
        existing.lastActionAt = Date.now();
        return;
      }

      // Input-sent guard: only if session file hasn't updated yet (gap between
      // TTY send and Gemini writing the session file, typically <2s)
      const lastInput = this.telemetry.getLastInputSent(id);
      if (lastInput > 0 && Date.now() - lastInput < 5_000) {
        this.checkTransition(id, tty, "working", "gemini: input-sent guard", ctx);
        existing.currentAction = "Thinking...";
        existing.lastActionAt = Date.now();
        return;
      }

      // Fallback: use CPU
      this.runCpuOnlyAnalysis(id, existing, tty, auditCtx);
    } catch {
      // Can't read session file  --  fall back to CPU
      this.runCpuOnlyAnalysis(id, existing, tty, auditCtx);
    }
  }

  private runCpuOnlyAnalysis(
    id: string,
    existing: WorkerState,
    tty: string,
    auditCtx: Record<string, unknown>,
  ): void {
    // Guard: if input was just sent, keep current (optimistic working) status.
    // Codex can take seconds before CPU spikes  --  without this guard the first
    // discovery tick after message send sees low CPU and flips to idle.
    const lastInput = this.telemetry.getLastInputSent(id);
    if (lastInput > 0 && Date.now() - lastInput < 15_000) {
      this.checkTransition(id, tty, existing.status, `CPU-only: input-sent guard (${Math.round((Date.now() - lastInput) / 1000)}s ago, ${existing.model})`, auditCtx);
      return;
    }

    const cpuPct = this.getCpuForPid(existing.pid);
    const ptyDelta = this.getPtyOutputDelta(existing.pid);
    const ctx = { ...auditCtx, cpuPct, ptyDelta, model: existing.model };

    if (cpuPct > 25) {
      // High CPU  --  likely working. Require 2 consecutive ticks (hysteresis).
      const activeCount = (this.consecutiveActiveChecks.get(id) || 0) + 1;
      this.consecutiveActiveChecks.set(id, activeCount);
      if (activeCount >= 2) {
        existing.status = "working";
        existing.currentAction = "Working...";
        existing.lastActionAt = Date.now();
        this.lastConfirmedWorking.set(id, Date.now());
        this.consecutiveIdleChecks.set(id, 0);
        this.consecutiveActiveChecks.set(id, 0);
        this.checkTransition(id, tty, "working", `CPU-only: ${cpuPct.toFixed(1)}% (${existing.model})`, ctx);
      } else {
        this.checkTransition(id, tty, existing.status, `CPU active unconfirmed (${activeCount}/2, ${existing.model})`, ctx);
      }
    } else if (existing.status === "working") {
      // Was working, CPU dropped  --  apply cooldown before going idle
      const lastWorking = this.lastConfirmedWorking.get(id) || 0;
      const cooldown = Date.now() - lastWorking;
      if (cooldown < 25_000) {
        this.checkTransition(id, tty, "working", `CPU-only cooldown (${Math.round(cooldown / 1000)}s/25s, ${existing.model})`, ctx);
      } else {
        const idleCount = (this.consecutiveIdleChecks.get(id) || 0) + 1;
        this.consecutiveIdleChecks.set(id, idleCount);
        if (idleCount >= 2) {
          existing.status = "idle";
          existing.currentAction = null;
          this.checkTransition(id, tty, "idle", `CPU-only idle confirmed (cpu=${cpuPct.toFixed(1)}%, ${existing.model})`, ctx);
        } else {
          this.checkTransition(id, tty, "working", `CPU-only idle hysteresis (${idleCount}/2, ${existing.model})`, ctx);
        }
      }
    } else {
      // Already idle, low CPU  --  stay idle
      this.consecutiveActiveChecks.set(id, 0);
      this.checkTransition(id, tty, existing.status, `CPU-only steady (cpu=${cpuPct.toFixed(1)}%, ${existing.model})`, ctx);
    }
  }

  /**
   * Layer 8a: Get instantaneous CPU usage for a process.
   * Returns 0 on any error (process gone, permission denied).
   * Lightweight  --  single `ps` call, ~5ms.
   */
  private getCpuForPid(pid: number): number {
    const cached = this.tickCpuCache.get(pid);
    if (cached !== undefined) return cached;
    if (this.platformDiscovery) {
      const val = this.platformDiscovery.getCpu(pid);
      this.tickCpuCache.set(pid, val);
      return val;
    }
    try {
      const out = execFileSync("ps", ["-p", String(pid), "-o", "%cpu="], {
        encoding: "utf-8",
        timeout: 2000,
      }).trim();
      const val = parseFloat(out) || 0;
      this.tickCpuCache.set(pid, val);
      return val;
    } catch {
      this.tickCpuCache.set(pid, 0);
      return 0;
    }
  }

  /**
   * Layer 8b: Detect terminal output flow via PTY stdout byte offset.
   * Reads the FD 1 (stdout) byte offset from lsof and compares to
   * the previous scan. If bytes increased, the process is writing
   * to the terminal = actively generating output.
   *
   * Non-invasive  --  reads kernel FD metadata, does not consume output.
   * Returns the byte delta (0 = no output, >0 = bytes written since last check).
   */
  private getPtyOutputDelta(pid: number): number {
    const cached = this.tickPtyCache.get(pid);
    if (cached !== undefined) return cached;
    if (this.platformDiscovery) {
      const offset = this.platformDiscovery.getPtyOffset(pid);
      if (offset === null) {
        this.tickPtyCache.set(pid, 0);
        return 0;
      }
      const prev = this.prevPtyOffset.get(pid) ?? offset;
      this.prevPtyOffset.set(pid, offset);
      const delta = offset - prev;
      this.tickPtyCache.set(pid, delta);
      return delta;
    }
    try {
      const out = execFileSync("lsof", ["-a", "-p", String(pid), "-d", "1"], {
        encoding: "utf-8",
        timeout: 2000,
      }).trim();
      // Parse the SIZE/OFF column (7th field)  --  format is "0t12345678"
      const lastLine = out.split("\n").pop();
      if (!lastLine) { this.tickPtyCache.set(pid, 0); return 0; }
      const fields = lastLine.trim().split(/\s+/);
      const offsetStr = fields[6] || "";
      const offset = parseInt(offsetStr.replace(/^0t/, ""), 10);
      if (isNaN(offset)) { this.tickPtyCache.set(pid, 0); return 0; }

      const prev = this.prevPtyOffset.get(pid) ?? offset;
      this.prevPtyOffset.set(pid, offset);
      const delta = offset - prev;
      this.tickPtyCache.set(pid, delta);
      return delta;
    } catch {
      this.tickPtyCache.set(pid, 0);
      return 0;
    }
  }

  /**
   * Find a Codex session JSONL file by scanning ~/.codex/sessions/.
   * Codex stores session files at ~/.codex/sessions/YYYY/MM/DD/rollout-{datetime}-{uuid}.jsonl.
   * Falls back to most recently modified file if birthtime matching fails.
   */
  private findCodexSessionFile(pid: number, startedAt: number): string | null {
    // Cache: once found, don't re-scan the directory tree every tick.
    // Re-check every 30s if not found (Codex may create the file late).
    const cached = this.codexSessionCache.get(pid);
    if (cached) {
      if (cached.file) return cached.file; // found → stable
      if (Date.now() - cached.checkedAt < 30_000) return null; // not found recently
    }

    const codexDir = join(HOME, ".codex", "sessions");
    try {
      let birthtimeMatch: string | null = null;
      let bestBirthtimeDiff = Infinity;
      let mtimeMatch: string | null = null;
      let bestMtime = 0;

      // Walk YYYY/MM/DD subdirectories
      for (const year of readdirSync(codexDir)) {
        const yearDir = join(codexDir, year);
        try {
          for (const month of readdirSync(yearDir)) {
            const monthDir = join(yearDir, month);
            try {
              for (const day of readdirSync(monthDir)) {
                const dayDir = join(monthDir, day);
                try {
                  for (const file of readdirSync(dayDir)) {
                    if (!file.endsWith(".jsonl")) continue;
                    const fullPath = join(dayDir, file);
                    try {
                      const stat = statSync(fullPath);
                      // Birthtime matching: JSONL created close to process start.
                      // Codex can take 60-90s to create its session file after the
                      // process starts, so use a 120s window (was 60s  --  too tight).
                      const birthtimeDiff = Math.abs(stat.birthtimeMs - startedAt);
                      if (birthtimeDiff < 120_000 && birthtimeDiff < bestBirthtimeDiff) {
                        bestBirthtimeDiff = birthtimeDiff;
                        birthtimeMatch = fullPath;
                      }
                      // Track most recently modified as fallback
                      if (stat.mtimeMs > bestMtime) {
                        bestMtime = stat.mtimeMs;
                        mtimeMatch = fullPath;
                      }
                    } catch { /* skip */ }
                  }
                } catch { /* skip */ }
              }
            } catch { /* skip */ }
          }
        } catch { /* skip */ }
      }

      const bestFile = birthtimeMatch || mtimeMatch;
      this.codexSessionCache.set(pid, { file: bestFile, checkedAt: Date.now() });
      return bestFile;
    } catch {
      this.codexSessionCache.set(pid, { file: null, checkedAt: Date.now() });
      return null;
    }
  }

  /**
   * Find the most recent OpenClaw session JSONL file for a given process.
   * OpenClaw stores sessions at ~/.openclaw/agents/<agentId>/sessions/<session-id>.jsonl
   */
  private findOpenClawSessionFile(pid: number, startedAt: number): string | null {
    const cached = this.openclawSessionCache.get(pid);
    if (cached) {
      if (cached.file) return cached.file;
      if (Date.now() - cached.checkedAt < 30_000) return null;
    }

    const agentsDir = join(HOME, ".openclaw", "agents");
    try {
      // Track birthtime match (within 120s of process start) and mtime match (most recently modified) separately.
      // Prefer birthtime match; fall back to mtime-based selection.
      let birthtimeMatch: string | null = null;
      let bestBirthtimeDiff = Infinity;
      let mtimeMatch: string | null = null;
      let bestMtime = 0;

      for (const agentId of readdirSync(agentsDir)) {
        const sessionsDir = join(agentsDir, agentId, "sessions");
        try {
          for (const file of readdirSync(sessionsDir)) {
            if (!file.endsWith(".jsonl")) continue;
            const fullPath = join(sessionsDir, file);
            try {
              const stat = statSync(fullPath);
              const birthtimeDiff = Math.abs(stat.birthtimeMs - startedAt);
              if (birthtimeDiff < 120_000 && birthtimeDiff < bestBirthtimeDiff) {
                bestBirthtimeDiff = birthtimeDiff;
                birthtimeMatch = fullPath;
              }
              if (stat.mtimeMs > bestMtime) {
                bestMtime = stat.mtimeMs;
                mtimeMatch = fullPath;
              }
            } catch { /* skip */ }
          }
        } catch { /* skip */ }
      }

      const bestFile = birthtimeMatch || mtimeMatch;
      this.openclawSessionCache.set(pid, { file: bestFile, checkedAt: Date.now() });
      return bestFile;
    } catch {
      this.openclawSessionCache.set(pid, { file: null, checkedAt: Date.now() });
      return null;
    }
  }

  /**
   * Find Gemini CLI session files. Gemini CLI currently does not persist JSONL
   * session logs, so this will return null. When Google adds session persistence,
   * files are expected under ~/.gemini/  --  the scanner is ready.
   */
  private findGeminiSessionFile(pid: number, startedAt: number): string | null {
    const cached = this.geminiSessionCache.get(pid);
    if (cached) {
      // Once a Gemini session file is found, keep it permanently for this PID.
      // Gemini rewrites the file atomically (delete + create), which gives the
      // replacement a new birthtime. Re-scanning after that would fail the
      // birthtime check and lose the mapping. The file path stays the same
      // even through atomic rewrites.
      if (cached.file) return cached.file;
      if (Date.now() - cached.checkedAt < 30_000) return null;
    }

    const geminiDir = join(HOME, ".gemini");
    try {
      let birthtimeMatch: string | null = null;
      let birthtimeBest = Infinity;
      let mtimeFallback: string | null = null;
      let mtimeBest = 0;

      // Scan ~/.gemini/tmp/<hash>/chats/ for session-*.json files (4 levels deep)
      const scanDir = (dir: string, depth: number) => {
        if (depth > 4) return;
        try {
          for (const entry of readdirSync(dir)) {
            const fullPath = join(dir, entry);
            try {
              const stat = statSync(fullPath);
              if (stat.isDirectory()) {
                scanDir(fullPath, depth + 1);
              } else if (entry.startsWith("session-") && entry.endsWith(".json")) {
                // Match by birthtime (born after process start, within 120s).
                // Also match by session startTime inside the JSON (survives
                // atomic rewrites that change the OS birthtime).
                const birthtimeDiff = stat.birthtimeMs - startedAt;
                if (birthtimeDiff >= 0 && birthtimeDiff < 120_000 && birthtimeDiff < birthtimeBest) {
                  birthtimeBest = birthtimeDiff;
                  birthtimeMatch = fullPath;
                }
                // Fallback: read startTime from JSON and match to process start
                if (!birthtimeMatch) {
                  try {
                    const content = readFileSync(fullPath, "utf-8");
                    const sessionStart = JSON.parse(content).startTime;
                    if (sessionStart) {
                      const jsonDiff = new Date(sessionStart).getTime() - startedAt;
                      if (jsonDiff >= 0 && jsonDiff < 120_000 && jsonDiff < birthtimeBest) {
                        birthtimeBest = jsonDiff;
                        birthtimeMatch = fullPath;
                      }
                    }
                  } catch { /* skip */ }
                }
                if (stat.mtimeMs > mtimeBest) {
                  mtimeBest = stat.mtimeMs;
                  mtimeFallback = fullPath;
                }
              }
            } catch { /* skip */ }
          }
        } catch { /* skip */ }
      };

      scanDir(geminiDir, 0);
      // Only use birthtime match. No mtime fallback  --  that picks old sessions
      // and shows stale chat history when a new Gemini instance is spawned.
      // If no birthtime match, return null and re-check on next scan.
      this.geminiSessionCache.set(pid, { file: birthtimeMatch, checkedAt: Date.now() });
      return birthtimeMatch;
    } catch {
      this.geminiSessionCache.set(pid, { file: null, checkedAt: Date.now() });
      return null;
    }
  }

  /**
   * Find session file for a custom agent defined in ~/.hive/agents.json.
   * Scans the configured sessionDir for the most recently modified JSONL.
   */
  private findCustomSessionFile(model: string, pid: number, startedAt: number): string | null {
    const cacheKey = `${model}:${pid}`;
    const cached = this.customSessionCache.get(cacheKey);
    if (cached) {
      if (cached.file) return cached.file;
      if (Date.now() - cached.checkedAt < 30_000) return null;
    }

    const agent = ProcessDiscovery.getCustomAgent(model);
    if (!agent?.sessionDir) {
      this.customSessionCache.set(cacheKey, { file: null, checkedAt: Date.now() });
      return null;
    }

    const sessionDir = agent.sessionDir.replace(/^~/, HOME);
    try {
      let bestFile: string | null = null;
      let bestMtime = 0;

      // Recursively scan up to 3 levels deep for JSONL files
      const scanDir = (dir: string, depth: number) => {
        if (depth > 3) return;
        try {
          for (const entry of readdirSync(dir)) {
            const fullPath = join(dir, entry);
            try {
              const stat = statSync(fullPath);
              if (stat.isDirectory()) {
                scanDir(fullPath, depth + 1);
              } else if (entry.endsWith(".jsonl") && stat.mtimeMs > bestMtime) {
                bestMtime = stat.mtimeMs;
                bestFile = fullPath;
              }
            } catch { /* skip */ }
          }
        } catch { /* skip */ }
      };

      scanDir(sessionDir, 0);
      this.customSessionCache.set(cacheKey, { file: bestFile, checkedAt: Date.now() });
      return bestFile;
    } catch {
      this.customSessionCache.set(cacheKey, { file: null, checkedAt: Date.now() });
      return null;
    }
  }

  /** Built-in patterns to match AI agent processes in `ps` output. */
  private static readonly BUILTIN_PATTERNS: { regex: RegExp; model: string }[] = [
    { regex: /claude\s*$/, model: "claude" },
    { regex: /\/codex(?:\s+(?!app-server)|$)/, model: "codex" },
    { regex: /openclaw(?:\s+tui)?(?:\s|$)/, model: "openclaw" },
    { regex: /\/gemini(?:\s|$)/, model: "gemini" },
  ];

  /** Combined built-in + custom patterns. Reloads custom agents on each call. */
  private static get AGENT_PATTERNS(): { regex: RegExp; model: string }[] {
    ProcessDiscovery.loadCustomAgents();
    const custom = ProcessDiscovery.customAgents.map(a => ({
      regex: new RegExp(a.processPattern),
      model: a.id,
    }));
    return [...ProcessDiscovery.BUILTIN_PATTERNS, ...custom];
  }

  private findClaudeProcesses(): ProcessInfo[] {
    if (this.platformDiscovery) {
      return this.platformDiscovery.findAgentProcesses().map((proc) => {
        const { project, projectName } = this.projectIdentityFromCwd(proc.cwd);
        return {
          pid: proc.pid,
          cpuPercent: proc.cpuPercent,
          startedAt: proc.startedAt,
          tty: proc.tty,
          cwd: proc.cwd,
          project,
          projectName,
          sessionIds: proc.sessionIds,
          jsonlFile: proc.jsonlFile,
          model: proc.model,
        };
      });
    }
    try {
      const raw = execFileSync("ps", ["-eo", "pid,pcpu,lstart,tty,command"], {
        encoding: "utf-8",
        timeout: 5000,
      }).trim();

      if (!raw) return [];
      const results: ProcessInfo[] = [];

      const seenTtys = new Set<string>();
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.includes("grep")) continue;
        // Skip Node.js wrapper processes (e.g. "node /opt/homebrew/bin/codex")
        // that share a TTY with the actual agent binary.
        if (/\bnode\s+/.test(trimmed) && !trimmed.endsWith("claude") && !/\/gemini(?:\s|$)/.test(trimmed)) continue;

        // Match against all known agent patterns
        const matched = ProcessDiscovery.AGENT_PATTERNS.find(p => p.regex.test(trimmed));
        if (!matched) continue;

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

        // Deduplicate: skip if another agent process already claimed this TTY.
        // Codex spawns multiple processes (node wrapper + binary) on the same TTY.
        if (psTty && psTty !== "??" && seenTtys.has(psTty)) continue;

        const info = this.getProcessInfo(pid);
        if (!info) {
          // lsof failed (process still initializing)  --  use ps data as fallback.
          // This ensures newly opened instances get picked up immediately
          // instead of being silently skipped until lsof starts working.
          if (psTty && psTty !== "??" && psTty.startsWith("ttys")) {
            const homeDir = process.env.HOME || process.env.USERPROFILE || homedir();
            results.push({
              pid, cpuPercent, startedAt,
              tty: psTty,
              cwd: homeDir,
              project: homeDir + "/unknown",
              projectName: "unknown",
              sessionIds: [],
              jsonlFile: null,
              model: matched.model,
            });
            seenTtys.add(psTty);
          }
          continue;
        }

        // If lsof missed the TTY but ps has it, use ps
        if (!info.tty && psTty && psTty !== "??" && psTty.startsWith("ttys")) {
          info.tty = psTty;
        }

        const effectiveTty = info.tty || psTty;
        // Skip processes with no usable TTY (background subprocesses, app servers)
        if (!effectiveTty || effectiveTty === "??" || !effectiveTty.startsWith("ttys")) continue;
        seenTtys.add(effectiveTty);
        results.push({ pid, cpuPercent, startedAt, ...info, model: matched.model });
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
        // Direct JSONL file detection  --  most reliable session file source
        // Supports both Claude (.claude/projects/*/UUID.jsonl) and Codex (.codex/sessions/*/rollout-*.jsonl)
        const jsonlMatch = lines[i].match(/^n(.*\.claude\/projects\/[^/]+\/[0-9a-f-]{36}\.jsonl)$/);
        if (jsonlMatch && !jsonlFile) {
          jsonlFile = jsonlMatch[1];
        }
        const codexJsonlMatch = lines[i].match(/^n(.*\.codex\/sessions\/.*\.jsonl)$/);
        if (codexJsonlMatch && !jsonlFile) {
          jsonlFile = codexJsonlMatch[1];
        }
        const geminiJsonlMatch = lines[i].match(/^n(.*\.gemini\/.*\.jsonl)$/);
        if (geminiJsonlMatch && !jsonlFile) {
          jsonlFile = geminiJsonlMatch[1];
        }
      }

      if (!cwd) return null;

      const { project, projectName } = this.projectIdentityFromCwd(cwd);

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
    const homeDir = process.env.HOME || process.env.USERPROFILE || homedir();
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
   * Build a TTY→file map from marker files written by identity.sh.
   * Each agent writes ~/.hive/sessions/{tty} containing its session_id on every prompt.
   * This is ground truth  --  it directly links a TTY to a specific JSONL file.
   * Marker files persist across daemon restarts (no in-memory state needed).
   */
  private buildTtyFileMap(processes: ProcessInfo[]): Map<string, string> {
    const ttyToFile = new Map<string, string>();
    if (processes.length === 0) return ttyToFile;

    const homeDir = process.env.HOME || process.env.USERPROFILE || homedir();
    const sessionsDir = join(homeDir, ".hive", "sessions");
    const projectsDir = join(homeDir, ".claude", "projects");

    // Collect all known TTYs from current processes
    const knownTtys = new Set(processes.map(p => p.tty).filter(Boolean));

    try {
      for (const ttyFile of readdirSync(sessionsDir)) {
        if (!knownTtys.has(ttyFile)) continue;
        try {
          const sessionId = readFileSync(join(sessionsDir, ttyFile), "utf-8").trim();
          if (!sessionId) continue;

          // Search ALL project directories for this session's JSONL.
          // After restart, sessions may land in a different encoded-cwd dir.
          try {
            for (const dir of readdirSync(projectsDir)) {
              const jsonlPath = join(projectsDir, dir, `${sessionId}.jsonl`);
              if (existsSync(jsonlPath)) {
                ttyToFile.set(ttyFile, jsonlPath);
                break;
              }
            }
          } catch { /* projectsDir doesn't exist */ }
        } catch { /* can't read marker */ }
      }
    } catch { /* sessions dir doesn't exist yet */ }

    if (ttyToFile.size > 0) {
      console.log(`[discovery] Marker-based TTY map: ${[...ttyToFile.entries()].map(([t, f]) => `${t}→${basename(f, ".jsonl").slice(0, 8)}`).join(", ")}`);
    }

    return ttyToFile;
  }

  /**
   * Find session file by matching JSONL creation time to process start time.
   * Each Claude Code session creates a fresh JSONL file on launch, so the
   * file's birthtime should be within ~30s of the process startedAt.
   * This is safe for shared-cwd scenarios (multiple home-dir sessions)
   * because birthtimes are unique per file, unlike mtime which changes constantly.
   */
  private findSessionFileByStartTime(cwd: string, startedAt: number, claimedFiles?: Set<string>): string | null {
    const homeDir = process.env.HOME || process.env.USERPROFILE || homedir();
    const projectsDir = join(homeDir, ".claude", "projects");
    const encoded = cwd.replace(/\//g, "-");
    const candidateDir = join(projectsDir, encoded);

    let bestFile: string | null = null;
    let bestDelta = Infinity;
    const MAX_DELTA = 60_000; // 60s tolerance between process start and file creation

    try {
      for (const file of readdirSync(candidateDir)) {
        if (!file.endsWith(".jsonl")) continue;
        const fullPath = join(candidateDir, file);
        // Skip files already claimed by another worker this scan cycle.
        // Without this, when all workers start within seconds (system restart),
        // all birthtimes cluster and every worker grabs the same file.
        if (claimedFiles?.has(fullPath)) continue;
        try {
          const stat = statSync(fullPath);
          const delta = Math.abs(stat.birthtimeMs - startedAt);
          if (delta < MAX_DELTA && delta < bestDelta) {
            bestDelta = delta;
            bestFile = fullPath;
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
          // abandoned before the current file was last active  --  not a successor.
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
      projectName: null, projectPath: null, latestAction: null, lastDirection: null,
      status: "idle", fileAgeMs: Infinity, highConfidence: false, fileAgeIsFromNoise: false,
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
      projectName: null, projectPath: null, latestAction: null, lastDirection: null,
      status: "idle", fileAgeMs: Infinity, highConfidence: false, fileAgeIsFromNoise: false,
    };

    const best = this.findBestJsonlFile(sessionIds, cwd);
    if (!best) return result;

    result.fileAgeMs = Date.now() - best.mtimeMs;
    return this.analyzeJsonlTail(best.path, result);
  }

  /**
   * Core JSONL tail analysis  --  shared by both readSessionContext variants.
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
      const hasRealEntry = /"type"\s*:\s*"(assistant|user)"/.test(tail) ||
        /"type"\s*:\s*"(user_message|agent_message)"/.test(tail) ||
        /"role"\s*:\s*"assistant"/.test(tail) ||
        /"role"\s*:\s*"user"/.test(tail);
      if (!hasRealEntry) {
        tail = readTail(filePath, 500_000);
      }

      // Extract project name from cwd field
      const cwdMatch = tail.match(/"cwd"\s*:\s*"([^"]+)"/);
      if (cwdMatch) {
        const cwd = cwdMatch[1];
        const identity = this.projectIdentityFromCwd(cwd);
        if (identity.projectName !== "unknown") {
          result.projectName = identity.projectName;
          result.projectPath = identity.project;
        }
      }

      const allLines = tail.split("\n").filter(Boolean);

      // Skip truncated first line. JSONL lines always start with '{'.
      // If the first line doesn't, it's a mid-line fragment from the tail cut.
      const rawLines = (allLines.length > 0 && !allLines[0].trimStart().startsWith("{"))
        ? allLines.slice(1)
        : allLines;

      // Filter out noise entries  --  progress/system/file-history-snapshot are
      // bookkeeping that Claude Code writes periodically even while idle.
      // They flood the scan window AND their writes keep file mtime fresh,
      // which causes phantom green via the 120s grace period.
      // Also filters Codex noise: token_count, session_meta, reasoning.
      const isNoiseLine = (l: string) =>
        l.includes('"type":"progress"') ||
        l.includes('"type":"system"') ||
        l.includes('"type":"file-history-snapshot"') ||
        l.includes('"type":"hook_progress"') ||
        l.includes('"type":"token_count"') ||
        l.includes('"type":"session_meta"') ||
        l.includes('"type":"reasoning"') ||
        l.includes('"type":"turn_context"') ||
        // OpenClaw noise: custom events (cache-ttl, etc.), session metadata, model/thinking changes
        l.includes('"type":"custom"') ||
        l.includes('"type":"session"') ||
        l.includes('"type":"model_change"') ||
        l.includes('"type":"thinking_level_change"');
      const lines = rawLines.filter(l => !isNoiseLine(l));

      // Check if the file's mtime freshness is from noise writes (progress,
      // system, etc.) rather than real content. When the last raw line is noise,
      // fileAgeMs is unreliable  --  noise keeps it artificially fresh.
      const lastRawLine = rawLines[rawLines.length - 1] || "";
      const fileAgeIsFromNoise = isNoiseLine(lastRawLine);
      result.fileAgeIsFromNoise = fileAgeIsFromNoise;

      // Extract latest action for display
      for (let i = lines.length - 1; i >= Math.max(0, lines.length - 20); i--) {
        const action = this.parseActionFromLine(lines[i]);
        if (action) { result.latestAction = action; break; }
      }

      // Extract last human direction  --  the most recent user-typed message.
      // Claude: "type":"user" with content as a plain string.
      // Codex: "type":"user_message" in event_msg with "message" field.
      // OpenClaw: "type":"message" with "role":"user" and content as [{type:"text",text:"..."}].
      // Tool results also have "type":"user" but content is an array.
      for (let i = lines.length - 1; i >= Math.max(0, lines.length - 80); i--) {
        const line = lines[i];

        // Codex user message: {"type":"event_msg","payload":{"type":"user_message","message":"..."}}
        if (line.includes('"user_message"')) {
          const msgMatch = line.match(/"message"\s*:\s*"([^"]{3,})"/);
          if (msgMatch) {
            let direction = msgMatch[1].replace(/\\n/g, " ").replace(/\\"/g, '"').trim();
            if (direction.length > 60) direction = direction.slice(0, 57) + "...";
            result.lastDirection = direction;
            break;
          }
        }

        // OpenClaw user message: {"type":"message",...,"message":{"role":"user","content":[{"type":"text","text":"..."}]}}
        if (line.includes('"type":"message"') && line.includes('"role":"user"')) {
          const textMatch = line.match(/"type":"text","text":"((?:[^"\\]|\\.)*)"/);
          if (textMatch) {
            // Decode JSON escapes first, then strip routing prefix
            let direction = textMatch[1]
              .replace(/\\n/g, "\n")
              .replace(/\\"/g, '"')
              .replace(/\\\\/g, "\\");
            // Strip OpenClaw gateway routing prefix (sender metadata block + timestamp)
            direction = direction.replace(/^Sender \(untrusted metadata\):[\s\S]*?\n\n/, "");
            // Strip timestamp prefix like [Wed 2026-03-18 01:34 EDT]
            direction = direction.replace(/^\[.*?\]\s*/, "").trim();
            if (direction.startsWith("Read HEARTBEAT.md")) continue;
            if (direction.length > 60) direction = direction.slice(0, 57) + "...";
            if (direction.length >= 3) {
              result.lastDirection = direction;
              break;
            }
          }
        }

        // Claude user message
        if (!line.includes('"type":"user"') && !line.includes('"type": "user"')) continue;
        if (line.includes('"tool_result"')) continue;
        const contentMatch = line.match(/"content"\s*:\s*"([^"]{3,})"/);
        if (contentMatch) {
          let direction = contentMatch[1]
            .replace(/\\n/g, " ")
            .replace(/\\"/g, '"')
            .trim();
          if (direction.startsWith("This session is being continued")) continue;
          if (direction.length > 60) direction = direction.slice(0, 57) + "...";
          result.lastDirection = direction;
          break;
        }
      }

      // Tail analysis is the sole status engine. No mtime shortcut  -- 
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
      let latestStartedTurnId: string | null = null;
      let sawNewerTurnActivity = false;

      for (let i = lines.length - 1; i >= Math.max(0, lines.length - 20); i--) {
        const line = lines[i];

        // Codex: if a newer turn has already started, any older task_complete
        // belongs to the PREVIOUS turn and must not force idle for the current one.
        if (line.includes('"task_started"')) {
          latestStartedTurnId ||= extractTurnId(line);
          sawNewerTurnActivity = true;
          foundAnyPattern = true;
          continue;
        }

        // Codex: task_complete is a definitive "done" signal  --  immediate idle.
        // No cooldown or hysteresis needed. This is the strongest idle indicator.
        if (line.includes('"task_complete"')) {
          const completedTurnId = extractTurnId(line);
          const stalePreviousTurn =
            sawNewerTurnActivity &&
            (!latestStartedTurnId || completedTurnId !== latestStartedTurnId);
          if (stalePreviousTurn) {
            foundAnyPattern = true;
            continue;
          }
          result.status = "idle";
          result.highConfidence = true;
          foundAnyPattern = true;
          return result;
        }

        // Pattern 1: tool in flight (tool_use/function_call without result after it)
        // Claude: "tool_result" | Codex: "function_call_output" | OpenClaw: "role":"toolResult"
        if (line.includes('"tool_result"') || line.includes('"function_call_output"') ||
            line.includes('"role":"toolResult"')) {
          foundAnyPattern = true;
          lastUser = true;
          break;
        }
        // Claude: tool_use in assistant message | Codex: function_call response_item
        // OpenClaw: "toolCall" in assistant message
        if (!lastAssistant && line.includes('"tool_use"') && line.includes('"assistant"')) {
          result.status = "working";
          result.highConfidence = true;
          return result;
        }
        if (!lastAssistant && line.includes('"function_call"') && !line.includes('"function_call_output"')) {
          result.status = "working";
          result.highConfidence = true;
          return result;
        }
        if (!lastAssistant && line.includes('"toolCall"') && line.includes('"role":"assistant"')) {
          result.status = "working";
          result.highConfidence = true;
          return result;
        }

        // Pattern 2: thinking  --  track last message type
        // Claude: "type":"user" / "type":"assistant"
        // Codex: "type":"user_message" (event_msg) / "role":"assistant" (response_item)
        // OpenClaw: "type":"message" with "role":"user" / "role":"assistant"
        // Skip Codex "agent_message" events  --  they accompany assistant responses, not user input.
        if (!lastUser && !lastAssistant) {
          if ((line.includes('"type":"user"') || line.includes('"type": "user"') ||
              line.includes('"type":"user_message"') ||
              (line.includes('"type":"message"') && line.includes('"role":"user"'))) &&
              !line.includes('"agent_message"')) {
            lastUser = true;
            sawNewerTurnActivity = true;
            foundAnyPattern = true;
          } else if (line.includes('"type":"assistant"') || line.includes('"type": "assistant"') ||
                     (line.includes('"role":"assistant"') && line.includes('"response_item"')) ||
                     (line.includes('"type":"message"') && line.includes('"role":"assistant"'))) {
            lastAssistant = true;
            foundAnyPattern = true;
          }
        }
      }

      // If the last meaningful entry was user input (or tool_result) and
      // Claude hasn't responded yet, it's thinking  --  show green.
      // BUT: if the file is very stale (>2 min), this is likely a compacted
      // session where Claude already responded in a NEW file.
      if (lastUser && !lastAssistant && result.fileAgeMs < 120_000) {
        result.status = "working";
        result.highConfidence = !fileAgeIsFromNoise; // noise freshness = low confidence
        result.latestAction = "Thinking...";
        return result;
      }

      // Assistant message at tail  --  but if the file was JUST modified (<4s),
      // Claude is mid-stream (still writing its response, or about to call
      // a tool). Don't flip to idle until the file has been quiet for 4s.
      // NEVER set this above 5s or below 2s  --  documented in hive-daemon.md.
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
      // that content  --  show green.
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
      // ── Claude format: tool_use blocks ──
      if (line.includes("tool_use")) {
        const toolMatch = line.match(/"tool_use"[^}]*?"name"\s*:\s*"([^"]+)"/);
        if (toolMatch) {
          const toolName = toolMatch[1];
          const fileMatch = line.match(/"file_path"\s*:\s*"([^"]+)"/);
          const descMatch = line.match(/"description"\s*:\s*"([^"]{1,60})"/);
          const cmdMatch = line.match(/"command"\s*:\s*"([^"]{1,60})"/);
          const patternMatch = line.match(/"pattern"\s*:\s*"([^"]{1,30})"/);

          switch (toolName) {
            case "Bash":
              if (descMatch) return descMatch[1];
              if (cmdMatch) return describeBashCommand(cmdMatch[1]);
              return "Running command";
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
        }
      }

      // ── OpenClaw format: toolCall in assistant message ──
      if (line.includes('"toolCall"') && line.includes('"role":"assistant"')) {
        const toolMatch = line.match(/"type":"toolCall"[^}]*?"name"\s*:\s*"([^"]+)"/);
        if (toolMatch) {
          // OpenClaw uses lowercase tool names  --  capitalize for describeAction
          const name = toolMatch[1].charAt(0).toUpperCase() + toolMatch[1].slice(1);
          const fileMatch = line.match(/"file_path"\s*:\s*"([^"]+)"/);
          const descMatch = line.match(/"description"\s*:\s*"([^"]{1,60})"/);
          const cmdMatch = line.match(/"command"\s*:\s*"([^"]{1,60})"/);
          switch (name) {
            case "Bash":
              if (descMatch) return descMatch[1];
              if (cmdMatch) return describeBashCommand(cmdMatch[1]);
              return "Running command";
            case "Edit":
              return fileMatch ? `Editing ${basename(fileMatch[1])}` : "Editing file";
            case "Write":
              return fileMatch ? `Writing ${basename(fileMatch[1])}` : "Writing file";
            case "Read":
              return fileMatch ? `Reading ${basename(fileMatch[1])}` : "Reading file";
            default:
              return name;
          }
        }
      }

      // ── Codex format: function_call in response_item ──
      if (line.includes('"function_call"') && !line.includes('"function_call_output"')) {
        const nameMatch = line.match(/"function_call"[^}]*?"name"\s*:\s*"([^"]+)"/);
        if (!nameMatch) return null;
        const name = nameMatch[1];
        const cmdMatch = line.match(/"cmd"\s*(?::|\\"):\s*(?:\\")([^"\\]{1,60})/);
        switch (name) {
          case "exec_command":
            return cmdMatch ? describeBashCommand(cmdMatch[1]) : "Running command";
          case "read_file":
            return "Reading file";
          case "write_file":
            return "Writing file";
          case "list_directory":
            return "Listing files";
          default:
            return name;
        }
      }

      return null;
    } catch {
      return null;
    }
  }

  private projectIdentityFromCwd(cwd: string): { project: string; projectName: string } {
    if (cwd === HOME || cwd === "/") {
      return {
        project: HOME,
        projectName: "home",
      };
    }

    const factoryMatch = cwd.match(/^(.*\/factory\/projects\/([^/]+))(?:\/.*)?$/);
    if (factoryMatch) {
      return {
        project: factoryMatch[1],
        projectName: factoryMatch[2],
      };
    }

    return {
      project: cwd,
      projectName: cwd.split("/").pop() || cwd,
    };
  }
}
