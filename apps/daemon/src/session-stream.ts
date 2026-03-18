import { existsSync, readFileSync, statSync, readdirSync, watch, type FSWatcher } from "fs";
import { basename, join } from "path";
import type { ChatEntry } from "./types.js";
import { describeAction, describeBashCommand, truncate } from "./utils.js";

const MAX_USER_MESSAGES = 50;
const POLL_INTERVAL = 500; // fallback poll if fs.watch misses events
const NUDGE_INTERVALS = [200, 500, 1_000, 2_000, 4_000]; // rapid polls after message send

interface Subscription {
  workerId: string;
  filePath: string;
  byteOffset: number;
  timer: ReturnType<typeof setInterval>;
  watcher: FSWatcher | null;
  callback: (entries: ChatEntry[], full?: boolean) => void;
  nudgeTimers: ReturnType<typeof setTimeout>[];
  /** For Gemini JSON files: track message count to detect new messages */
  geminiMsgCount?: number;
}

interface PendingSub {
  subKey: string;
  workerId: string;
  callback: (entries: ChatEntry[], full?: boolean) => void;
}

export class SessionStreamer {
  private subscriptions = new Map<string, Subscription>();
  // worker_id → session file path (set by discovery)
  private sessionFiles = new Map<string, string>();
  // Subscribers waiting for a session file to be mapped
  private pendingSubs: PendingSub[] = [];

  setSessionFile(workerId: string, filePath: string): void {
    this.sessionFiles.set(workerId, filePath);

    // Activate any pending subscriptions waiting for this worker's session file
    const pending = this.pendingSubs.filter(p => p.workerId === workerId);
    this.pendingSubs = this.pendingSubs.filter(p => p.workerId !== workerId);
    for (const p of pending) {
      // Send full history then start live subscription
      const history = this.readHistory(workerId);
      if (history.length > 0) p.callback(history, true);
      this.startSubscription(p.subKey, workerId, filePath, p.callback);
    }
  }

  getSessionFile(workerId: string): string | null {
    return this.sessionFiles.get(workerId) || null;
  }

  /** Clean up all state for a removed worker (session file, pending subs, active subs) */
  clearWorker(workerId: string): void {
    this.sessionFiles.delete(workerId);
    this.pendingSubs = this.pendingSubs.filter(p => p.workerId !== workerId);
    // Remove any active subscriptions for this worker
    for (const [key, sub] of this.subscriptions) {
      if (key.startsWith(workerId + "_")) {
        clearInterval(sub.timer);
        for (const t of sub.nudgeTimers) clearTimeout(t);
        if (sub.watcher) sub.watcher.close();
        this.subscriptions.delete(key);
      }
    }
  }

  /**
   * Find the best session file for a worker by scanning .claude/projects/
   */
  findSessionFile(sessionIds: string[]): string | null {
    const homeDir = process.env.HOME || `/Users/${process.env.USER}`;
    const projectsDir = join(homeDir, ".claude", "projects");

    let bestFile: string | null = null;
    let bestMtime = 0;

    try {
      for (const projectDir of readdirSync(projectsDir)) {
        const fullDir = join(projectsDir, projectDir);
        for (const sessionId of sessionIds) {
          const jsonlPath = join(fullDir, `${sessionId}.jsonl`);
          try {
            const stat = statSync(jsonlPath);
            if (stat.mtimeMs > bestMtime) {
              bestMtime = stat.mtimeMs;
              bestFile = jsonlPath;
            }
          } catch {
            // File doesn't exist
          }
        }
      }
    } catch {
      // projects dir doesn't exist
    }

    return bestFile;
  }

