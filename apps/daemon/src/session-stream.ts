import { readFileSync, statSync, readdirSync, watch, type FSWatcher } from "fs";
import { basename, join } from "path";
import type { ChatEntry } from "./types.js";

const MAX_HISTORY = 50;
const POLL_INTERVAL = 1_000; // fallback poll if fs.watch misses events

interface Subscription {
  filePath: string;
  byteOffset: number;
  timer: ReturnType<typeof setInterval>;
  watcher: FSWatcher | null;
  callback: (entries: ChatEntry[]) => void;
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
      filePath,
      byteOffset,
      callback,
      watcher,
      timer: setInterval(() => this.poll(subKey), POLL_INTERVAL),
    };

    this.subscriptions.set(subKey, sub);
  }

  unsubscribe(workerId: string): void {
    const sub = this.subscriptions.get(workerId);
    if (sub) {
      clearInterval(sub.timer);
      if (sub.watcher) sub.watcher.close();
      this.subscriptions.delete(workerId);
    }
  }

  private poll(workerId: string): void {
    const sub = this.subscriptions.get(workerId);
    if (!sub) return;

    try {
      const stat = statSync(sub.filePath);
      if (stat.size <= sub.byteOffset) return;

      const buf = readFileSync(sub.filePath);
      const newContent = buf.subarray(sub.byteOffset).toString("utf-8");
      sub.byteOffset = stat.size;

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
            const desc = describeToolUse(block.name, block.input);
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

function describeToolUse(name: string, input: Record<string, unknown> | undefined): string {
  if (!input) return `Using ${name}`;

  const filePath = input.file_path as string | undefined;
  const fileName = filePath ? basename(filePath) : undefined;

  switch (name) {
    case "Bash":
      return input.description as string || `$ ${truncate(input.command as string, 80)}` || "Running command";
    case "Edit":
      return fileName ? `Editing ${fileName}` : "Editing file";
    case "Write":
      return fileName ? `Writing ${fileName}` : "Writing file";
    case "Read":
      return fileName ? `Reading ${fileName}` : "Reading file";
    case "Grep":
      return input.pattern ? `Searching "${truncate(input.pattern as string, 40)}"` : "Searching code";
    case "Glob":
      return input.pattern ? `Finding ${truncate(input.pattern as string, 40)}` : "Finding files";
    case "WebFetch":
      return "Fetching web page";
    case "WebSearch":
      return `Searching web: ${truncate(input.query as string, 50)}`;
    case "Task":
      return `Running subagent: ${truncate(input.description as string, 50)}`;
    case "AskUserQuestion": {
      const questions = input.questions as Array<{
        question?: string;
        options?: Array<{ label?: string; description?: string }>;
      }> | undefined;
      if (questions && questions.length > 0) {
        const q = questions[0];
        let text = q.question || "Question";
        if (q.options && q.options.length > 0) {
          text += "\n" + q.options.map((o, i) => `${i + 1}. ${o.label || "Option"}`).join("\n");
        }
        return text;
      }
      return "Asking you a question";
    }
    default:
      return `Using ${name}`;
  }
}

function truncate(s: string | undefined, max: number): string {
  if (!s) return "";
  return s.length > max ? s.slice(0, max) + "..." : s;
}
