export interface TerminalIO {
  sendText(tty: string, text: string): Promise<{ ok: boolean; error?: string }>;
  sendKeystroke(tty: string, key: "enter" | "down" | "up"): Promise<{ ok: boolean; error?: string }>;
  sendSelection(tty: string, optionIndex: number): Promise<{ ok: boolean; error?: string }>;
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

export interface WindowManager {
  spawnTerminal(project: string, model: string, quadrant?: number): Promise<string>;
  closeTerminal(tty: string): Promise<void>;
  arrangeWindows(slots: Array<{ tty: string; quadrant: number; projectName: string; model: string }>): void;
}
