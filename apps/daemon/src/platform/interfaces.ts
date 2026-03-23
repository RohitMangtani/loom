export type PlatformSendResult = { ok: boolean; error?: string };

export interface TerminalIO {
  sendText(tty: string, text: string, model?: string): PlatformSendResult;
  sendTextAsync(tty: string, text: string, model?: string): Promise<PlatformSendResult>;
  sendKeystroke(tty: string, key: "enter" | "down" | "up"): PlatformSendResult;
  sendKeystrokeAsync(tty: string, key: "enter" | "down" | "up"): Promise<PlatformSendResult>;
  sendSelection(tty: string, optionIndex: number): PlatformSendResult;
  readContent(tty: string): string | null;
  isSendInFlight(): boolean;
}

export interface DiscoveredProcess {
  pid: number;
  cpuPercent: number;
  startedAt: number;
  tty: string;
  cwd: string;
  model: string;
  sessionIds: string[];
  jsonlFile: string | null;
}

export interface ProcessDiscoverer {
  /** Find running AI agent processes. */
  findAgentProcesses(): DiscoveredProcess[];
  /** Get CPU usage for a PID (0-100). */
  getCpu(pid: number): number;
  /** Get PTY stdout byte offset for output flow detection. */
  getPtyOffset(pid: number): number | null;
}

export interface WindowSlot {
  tty: string;
  quadrant: number;
  projectName: string;
  model: string;
}

export interface WindowManager {
  spawnTerminal(
    project: string,
    model: string,
    quadrant?: number,
    initialMessage?: string,
    currentAgentCount?: number,
  ): { ok: boolean; tty?: string; error?: string };
  closeTerminal(tty: string): { ok: boolean; error?: string };
  arrangeWindows(slots: WindowSlot[], totalAgentCount?: number): void;
  detectQuadrants?(
    ttys: string[],
    callback: (result: Map<string, number>, rawSlots?: Map<string, number>) => void,
  ): void;
  resetArrangement?(): void;
}

export interface LoadedPlatform {
  terminal: TerminalIO;
  discovery: ProcessDiscoverer;
  windows: WindowManager;
}