  /**
   * Verify the session file mapping for a worker by cross-checking the
   * TTY marker file (~/.hive/sessions/{tty}). If the marker says a different
   * session ID than what's currently mapped, correct the mapping.
   *
   * Called on subscribe to prevent chat cross-contamination when multiple
   * workers share the same project directory.
   */
  verifySessionFile(workerId: string, tty: string | undefined): boolean {
    if (!tty) return false;

    const homeDir = process.env.HOME || `/Users/${process.env.USER}`;
    const markerPath = join(homeDir, ".hive", "sessions", tty);
    let markerSessionId: string;
    try {
      markerSessionId = readFileSync(markerPath, "utf-8").trim();
    } catch {
      return false; // No marker file — can't verify
    }
    if (!markerSessionId || markerSessionId.length < 30) return false;

    // Check if current mapping already points to the correct session
    const currentFile = this.sessionFiles.get(workerId);
    if (currentFile && basename(currentFile, ".jsonl") === markerSessionId) {
      return false; // Already correct
    }

    // Find the JSONL file for the marker's session ID
    const projectsDir = join(homeDir, ".claude", "projects");
    try {
      for (const projectDir of readdirSync(projectsDir)) {
        const candidatePath = join(projectsDir, projectDir, `${markerSessionId}.jsonl`);
        if (existsSync(candidatePath)) {
          const oldName = currentFile ? basename(currentFile) : "none";
          console.log(`[session-verify] Correcting ${workerId} (${tty}): ${oldName} → ${markerSessionId}.jsonl`);
          this.sessionFiles.set(workerId, candidatePath);
          return true;
        }
      }
    } catch {
      // projects dir missing
    }
    return false;
  }

  /**
   * Read recent chat history from a session file.
   * Returns coherent conversation: user messages + agent responses only,
   * limited to the last MAX_USER_MESSAGES user messages.
   */
  readHistory(workerId: string): ChatEntry[] {
    const filePath = this.sessionFiles.get(workerId);
    if (!filePath) return [];

    try {
      let entries: ChatEntry[];

      // Gemini JSON format: single JSON object with messages array
      if (filePath.endsWith(".json")) {
        entries = parseGeminiSession(filePath);
      } else {
        // Claude/Codex JSONL format: one JSON object per line
        const buf = readFileSync(filePath);
        const content = buf.toString("utf-8");
        const lines = content.split("\n").filter(Boolean);

        entries = [];
        for (const line of lines) {
          const parsed = parseLine(line);
          if (parsed) entries.push(...parsed);
        }
      }

      return filterCoherent(entries);
    } catch {
      return [];
    }
  }

  /**
   * Subscribe to new messages from a worker's session file.
   * @param subKey - unique subscription key (e.g. workerId + clientId)
   * @param workerId - plain worker ID used to look up the session file
   * @param callback - receives new chat entries
   */
  subscribe(subKey: string, workerId: string, callback: (entries: ChatEntry[], full?: boolean) => void): void {
    this.unsubscribe(subKey);

    const filePath = this.sessionFiles.get(workerId);
    if (!filePath) {
      // Session file not mapped yet (agent just spawned) — queue for later
      this.pendingSubs = this.pendingSubs.filter(p => p.subKey !== subKey);
      this.pendingSubs.push({ subKey, workerId, callback });
      return;
    }

    this.startSubscription(subKey, workerId, filePath, callback);
  }

  private startSubscription(subKey: string, workerId: string, filePath: string, callback: (entries: ChatEntry[], full?: boolean) => void): void {
    // Start from current end of file
    let byteOffset: number;
    try {
      byteOffset = statSync(filePath).size;
    } catch {
      return;
    }

    // Use fs.watch for instant file change detection, with polling fallback
    let watcher: FSWatcher | null = null;
    try {
      watcher = watch(filePath, () => this.poll(subKey));
    } catch {
      // fs.watch can fail on some filesystems
    }

    // For Gemini JSON files, initialize message count to current count
    // so the first poll doesn't re-send messages already delivered by readHistory.
    let geminiMsgCount: number | undefined;
    if (filePath.endsWith(".json")) {
      geminiMsgCount = parseGeminiSession(filePath).length;
    }

    const sub: Subscription = {
      workerId,
      filePath,
      byteOffset,
      geminiMsgCount,
      callback,
      watcher,
      timer: setInterval(() => this.poll(subKey), POLL_INTERVAL),
      nudgeTimers: [],
    };

    this.subscriptions.set(subKey, sub);
  }

  unsubscribe(subKey: string): void {
    const sub = this.subscriptions.get(subKey);
    if (sub) {
      clearInterval(sub.timer);
      for (const t of sub.nudgeTimers) clearTimeout(t);
      if (sub.watcher) sub.watcher.close();
      this.subscriptions.delete(subKey);
    }
    this.pendingSubs = this.pendingSubs.filter(p => p.subKey !== subKey);
  }

