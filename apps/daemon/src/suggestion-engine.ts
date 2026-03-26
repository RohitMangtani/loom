import { readFileSync, existsSync, appendFileSync, mkdirSync } from "fs";
import { join, basename } from "path";
import type { Suggestion, WorkerState } from "./types.js";
import { homedir } from "os";

const HOME = process.env.HOME || process.env.USERPROFILE || homedir();
const KEY_FILE = join(HOME, ".hive", "anthropic-key");
const FEEDBACK_FILE = join(HOME, ".hive", "suggestion-feedback.jsonl");
const MODEL = "claude-haiku-4-5-20251001";
const API_URL = "https://api.anthropic.com/v1/messages";
const CACHE_TTL = 5 * 60 * 1000; // 5 min  --  don't re-generate if agent stays idle
const PATTERN_SUMMARY_INTERVAL = 60 * 1000; // re-summarize patterns every 60s

interface CachedSuggestions {
  suggestions: Suggestion[];
  generatedAt: number;
  lastAction: string;
}

interface FeedbackEntry {
  ts: number;
  label: string;
  outcome: "apply" | "skip";
  project?: string;
}

export class SuggestionEngine {
  private cache = new Map<string, CachedSuggestions>();
  private inflight = new Set<string>();
  private apiKey: string | null = null;

  // Phase 4: feedback tracking
  private feedback: FeedbackEntry[] = [];
  private patternSummary = "";
  private patternSummaryAt = 0;

  constructor() {
    this.loadKey();
    this.loadFeedback();
  }

  private loadKey(): void {
    if (process.env.ANTHROPIC_API_KEY) {
      this.apiKey = process.env.ANTHROPIC_API_KEY;
      console.log("[suggestions] API key loaded from ANTHROPIC_API_KEY env");
      return;
    }
    try {
      if (existsSync(KEY_FILE)) {
        this.apiKey = readFileSync(KEY_FILE, "utf-8").trim();
        console.log("[suggestions] API key loaded from ~/.hive/anthropic-key");
        return;
      }
    } catch { /* ignore */ }
    console.log("[suggestions] No API key found  --  using template suggestions only");
  }

  private loadFeedback(): void {
    try {
      if (existsSync(FEEDBACK_FILE)) {
        const lines = readFileSync(FEEDBACK_FILE, "utf-8").split("\n").filter(Boolean);
        for (const line of lines) {
          try {
            const entry = JSON.parse(line) as FeedbackEntry;
            this.feedback.push(entry);
          } catch { /* skip malformed lines */ }
        }
        console.log(`[suggestions] Loaded ${this.feedback.length} feedback entries`);
      }
    } catch { /* ignore */ }
  }

  isEnabled(): boolean {
    return this.apiKey !== null;
  }

  generate(
    worker: WorkerState,
    artifacts: Array<{ path: string; action: string; ts: number }>,
    onReady: (suggestions: Suggestion[]) => void
  ): void {
    if (!this.apiKey) return;

    const cached = this.cache.get(worker.id);
    if (cached && cached.lastAction === worker.lastAction && Date.now() - cached.generatedAt < CACHE_TTL) {
      onReady(cached.suggestions);
      return;
    }

    if (this.inflight.has(worker.id)) return;
    this.inflight.add(worker.id);

    this.callApi(worker, artifacts)
      .then((suggestions) => {
        this.cache.set(worker.id, {
          suggestions,
          generatedAt: Date.now(),
          lastAction: worker.lastAction,
        });
        onReady(suggestions);
      })
      .catch((err) => {
        console.log(`[suggestions] API call failed for ${worker.tty || worker.id}: ${err instanceof Error ? err.message : err}`);
      })
      .finally(() => {
        this.inflight.delete(worker.id);
      });
  }

  clear(workerId: string): void {
    this.cache.delete(workerId);
  }

  // --- Phase 4: Feedback tracking ---

  /** Record that a suggestion was applied (user tapped it) */
  recordApply(label: string, shownLabels: string[], project?: string): void {
    // Record the applied one
    this.persistFeedback({ ts: Date.now(), label, outcome: "apply", project });
    // Record skips for the ones not tapped
    for (const shown of shownLabels) {
      if (shown !== label) {
        this.persistFeedback({ ts: Date.now(), label: shown, outcome: "skip", project });
      }
    }
  }

  /** Record that all shown suggestions were skipped (agent got a manual message instead) */
  recordSkipAll(shownLabels: string[], project?: string): void {
    for (const label of shownLabels) {
      this.persistFeedback({ ts: Date.now(), label, outcome: "skip", project });
    }
  }

