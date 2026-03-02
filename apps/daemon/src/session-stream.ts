import { readFileSync, statSync, readdirSync, watch, type FSWatcher } from "fs";
import { join } from "path";
import type { ChatEntry } from "./types.js";
import { describeAction, truncate } from "./utils.js";

const MAX_HISTORY = 50;
const POLL_INTERVAL = 500; // fallback poll if fs.watch misses events
const NUDGE_INTERVALS = [200, 500, 1_000, 2_000, 4_000]; // rapid polls after message send

interface Subscription {
  workerId: string;
  filePath: string;
  byteOffset: number;
  timer: ReturnType<typeof setInterval>;
  watcher: FSWatcher | null;
  callback: (entries: ChatEntry[]) => void;
  nudgeTimers: ReturnType<typeof setTimeout>[];
}

export class SessionStreamer {
  private subscriptions = new Map<string, Subscription>();
  // worker_id → session file path (set by discovery)
  private sessionFiles = new Map<string, string>();

  setSessionFile(workerId: string, filePath: string): void {
    this.sessionFiles.set(workerId, filePath);
  }

  getSessionFile(workerId: string): string | null {
    return this.sessionFiles.get(workerId) || null;
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
   * Read recent chat history from a session file.
   */
  readHistory(workerId: string): ChatEntry[] {
    const filePath = this.sessionFiles.get(workerId);
    if (!filePath) return [];

    try {
      const buf = readFileSync(filePath);
      const content = buf.toString("utf-8");
      const lines = content.split("\n").filter(Boolean);

      const entries: ChatEntry[] = [];
      for (const line of lines) {
        const parsed = parseLine(line);
        if (parsed) entries.push(...parsed);
      }

      // Return last MAX_HISTORY entries
      return entries.slice(-MAX_HISTORY);
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
  subscribe(subKey: string, workerId: string, callback: (entries: ChatEntry[]) => void): void {
    this.unsubscribe(subKey);

    const filePath = this.sessionFiles.get(workerId);
    if (!filePath) return;

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

    const sub: Subscription = {
      workerId,
      filePath,
      byteOffset,
      callback,
      watcher,
      timer: setInterval(() => this.poll(subKey), POLL_INTERVAL),
      nudgeTimers: [],
    };

    this.subscriptions.set(subKey, sub);
  }

  unsubscribe(workerId: string): void {
    const sub = this.subscriptions.get(workerId);
    if (sub) {
      clearInterval(sub.timer);
      for (const t of sub.nudgeTimers) clearTimeout(t);
      if (sub.watcher) sub.watcher.close();
      this.subscriptions.delete(workerId);
    }
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
    // switch to the new one and send its full history as new entries.
    const currentFile = this.sessionFiles.get(sub.workerId);
    if (currentFile && currentFile !== sub.filePath) {
      if (sub.watcher) sub.watcher.close();
      sub.filePath = currentFile;
      sub.byteOffset = 0; // Read from start of new file
      try {
        sub.watcher = watch(currentFile, () => this.poll(subKey));
      } catch { sub.watcher = null; }
    }

    try {
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
        sub.callback(entries);
      }
    } catch {
      // File might have been deleted/rotated
    }
  }
}

/** Parse a single JSONL line into chat entries */
function parseLine(line: string): ChatEntry[] | null {
  try {
    const obj = JSON.parse(line);
    const type = obj.type as string;

    if (type === "user") {
      const text = extractText(obj.message?.content);
      if (text) return [{ role: "user", text }];
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

    return null;
  } catch {
    return null;
  }
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

