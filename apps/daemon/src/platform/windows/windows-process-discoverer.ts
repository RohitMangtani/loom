import { execFileSync } from "child_process";
import { readFileSync, readdirSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { DiscoveredProcess, ProcessDiscoverer } from "../interfaces.js";

const HOME = process.env.USERPROFILE || process.env.HOME || homedir();

interface AgentPattern {
  regex: RegExp;
  model: string;
}

function loadAgentPatterns(): AgentPattern[] {
  const builtin: AgentPattern[] = [
    // Match: "claude", "claude.exe", and npm paths like "@anthropic-ai\claude-code\cli.js"
    { regex: /(?:claude(?:\.exe)?(?:\s|$)|claude-code[/\\](?:cli|dist))/, model: "claude" },
    // Match: "codex", "codex.exe", and npm paths like "@openai\codex\..."
    { regex: /(?:(?:^|[/\\])codex(?:\.exe)?(?:\s+(?!app-server)|$)|@openai[/\\]codex[/\\])/, model: "codex" },
    { regex: /openclaw(?:\.exe)?(?:\s+tui)?(?:\s|$)/, model: "openclaw" },
    { regex: /(?:^|[/\\])gemini(?:\.exe)?(?:\s|$)/, model: "gemini" },
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

function findClaudeSessionFile(cwd: string): string | null {
  const projectsDir = join(HOME, ".claude", "projects");
  let bestFile: string | null = null;
  let bestMtime = 0;

  try {
    // Try CWD-based lookup — handle both forward and backslash separators
    const encoded = cwd.replace(/[/\\]/g, "-").replace(/^-/, "");
    for (const variant of [encoded, `-${encoded}`]) {
      const candidateDir = join(projectsDir, variant);
      try {
        for (const file of readdirSync(candidateDir)) {
          if (!file.endsWith(".jsonl")) continue;
          const candidate = join(candidateDir, file);
          try {
            const stat = statSync(candidate);
            if (stat.mtimeMs > bestMtime) {
              bestMtime = stat.mtimeMs;
              bestFile = candidate;
            }
          } catch { /* skip */ }
        }
      } catch { /* dir doesn't exist */ }
    }

    // Fallback: scan all project dirs
    if (!bestFile) {
      for (const dir of readdirSync(projectsDir)) {
        const fullDir = join(projectsDir, dir);
        try {
          for (const file of readdirSync(fullDir)) {
            if (!file.endsWith(".jsonl")) continue;
            const candidate = join(fullDir, file);
            try {
              const stat = statSync(candidate);
              if (stat.mtimeMs > bestMtime) {
                bestMtime = stat.mtimeMs;
                bestFile = candidate;
              }
            } catch { /* skip */ }
          }
        } catch { /* skip */ }
      }
    }
  } catch { /* projects dir doesn't exist */ }

  return bestFile;
}

function findRecentJsonl(root: string, startedAt: number, maxDepth: number): string | null {
  let mtimeMatch: string | null = null;
  let bestMtime = 0;

  const scan = (dir: string, depth: number) => {
    if (depth > maxDepth) return;
    try {
      for (const entry of readdirSync(dir)) {
        const fullPath = join(dir, entry);
        try {
          const stat = statSync(fullPath);
          if (stat.isDirectory()) {
            scan(fullPath, depth + 1);
            continue;
          }
          if (!entry.endsWith(".jsonl")) continue;
          if (stat.mtimeMs > bestMtime) {
            bestMtime = stat.mtimeMs;
            mtimeMatch = fullPath;
          }
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  };

  scan(root, 0);
  return mtimeMatch;
}

function findSessionFile(model: string, startedAt: number, cwd: string): string | null {
  if (model === "claude") return findClaudeSessionFile(cwd);
  if (model === "codex") return findRecentJsonl(join(HOME, ".codex", "sessions"), startedAt, 3);
  if (model === "gemini") return findRecentJsonl(join(HOME, ".gemini"), startedAt, 3);

  // Custom agents
  try {
    const raw = readFileSync(join(HOME, ".hive", "agents.json"), "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const agent = parsed.find((entry: Record<string, unknown>) => entry.id === model);
    const sessionDir = typeof agent?.sessionDir === "string"
      ? String(agent.sessionDir).replace(/^~/, HOME)
      : null;
    if (sessionDir) return findRecentJsonl(sessionDir, startedAt, 3);
  } catch { /* skip */ }

  return null;
}

/**
 * Get the current working directory of a process on Windows.
 * Uses Get-CimInstance CommandLine heuristic and falls back to HOME.
 */
function getProcessCwd(pid: number): string {
  try {
    // Best effort: ask PowerShell for the process's current directory
    // This uses the .NET method which reads the PEB (Process Environment Block)
    const out = execFileSync("powershell", [
      "-NoProfile", "-Command",
      `try { $p = [System.Diagnostics.Process]::GetProcessById(${pid}); $m = $p.MainModule; if ($m) { Split-Path $m.FileName -Parent } } catch {}`,
    ], { encoding: "utf-8", timeout: 3000 }).trim();

    // MainModule.FileName gives us the binary path (e.g. C:\...\node.exe)
    // For agents, the CWD is more useful. Try reading it from the
    // process's command line via WMI.
    const cwdOut = execFileSync("powershell", [
      "-NoProfile", "-Command",
      // wmic can sometimes give us the working directory via the command line
      // but the most reliable Windows method needs native code. Fall back to
      // checking if the command has a -d or --cwd flag, or use HOME.
      `$cmd = (Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue).CommandLine; if ($cmd -match '--?(?:cwd|directory|dir)\\s+[''"]?([^''"\\s]+)') { $Matches[1] } elseif ($cmd -match 'cd\\s+/d\\s+[''"]?([^''"&]+)') { $Matches[1] }`,
    ], { encoding: "utf-8", timeout: 3000 }).trim();

    if (cwdOut && cwdOut.length > 2) return cwdOut;
    return out || HOME;
  } catch {
    return HOME;
  }
}

export class WindowsProcessDiscoverer implements ProcessDiscoverer {
  private readonly patterns = loadAgentPatterns();

  findAgentProcesses(): DiscoveredProcess[] {
    // Prefer PowerShell (Get-CimInstance) — wmic is deprecated on Win11+
    return this.findWithPowerShell();
  }

  private findWithPowerShell(): DiscoveredProcess[] {
    try {
      // Use ConvertTo-Json for reliable parsing (CSV with commas in values is fragile)
      const psCommand = `Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine,CreationDate | ConvertTo-Json -Compress`;
      const raw = execFileSync("powershell", ["-NoProfile", "-Command", psCommand], {
        encoding: "utf-8",
        timeout: 15000,
      }).trim();

      if (!raw) return [];

      let processes: Array<{ ProcessId: number; CommandLine: string | null; CreationDate: string | null }>;
      try {
        const parsed = JSON.parse(raw);
        // PowerShell returns a single object (not array) if there's only one result
        processes = Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        return [];
      }

      const results: DiscoveredProcess[] = [];
      const seenPids = new Set<number>();

      for (const proc of processes) {
        const pid = proc.ProcessId;
        const commandLine = proc.CommandLine || "";

        if (!pid || pid === process.pid || seenPids.has(pid)) continue;
        if (!commandLine) continue;

        // Skip wrapper processes that launch agents but aren't the agent itself.
        // On Windows, "cmd /k claude" creates: cmd.exe -> node.exe ...claude-code\cli.js
        // Both match "claude" in their CommandLine, but we only want the leaf node.
        // The agent is always node.exe (or the bare CLI binary), never a shell.
        if (/^"?(?:[A-Z]:\\.*\\)?(?:cmd|wt|conhost|powershell|pwsh)(?:\.exe)?/i.test(commandLine)) continue;

        const matched = this.patterns.find((p) => p.regex.test(commandLine));
        if (!matched) continue;

        seenPids.add(pid);

        const startedAt = proc.CreationDate ? new Date(proc.CreationDate).getTime() : Date.now();
        const cwd = getProcessCwd(pid);
        const jsonlFile = findSessionFile(matched.model, startedAt, cwd);

        results.push({
          pid,
          cpuPercent: 0,
          startedAt,
          tty: `pid:${pid}`,
          cwd,
          model: matched.model,
          sessionIds: [],
          jsonlFile,
        });
      }

      return results;
    } catch {
      return [];
    }
  }

  getCpu(pid: number): number {
    try {
      const out = execFileSync("powershell", [
        "-NoProfile", "-Command",
        `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).CPU`,
      ], { encoding: "utf-8", timeout: 3000 }).trim();
      return parseFloat(out) || 0;
    } catch {
      return 0;
    }
  }

  getPtyOffset(_pid: number): number | null {
    // No PTY offset concept on Windows
    return null;
  }
}
