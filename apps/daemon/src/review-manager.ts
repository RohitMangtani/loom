import { execFileSync } from "child_process";
import { statSync } from "fs";
import { ReviewStore } from "./review-store.js";
import type { ReviewItem } from "./review-store.js";
import type { WorkerState } from "./types.js";
import type { RevertHistoryEntry } from "@hive/types";

export type { ReviewItem } from "./review-store.js";

/**
 * ReviewManager: owns the ReviewStore, auto-detection of reviewable actions
 * (git push, gh pr create, vercel deploy), dedup, git resolution, and
 * listener notification.
 *
 * Extracted from TelemetryReceiver to reduce god-class coupling.
 */

/** Narrow dependency interface  --  avoids circular dependency on TelemetryReceiver. */
export interface ReviewManagerDeps {
  getQuadrant(workerId: string): number | undefined;
  getRecentArtifacts(workerId: string, limit: number): Array<{ path: string; action: string; ts: number }>;
  onSatelliteUpdate?: () => void;
  recordRevert?: (payload: Omit<RevertHistoryEntry, "id" | "timestamp">) => void;
}

export class ReviewManager {
  private store: ReviewStore;
  private listeners: Array<(review: ReviewItem) => void> = [];
  private lastReviewByWorker = new Map<string, { type: string; ts: number }>();
  private deps: ReviewManagerDeps;
  private revertHook?: ReviewManagerDeps["recordRevert"];
  private commitCooldowns = new Map<string, number>();

  constructor(deps: ReviewManagerDeps) {
    this.store = new ReviewStore();
    this.deps = deps;
  }

  // --- Public API (called by api-routes, ws-server via TelemetryReceiver facade) ---

  addReview(
    summary: string,
    workerId: string,
    projectName: string,
    opts?: { url?: string; type?: ReviewItem["type"]; quadrant?: number; artifacts?: Array<{ path: string; action: string }> },
  ): ReviewItem {
    const quadrant = opts?.quadrant ?? this.deps.getQuadrant(workerId);
    const review = this.store.add(summary, workerId, projectName, { ...opts, quadrant });
    for (const listener of this.listeners) {
      listener(review);
    }
    return review;
  }

  getReviews(): ReviewItem[] {
    return this.store.getAll();
  }

  getUnseenReviews(): ReviewItem[] {
    return this.store.getUnseen();
  }

  markReviewSeen(id: string): boolean {
    return this.store.markSeen(id);
  }

  markAllReviewsSeen(): number {
    return this.store.markAllSeen();
  }

  dismissReview(id: string): boolean {
    return this.store.dismiss(id);
  }

  clearAllReviews(): number {
    return this.store.clearAll();
  }

  onReviewAdded(listener: (review: ReviewItem) => void): void {
    this.listeners.push(listener);
  }

  /** Wire the satellite update callback (called after setSatelliteRelay). */
  setSatelliteUpdateFn(fn: (() => void) | undefined): void {
    this.deps.onSatelliteUpdate = fn;
  }

  setRevertHook(hook?: ReviewManagerDeps["recordRevert"]): void {
    this.revertHook = hook;
  }

  /** Called from tick() to expire old reviews. */
  expire(): void {
    this.store.expire();
  }

  // --- Auto-detection (called from hook processing on PreToolUse for Bash) ---

