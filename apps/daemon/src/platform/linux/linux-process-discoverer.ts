// Requires tmux to be installed

import { execFileSync } from "child_process";
import { existsSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { DiscoveredProcess, ProcessDiscoverer } from "../interfaces.js";

const HOME = process.env.HOME || homedir();

interface AgentPattern {
  regex: RegExp;
  model: string;
}

function loadAgentPatterns(): AgentPattern[] {
  const builtin: AgentPattern[] = [
    { regex: /claude\s*$/, model: "claude" },
    { regex: /(?:^|\/)codex(?:\s+(?!app-server)|$)/, model: "codex" },
    { regex: /openclaw(?:\s+tui)?(?:\s|$)/, model: "openclaw" },
    { regex: /(?:^|\/)gemini(?:\s|$)/, model: "gemini" },
  ];

  try {
    const raw = readFileSync(join(HOME, ".hive", "agents.json"), "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return builtin;
    const custom = parsed
      .filter((entry: Record<string, unknown>) => entry.id && entry.processPattern)
      .map((entry: Record<string, unknown>) => ({
        regex: new RegExp(String(entry.processPattern)),
        model: String(entry.id),
      }));
    return [...builtin, ...custom];
  } catch {
    return builtin;
  }
}

function normalizeTty(tty: string): string {
  return tty.replace(/^\/dev\//, "");
}

function parsePsLine(line: string): {
  pid: number;
  cpuPercent: number;
  startedAt: number;
  tty: string;
  command: string;
} | null {
  const match = line.match(/^\s*(\d+)\s+([\d.]+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\S+)\s+(.+)$/);
  if (!match) return null;

  return {
    pid: parseInt(match[1], 10),
    cpuPercent: parseFloat(match[2]) || 0,
    startedAt: new Date(match[3]).getTime(),
    tty: match[4],
    command: match[5],
  };
}

function collectProcessFiles(pid: number): string[] {
  const results: string[] = [];
  const fdDir = `/proc/${pid}/fd`;
  try {
    for (const entry of readdirSync(fdDir)) {
      try {
        const target = readlinkSync(join(fdDir, entry));
        if (target && target.startsWith("/")) results.push(target);
      } catch {
        // Skip transient FDs.
      }
    }
  } catch {
    // /proc may be gone if the process exited.
  }
  return results;
}

function extractSessionInfo(
  model: string,
  startedAt: number,
  cwd: string,
  tty: string,
  files: string[],
): { sessionIds: string[]; jsonlFile: string | null } {
  const sessionIds: string[] = [];
  let jsonlFile: string | null = null;

  for (const file of files) {
    const taskMatch = file.match(/\/.claude\/(?:tasks|projects\/[^/]+)\/([0-9a-f-]{36})/);
    if (taskMatch && !sessionIds.includes(taskMatch[1])) {
      sessionIds.push(taskMatch[1]);
    }

    if (!jsonlFile && /\/.claude\/projects\/[^/]+\/[0-9a-f-]{36}\.jsonl$/.test(file)) {
      jsonlFile = file;
    }
    if (!jsonlFile && /\/.codex\/sessions\/.*\.jsonl$/.test(file)) {
      jsonlFile = file;
    }
    if (!jsonlFile && /\/.gemini\/.*\.jsonl$/.test(file)) {
      jsonlFile = file;
    }
  }

  if (jsonlFile) {
    return { sessionIds, jsonlFile };
  }

  if (model === "claude") {
    jsonlFile = findClaudeSessionFile(sessionIds, cwd);
  } else if (model === "codex") {
    jsonlFile = findRecentJsonl(join(HOME, ".codex", "sessions"), startedAt, 3);
  } else if (model === "gemini") {
    jsonlFile = findRecentJsonl(join(HOME, ".gemini"), startedAt, 3);
  } else {
    jsonlFile = findCustomSessionFile(model, startedAt);
  }

  if (!jsonlFile) {
    const marker = findSessionFromMarker(tty, cwd);
    if (marker) jsonlFile = marker;
  }

  return { sessionIds, jsonlFile };
}

function findClaudeSessionFile(sessionIds: string[], cwd: string): string | null {
  const projectsDir = join(HOME, ".claude", "projects");
  let bestFile: string | null = null;
  let bestMtime = 0;

  try {
    if (sessionIds.length > 0) {
      for (const projectDir of readdirSync(projectsDir)) {
        const fullDir = join(projectsDir, projectDir);
        for (const sessionId of sessionIds) {
          const candidate = join(fullDir, `${sessionId}.jsonl`);
          try {
            const stat = statSync(candidate);
            if (stat.mtimeMs > bestMtime) {
              bestMtime = stat.mtimeMs;
              bestFile = candidate;
            }
          } catch {
            // Ignore missing files.
          }
        }
      }
    }

    if (!bestFile && cwd) {
      const encoded = cwd.replace(/\//g, "-");
      const candidateDir = join(projectsDir, encoded);
      for (const file of readdirSync(candidateDir)) {
        if (!file.endsWith(".jsonl")) continue;
        const candidate = join(candidateDir, file);
        try {
          const stat = statSync(candidate);
          if (stat.mtimeMs > bestMtime) {
            bestMtime = stat.mtimeMs;
            bestFile = candidate;
          }
        } catch {
          // Ignore transient files.
        }
      }
    }
  } catch {
    // Session directory may not exist yet.
  }

  return bestFile;
}

function findRecentJsonl(root: string, startedAt: number, maxDepth: number): string | null {
  let birthtimeMatch: string | null = null;
  let birthtimeBest = Number.POSITIVE_INFINITY;
  let mtimeMatch: string | null = null;
  let bestMtime = 0;

  const scan = (dir: string, depth: number) => {
    if (depth > maxDepth) return;
    for (const entry of readdirSync(dir)) {
      const fullPath = join(dir, entry);
      try {
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          scan(fullPath, depth + 1);
          continue;
        }
        if (!entry.endsWith(".jsonl")) continue;

        const birthtimeDiff = Math.abs(stat.birthtimeMs - startedAt);
        if (birthtimeDiff < 120_000 && birthtimeDiff < birthtimeBest) {
          birthtimeBest = birthtimeDiff;
          birthtimeMatch = fullPath;
        }
        if (stat.mtimeMs > bestMtime) {
          bestMtime = stat.mtimeMs;
          mtimeMatch = fullPath;
        }
      } catch {
        // Skip unreadable entries.
      }
    }
  };

  try {
    scan(root, 0);
  } catch {
    return null;
  }

  return birthtimeMatch || mtimeMatch;
}

function findCustomSessionFile(model: string, startedAt: number): string | null {
  try {
    const raw = readFileSync(join(HOME, ".hive", "agents.json"), "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const agent = parsed.find((entry: Record<string, unknown>) => entry.id === model);
    const sessionDir = typeof agent?.sessionDir === "string" ? String(agent.sessionDir).replace(/^~/, HOME) : null;
    if (!sessionDir) return null;
    return findRecentJsonl(sessionDir, startedAt, 3);
  } catch {
    return null;
  }
}

function findSessionFromMarker(tty: string, cwd: string): string | null {
  const markerPath = join(HOME, ".hive", "sessions", normalizeTty(tty));
  if (!existsSync(markerPath)) return findClaudeSessionFile([], cwd);

  try {
    const sessionId = readFileSync(markerPath, "utf-8").trim();
    if (!sessionId) return null;
    const projectsDir = join(HOME, ".claude", "projects");
    for (const dir of readdirSync(projectsDir)) {
      const candidate = join(projectsDir, dir, `${sessionId}.jsonl`);
      if (existsSync(candidate)) return candidate;
    }
    return null;
  } catch {
    return null;
  }
}

export class LinuxProcessDiscoverer implements ProcessDiscoverer {
  private readonly patterns = loadAgentPatterns();

  findAgentProcesses(): DiscoveredProcess[] {
    try {
      const raw = execFileSync("ps", ["-eo", "pid,pcpu,lstart,tty,args"], {
        encoding: "utf-8",
        timeout: 5000,
      }).trim();
      if (!raw) return [];

      const results: DiscoveredProcess[] = [];
      const seenTtys = new Set<string>();

      for (const line of raw.split("\n").slice(1)) {
        const parsed = parsePsLine(line);
        if (!parsed) continue;
        if (parsed.pid === process.pid) continue;
        if (parsed.tty === "?" || parsed.tty === "??") continue;
        if (/\bnode\s+/.test(parsed.command) && !parsed.command.endsWith("claude") && !/(?:^|\/)gemini(?:\s|$)/.test(parsed.command)) {
          continue;
        }

        const matched = this.patterns.find((pattern) => pattern.regex.test(parsed.command));
        if (!matched) continue;

        const tty = normalizeTty(parsed.tty);
        if (!tty || seenTtys.has(tty)) continue;

        let cwd: string;
        try {
          cwd = realpathSync(`/proc/${parsed.pid}/cwd`);
        } catch {
          continue;
        }

        const files = collectProcessFiles(parsed.pid);
        const sessionInfo = extractSessionInfo(matched.model, parsed.startedAt, cwd, tty, files);

        results.push({
          pid: parsed.pid,
          cpuPercent: parsed.cpuPercent,
          startedAt: parsed.startedAt,
          tty,
          cwd,
          model: matched.model,
          sessionIds: sessionInfo.sessionIds,
          jsonlFile: sessionInfo.jsonlFile,
        });
        seenTtys.add(tty);
      }

      return results;
    } catch {
      return [];
    }
  }

  getCpu(pid: number): number {
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

  getPtyOffset(pid: number): number | null {
    const fdInfoPath = `/proc/${pid}/fdinfo/1`;
    try {
      const raw = readFileSync(fdInfoPath, "utf-8");
      const match = raw.match(/^pos:\s*(\d+)/m);
      return match ? parseInt(match[1], 10) : null;
    } catch {
      return null;
    }
  }
}