  private persistFeedback(entry: FeedbackEntry): void {
    this.feedback.push(entry);
    // Keep last 500 entries in memory
    if (this.feedback.length > 500) {
      this.feedback = this.feedback.slice(-500);
    }
    try {
      const dir = join(HOME, ".hive");
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      appendFileSync(FEEDBACK_FILE, JSON.stringify(entry) + "\n");
    } catch { /* non-critical */ }
  }

  /** Compute a pattern summary string for the prompt */
  private getPatternSummary(): string {
    if (Date.now() - this.patternSummaryAt < PATTERN_SUMMARY_INTERVAL && this.patternSummary) {
      return this.patternSummary;
    }

    if (this.feedback.length < 5) {
      this.patternSummary = "";
      this.patternSummaryAt = Date.now();
      return "";
    }

    // Count applies and skips per label keyword
    const counts = new Map<string, { apply: number; skip: number }>();
    // Use last 200 entries for pattern detection
    const recent = this.feedback.slice(-200);

    for (const entry of recent) {
      // Normalize label to a keyword (lowercase, first two words)
      const key = entry.label.toLowerCase().split(/\s+/).slice(0, 2).join(" ");
      const existing = counts.get(key) || { apply: 0, skip: 0 };
      if (entry.outcome === "apply") existing.apply++;
      else existing.skip++;
      counts.set(key, existing);
    }

    // Find strong patterns (>= 3 interactions, strong lean)
    const patterns: string[] = [];
    for (const [keyword, { apply, skip }] of counts) {
      const total = apply + skip;
      if (total < 3) continue;
      const applyRate = apply / total;
      if (applyRate >= 0.7) {
        patterns.push(`User frequently approves "${keyword}" suggestions (${Math.round(applyRate * 100)}% apply rate)`);
      } else if (applyRate <= 0.3) {
        patterns.push(`User rarely uses "${keyword}" suggestions (${Math.round(applyRate * 100)}% apply rate)  --  deprioritize`);
      }
    }

    this.patternSummary = patterns.length > 0
      ? `- User patterns from past interactions:\n${patterns.slice(0, 5).map(p => `  ${p}`).join("\n")}`
      : "";
    this.patternSummaryAt = Date.now();
    return this.patternSummary;
  }

  // --- API call ---

  private async callApi(
    worker: WorkerState,
    artifacts: Array<{ path: string; action: string; ts: number }>
  ): Promise<Suggestion[]> {
    const recentArtifacts = artifacts
      .filter((a) => Date.now() - a.ts < 30 * 60 * 1000)
      .slice(-10)
      .map((a) => `${basename(a.path)} (${a.action})`)
      .join(", ");

    let learnings = "";
    const learningPath = join(worker.project, ".claude", "hive-learnings.md");
    try {
      if (existsSync(learningPath)) {
        const lines = readFileSync(learningPath, "utf-8").split("\n");
        learnings = lines.slice(-20).join("\n");
      }
    } catch { /* ignore */ }

    const patterns = this.getPatternSummary();

    const prompt = `You observe an AI coding agent that just went idle. Suggest 2-4 specific next actions.

Context:
- Project: ${worker.projectName}
- Last action: ${worker.lastAction}
- Files changed recently: ${recentArtifacts || "none"}
- Original task: ${worker.task || "none"}
${learnings ? `- Project learnings:\n${learnings}` : ""}
${patterns}

Return a JSON array. Each item: {"label": "2-4 word button text", "message": "1-2 sentence prompt to send to the agent", "reason": "why this makes sense"}

Rules:
- Be specific to this project, not generic
- Messages should be actionable instructions the agent can execute immediately
- Label must be short enough for a small button (max 4 words)
${patterns ? "- Weight suggestions toward patterns the user prefers, avoid ones they consistently skip" : ""}
- Return ONLY the JSON array, no markdown fences`;

    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey!,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 512,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`API ${res.status}: ${body.slice(0, 200)}`);
    }

    const data = (await res.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };

    const text = data.content?.find((b) => b.type === "text")?.text || "";
    const cleaned = text.replace(/^```json?\s*/, "").replace(/\s*```$/, "").trim();
    const parsed = JSON.parse(cleaned) as Array<{
      label?: string;
      message?: string;
      reason?: string;
    }>;

    return parsed
      .filter((s) => s.label && s.message)
      .slice(0, 4)
      .map((s) => ({
        label: s.label!.slice(0, 30),
        message: s.message!,
        reason: s.reason,
      }));
  }
}