  /**
   * Auto-detect reviewable actions from Bash tool_input.
   * Detects: git push, git commit+push, gh pr create, vercel deploy.
   */
  autoDetectReview(
    workerId: string,
    worker: WorkerState,
    toolInput: Record<string, unknown>,
  ): void {
    const command = (toolInput.command || toolInput.description || "") as string;
    if (!command) return;

    const cmdLower = command.toLowerCase();

    // Resolve git context from the actual command cwd, not the worker's launch directory.
    const effectiveCwd = this.extractCommandCwd(command, worker.project);
    const effectiveWorker = effectiveCwd !== worker.project
      ? { ...worker, project: effectiveCwd }
      : worker;

    const gitUrl = this.resolveGitUrl(effectiveWorker);
    const branch = this.resolveGitBranch(effectiveWorker);
    const repoName = this.resolveGitRepoName(effectiveWorker);
    const artifacts = this.getReviewArtifacts(workerId);

    // npm run build + git push in same command chain (check before individual patterns)
    if (/\bgit\s+commit\b/.test(cmdLower) && /\bgit\s+push\b/.test(cmdLower)) {
      if (this.isDuplicateReview(workerId, "push")) return;
      const summary = this.buildReviewSummary("committed and pushed", worker, repoName, branch);
      this.addReview(summary, workerId, repoName, { type: "push", url: gitUrl, artifacts });
      this.recordRevertCandidate(effectiveWorker, summary, command);
      return;
    }

    // git push
    if (/\bgit\s+push\b/.test(cmdLower)) {
      if (this.isDuplicateReview(workerId, "push")) return;
      const summary = this.buildReviewSummary("pushed", worker, repoName, branch);
      console.log(`[review] Auto-detected push by ${worker.tty || workerId} in ${repoName}`);
      this.addReview(summary, workerId, repoName, { type: "push", url: gitUrl, artifacts });
      // Auto-update satellites when the hive repo itself is pushed
      if (repoName === "hive" && this.deps.onSatelliteUpdate) {
        console.log(`[satellite-update] Hive repo pushed  --  triggering satellite updates`);
        this.deps.onSatelliteUpdate();
      }
      this.recordRevertCandidate(effectiveWorker, summary, command);
      return;
    }

    // gh pr create
    if (/\bgh\s+pr\s+create\b/.test(cmdLower)) {
      if (this.isDuplicateReview(workerId, "pr")) return;
      const summary = this.buildReviewSummary("created PR in", worker, repoName, branch);
      console.log(`[review] Auto-detected PR by ${worker.tty || workerId} in ${repoName}`);
      this.addReview(summary, workerId, repoName, { type: "pr", url: gitUrl ? `${gitUrl}/pulls` : undefined, artifacts });
      return;
    }

    // vercel deploy (or npx vercel)
    if (/\bvercel\b/.test(cmdLower) && (/\bdeploy\b/.test(cmdLower) || /\bnpx\s+vercel\b/.test(cmdLower) || /^vercel(\s|$)/.test(cmdLower.trim()))) {
      if (this.isDuplicateReview(workerId, "deploy")) return;
      const summary = this.buildReviewSummary("deployed", worker, repoName, branch);
      this.addReview(summary, workerId, repoName, { type: "deploy", artifacts });
      return;
    }
  }

  // --- Private helpers ---

  private buildReviewSummary(action: string, worker: WorkerState, repoName: string, branch?: string): string {
    const q = this.deps.getQuadrant(worker.id);
    const qLabel = q ? `Q${q}` : (worker.tty || "agent");
    const branchSuffix = branch ? ` (${branch})` : "";
    return `${qLabel} ${action} ${repoName}${branchSuffix}`;
  }

  private getReviewArtifacts(workerId: string): Array<{ path: string; action: string }> | undefined {
    const arts = this.deps.getRecentArtifacts(workerId, 5);
    if (arts.length === 0) return undefined;
    return arts.map(a => ({
      path: a.path.split("/").slice(-2).join("/"),
      action: a.action,
    }));
  }

  private isDuplicateReview(workerId: string, type: string): boolean {
    const last = this.lastReviewByWorker.get(workerId);
    if (last && last.type === type && Date.now() - last.ts < 30_000) return true;
    this.lastReviewByWorker.set(workerId, { type, ts: Date.now() });
    return false;
  }