  /**
   * Trigger rapid polling for a worker after a message was sent to it.
   * Schedules multiple polls at increasing intervals so the agent's response
   * appears on the dashboard within ~200ms of being written to the JSONL.
   */
  nudge(workerId: string): void {
    for (const [subKey, sub] of this.subscriptions) {
      if (sub.workerId !== workerId) continue;
      // Clear any existing nudge timers to avoid stacking
      for (const t of sub.nudgeTimers) clearTimeout(t);
      sub.nudgeTimers = NUDGE_INTERVALS.map((ms) =>
        setTimeout(() => this.poll(subKey), ms)
      );
    }
  }

  private poll(subKey: string): void {
    const sub = this.subscriptions.get(subKey);
    if (!sub) return;

    // Detect session file change (context compaction creates a new JSONL).
    // Discovery updates sessionFiles on every scan — if the file changed,
    // switch to the new one and send its full history as a full replace.
    let isFileChange = false;
    const currentFile = this.sessionFiles.get(sub.workerId);
    if (currentFile && currentFile !== sub.filePath) {
      if (sub.watcher) sub.watcher.close();
      sub.filePath = currentFile;
      sub.byteOffset = 0; // Read from start of new file
      isFileChange = true;
      try {
        sub.watcher = watch(currentFile, () => this.poll(subKey));
      } catch { sub.watcher = null; }
    }

    try {
      // Gemini JSON files: re-read whole file, diff by message count
      if (sub.filePath.endsWith(".json")) {
        const allEntries = parseGeminiSession(sub.filePath);
        const prevCount = sub.geminiMsgCount ?? 0;
        sub.geminiMsgCount = allEntries.length;
        if (isFileChange) {
          const filtered = filterCoherent(allEntries);
          if (filtered.length > 0) sub.callback(filtered, true);
        } else if (allEntries.length > prevCount) {
          // Incremental: filter out tool entries only (no user-message limit)
          const newEntries = allEntries.slice(prevCount).filter(e => e.role !== "tool");
          if (newEntries.length > 0) sub.callback(newEntries);
        }
        return;
      }

      // Claude/Codex JSONL: incremental byte-offset reads
      const stat = statSync(sub.filePath);
      if (stat.size <= sub.byteOffset) return;

      const buf = readFileSync(sub.filePath);
      const newContent = buf.subarray(sub.byteOffset).toString("utf-8");
      // Use buf.length (actual bytes read) not stat.size — file may have grown between stat and read
      sub.byteOffset = buf.length;

      const entries: ChatEntry[] = [];
      for (const line of newContent.split("\n").filter(Boolean)) {
        const parsed = parseLine(line);
        if (parsed) entries.push(...parsed);
      }

      if (entries.length > 0) {
        if (isFileChange) {
          // File change = full replace with coherent filtering
          const filtered = filterCoherent(entries);
          if (filtered.length > 0) sub.callback(filtered, true);
        } else {
          // Incremental: filter out tool entries only
          const coherent = entries.filter(e => e.role !== "tool");
          if (coherent.length > 0) sub.callback(coherent);
        }
      }
    } catch {
      // File might have been deleted/rotated
    }
  }
}

/** Regex to detect hive routing messages */
const HIVE_ROUTING_RE = /^Read \/Users\/\w+\/\.hive\/context-messages\/(msg-[\w-]+\.md) and follow it exactly\./;

/** Extract real user message from a hive context-message file */
function resolveRoutedMessage(text: string): string | null {
  const match = text.match(HIVE_ROUTING_RE);
  if (!match) return null;
  try {
    const homeDir = process.env.HOME || `/Users/${process.env.USER}`;
    const filePath = join(homeDir, ".hive", "context-messages", match[1]);
    const content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n");
    // Skip header: "# Hive Routed Message", Target, Model, Created lines
    let startIdx = 0;
    for (let i = 0; i < lines.length && i < 6; i++) {
      if (lines[i].startsWith("# Hive Routed Message") || lines[i].startsWith("# Loom Routed Message") ||
          lines[i].startsWith("Target:") ||
          lines[i].startsWith("Model:") ||
          lines[i].startsWith("Created:")) {
        startIdx = i + 1;
      }
    }
    return lines.slice(startIdx).join("\n").trim() || null;
  } catch {
    return null;
  }
}