  /**
   * Extract the effective working directory from a bash command.
   * Handles patterns like `cd /path/to/repo && git push`.
   */
  private extractCommandCwd(command: string, fallback: string): string {
    const cdMatch = command.match(/\bcd\s+["']?([^"'&;|\n]+?)["']?\s*(?:&&|;)/);
    if (cdMatch) {
      let dir = cdMatch[1].trim();
      if (dir.startsWith("~/") || dir === "~") {
        const home = process.env.HOME || `/Users/${process.env.USER}`;
        dir = dir.replace(/^~/, home);
      }
      try {
        if (statSync(dir).isDirectory()) return dir;
      } catch { /* path doesn't exist, use fallback */ }
    }
    return fallback;
  }

  private recordRevertCandidate(worker: WorkerState, summary: string, context?: string): void {
    if (!this.revertHook) return;
    const commit = this.getCommitHash(worker);
    if (!commit) return;
    const key = `${worker.project}:${commit}`;
    const now = Date.now();
    const last = this.commitCooldowns.get(key);
    if (last && now - last < 90_000) return;
    this.commitCooldowns.set(key, now);
    const branch = this.resolveGitBranch(worker);
    const projectName = worker.projectName && worker.projectName !== "unknown"
      ? worker.projectName
      : this.resolveGitRepoName(worker);
    const contextPieces: string[] = [];
    if (branch) contextPieces.push(`branch ${branch}`);
    if (context) {
      const cleaned = context.replace(/\s+/g, " ").trim();
      if (cleaned) contextPieces.push(cleaned);
    }
    const payload: Omit<RevertHistoryEntry, "id" | "timestamp"> = {
      label: summary,
      description: this.getCommitMessage(worker) || summary,
      commit,
      projectPath: worker.project,
      projectName,
      branch,
      workerId: worker.id,
      quadrant: worker.quadrant,
      context: contextPieces.join(" · ") || summary,
      safeguards: ["confirm-hash"],
    };
    this.revertHook(payload);
  }

  private getCommitHash(worker: WorkerState): string | undefined {
    try {
      return execFileSync("/usr/bin/git", ["rev-parse", "--short=8", "HEAD"], {
        cwd: worker.project,
        encoding: "utf-8",
        timeout: 3000,
      }).trim() || undefined;
    } catch {
      return undefined;
    }
  }

  private getCommitMessage(worker: WorkerState): string | undefined {
    try {
      return execFileSync("/usr/bin/git", ["log", "-1", "--pretty=%s"], {
        cwd: worker.project,
        encoding: "utf-8",
        timeout: 3000,
      }).trim() || undefined;
    } catch {
      return undefined;
    }
  }

  private resolveGitBranch(worker: WorkerState): string | undefined {
    try {
      return execFileSync("/usr/bin/git", ["symbolic-ref", "--short", "HEAD"], {
        cwd: worker.project,
        encoding: "utf-8",
        timeout: 3000,
      }).trim() || undefined;
    } catch {
      return undefined;
    }
  }

  private resolveGitUrl(worker: WorkerState): string | undefined {
    try {
      const remote = execFileSync("/usr/bin/git", ["remote", "get-url", "origin"], {
        cwd: worker.project,
        encoding: "utf-8",
        timeout: 3000,
      }).trim();
      if (remote.startsWith("git@github.com:")) {
        return "https://github.com/" + remote.slice(15).replace(/\.git$/, "");
      }
      if (remote.includes("github.com")) {
        return remote.replace(/\.git$/, "");
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  private resolveGitRepoName(worker: WorkerState): string {
    try {
      const root = execFileSync("/usr/bin/git", ["rev-parse", "--show-toplevel"], {
        cwd: worker.project,
        encoding: "utf-8",
        timeout: 3000,
      }).trim();
      const name = root.split("/").pop();
      if (name && name !== "unknown") return name;
    } catch { /* not a git repo at this cwd */ }
    const segments = worker.project.replace(/\/+$/, "").split("/").filter(Boolean);
    const last = segments[segments.length - 1];
    if (last && last !== "unknown" && last !== process.env.USER) return last;
    return worker.projectName !== "unknown" ? worker.projectName : "agent";
  }
}