/** Clean system tags from user messages so only human-written content remains */
function cleanUserMessage(text: string): string | null {
  let cleaned = text;
  // Strip system-reminder blocks
  cleaned = cleaned.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "");
  // Strip local-command-caveat blocks
  cleaned = cleaned.replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, "");
  // Strip command tags (slash commands shown in terminal)
  cleaned = cleaned.replace(/<command-name>[\s\S]*?<\/command-name>/g, "");
  cleaned = cleaned.replace(/<command-message>[\s\S]*?<\/command-message>/g, "");
  cleaned = cleaned.replace(/<command-args>[\s\S]*?<\/command-args>/g, "");
  cleaned = cleaned.replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, "");
  cleaned = cleaned.trim();
  return cleaned || null;
}

/**
 * Filter entries to coherent conversation: user messages + agent responses only,
 * limited to the last MAX_USER_MESSAGES user messages.
 */
function filterCoherent(entries: ChatEntry[]): ChatEntry[] {
  // Remove tool entries — show only user messages and agent text responses
  const coherent = entries.filter(e => e.role !== "tool");

  // Find the start index: walk backwards counting user messages
  let userCount = 0;
  let startIdx = 0;
  for (let i = coherent.length - 1; i >= 0; i--) {
    if (coherent[i].role === "user") {
      userCount++;
      if (userCount >= MAX_USER_MESSAGES) {
        startIdx = i;
        break;
      }
    }
  }

  return coherent.slice(startIdx);
}

/** Parse a single JSONL line into chat entries (Claude or Codex format) */
function parseLine(line: string): ChatEntry[] | null {
  try {
    const obj = JSON.parse(line);
    const type = obj.type as string;

    // ── Claude format ──
    if (type === "user") {
      let text = extractText(obj.message?.content);
      if (!text) return null;

      // Resolve hive routing messages to their real content
      const routed = resolveRoutedMessage(text);
      if (routed !== null) text = routed;

      // Clean system tags from user messages
      text = cleanUserMessage(text);
      if (text) return [{ role: "user", text }];
      return null;
    }

    if (type === "assistant") {
      const entries: ChatEntry[] = [];
      const content = obj.message?.content;

      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "text" && block.text?.trim()) {
            entries.push({ role: "agent", text: block.text.trim() });
          } else if (block.type === "tool_use") {
            const desc = describeAction(block.name, block.input);
            entries.push({ role: "tool", text: desc });
          }
        }
      } else if (typeof content === "string" && content.trim()) {
        entries.push({ role: "agent", text: content.trim() });
      }

      return entries.length > 0 ? entries : null;
    }

    // ── OpenClaw format ──
    // OpenClaw wraps everything in {type:"message", message:{role:"...", content:[...]}}
    if (type === "message" && obj.message) {
      const msg = obj.message;
      if (msg.role === "user") {
        let text = extractText(msg.content);
        if (!text) return null;
        // Strip OpenClaw gateway routing prefix (sender metadata + timestamp)
        text = text.replace(/^Sender \(untrusted metadata\):[\s\S]*?\n\n\[.*?\]\s*/m, "");
        const routed = resolveRoutedMessage(text);
        if (routed !== null) text = routed;
        text = cleanUserMessage(text);
        if (text) return [{ role: "user", text }];
        return null;
      }
      if (msg.role === "assistant") {
        const entries: ChatEntry[] = [];
        if (Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block.type === "text" && block.text?.trim()) {
              entries.push({ role: "agent", text: block.text.trim() });
            } else if (block.type === "toolCall") {
              // OpenClaw uses lowercase tool names — capitalize for describeAction
              const name = block.name ? (block.name.charAt(0).toUpperCase() + block.name.slice(1)) : undefined;
              const desc = describeAction(name, block.arguments);
              entries.push({ role: "tool", text: desc });
            }
          }
        }
        return entries.length > 0 ? entries : null;
      }
      // toolResult → skip (same as Claude tool_result)
      return null;
    }

    // ── Codex format ──
    // Codex wraps everything in {type, payload}
    const p = obj.payload;
    if (!p) return null;

    // User message: {type:"event_msg", payload:{type:"user_message", message:"..."}}
    if (type === "event_msg" && p.type === "user_message" && p.message) {
      const text = typeof p.message === "string" ? p.message.trim() : null;
      if (text) return [{ role: "user", text }];
    }

    if (type === "response_item") {
      // Assistant text: {type:"response_item", payload:{role:"assistant", content:[{type:"output_text", text:"..."}]}}
      if (p.role === "assistant" && p.content) {
        const entries: ChatEntry[] = [];
        if (Array.isArray(p.content)) {
          for (const block of p.content) {
            if (block.type === "output_text" && block.text?.trim()) {
              entries.push({ role: "agent", text: block.text.trim() });
            }
          }
        }
        return entries.length > 0 ? entries : null;
      }

      // Tool call: {type:"response_item", payload:{type:"function_call", name:"exec_command", arguments:"..."}}
      if (p.type === "function_call" && p.name) {
        let input: Record<string, unknown> | undefined;
        try { input = JSON.parse(p.arguments || "{}"); } catch { /* ignore */ }
        const desc = describeCodexAction(p.name, input);
        return [{ role: "tool", text: desc }];
      }

      // Tool result: {type:"response_item", payload:{type:"function_call_output", output:"..."}}
      if (p.type === "function_call_output") {
        return null; // Skip tool outputs (same as Claude — only show call descriptions)
      }
    }

    return null;
  } catch {
    return null;
  }
}

/** Describe a Codex tool call for display */
function describeCodexAction(name: string, input?: Record<string, unknown>): string {
  if (!input) return name;
  switch (name) {
    case "exec_command":
      return input.cmd ? describeBashCommand(truncate(input.cmd as string, 60)) : "Running command";
    case "read_file":
      return input.path ? `Reading ${basename(input.path as string)}` : "Reading file";
    case "write_file":
      return input.path ? `Writing ${basename(input.path as string)}` : "Writing file";
    case "list_directory":
      return input.path ? `Listing ${basename(input.path as string)}` : "Listing files";
    default:
      return name;
  }
}

/**
 * Parse a Gemini CLI session JSON file into ChatEntry objects.
 * Gemini format:
 *   user content: array of {text: "..."} objects
 *   gemini content: plain string
 *   info/warning: skip (update notices, home dir warnings)
 */
function parseGeminiSession(filePath: string): ChatEntry[] {
  try {
    const raw = readFileSync(filePath, "utf-8");
    const session = JSON.parse(raw);
    if (!session.messages || !Array.isArray(session.messages)) return [];

    const entries: ChatEntry[] = [];
    for (const msg of session.messages) {
      if (msg.type === "user") {
        // User content is an array: [{text: "Hi"}]
        const text = extractGeminiUserText(msg.content);
        if (text) entries.push({ role: "user", text });
      } else if (msg.type === "gemini") {
        // Agent content is a plain string
        const text = typeof msg.content === "string" ? msg.content.trim() : null;
        if (text) entries.push({ role: "agent", text });
        // Tool calls on this message
        if (Array.isArray(msg.toolCalls)) {
          for (const tc of msg.toolCalls) {
            const name = tc.name || tc.functionName || "tool";
            entries.push({ role: "tool", text: name });
          }
        }
      }
      // Skip: info, warning
    }
    return entries;
  } catch {
    return [];
  }
}

/** Extract text from Gemini user message content (array of {text} parts) */
function extractGeminiUserText(content: unknown): string | null {
  if (typeof content === "string") return content.trim() || null;
  if (Array.isArray(content)) {
    const parts = content
      .map((p: Record<string, unknown>) => typeof p.text === "string" ? p.text : "")
      .filter(Boolean);
    return parts.join(" ").trim() || null;
  }
  return null;
}

function extractText(content: unknown): string | null {
  if (typeof content === "string") return content.trim() || null;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === "text" && block.text?.trim()) {
        return block.text.trim();
      }
    }
  }
  return null;
}

