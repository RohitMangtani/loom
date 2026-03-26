import type { MachineCapabilities } from "./types.js";
import { scanLocalProjects } from "./project-discovery.js";
import { homedir } from "os";

const HOME = process.env.HOME || process.env.USERPROFILE || homedir();

/**
 * SwarmController: owns multi-machine spawn/kill/exec/repair routing.
 *
 * ws-server registers handler callbacks during setup. API routes and
 * task dispatch call through these to reach local or satellite machines.
 *
 * Extracted from TelemetryReceiver to isolate swarm routing from
 * worker state management.
 */

export interface SwarmProjectEntry {
  name: string;
  path: string;
  machines?: Record<string, string>;
}

export interface SwarmSpawnRequest {
  project?: string;
  model?: string;
  task?: string;
  targetQuadrant?: number;
  machine?: string;
  fromMachine?: string;
}

export interface SwarmExecRequest {
  command: string;
  cwd?: string;
  timeoutMs?: number;
  machine?: string;
  fromMachine?: string;
}

export interface SwarmExecResult {
  ok: boolean;
  machine: string;
  command: string;
  cwd: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  error?: string;
}

type SwarmResult = { ok: boolean; error?: string; [key: string]: unknown };

export class SwarmController {
  private projectsGetter: (() => { projects: SwarmProjectEntry[] }) | null = null;
  private capabilitiesGetter: (() => Record<string, MachineCapabilities>) | null = null;
  private spawnHandler: ((request: SwarmSpawnRequest) => SwarmResult) | null = null;
  private killHandler: ((workerId: string, fromMachine?: string) => SwarmResult) | null = null;
  private satelliteMaintenanceHandler: ((machineId: string, action?: string, fromMachine?: string) => SwarmResult) | null = null;
  private execHandler: ((request: SwarmExecRequest) => Promise<SwarmExecResult>) | null = null;

  /** Register swarm control handlers (called by ws-server during setup). */
  setControllers(
    projectsGetter: () => { projects: SwarmProjectEntry[] },
    capabilitiesGetter: () => Record<string, MachineCapabilities>,
    spawnHandler: (request: SwarmSpawnRequest) => SwarmResult,
    killHandler: (workerId: string, fromMachine?: string) => SwarmResult,
    satelliteMaintenanceHandler?: (machineId: string, action?: string, fromMachine?: string) => SwarmResult,
    execHandler?: (request: SwarmExecRequest) => Promise<SwarmExecResult>,
  ): void {
    this.projectsGetter = projectsGetter;
    this.capabilitiesGetter = capabilitiesGetter;
    this.spawnHandler = spawnHandler;
    this.killHandler = killHandler;
    this.satelliteMaintenanceHandler = satelliteMaintenanceHandler || null;
    this.execHandler = execHandler || null;
  }

  getSwarmProjects(): { projects: SwarmProjectEntry[] } {
    if (this.projectsGetter) return this.projectsGetter();
    const projects = Object.entries(scanLocalProjects(HOME)).map(([name, path]) => ({
      name,
      path,
      machines: { local: path },
    }));
    return { projects };
  }

  getSwarmCapabilities(): Record<string, MachineCapabilities> {
    if (this.capabilitiesGetter) return this.capabilitiesGetter();
    return {
      local: {
        node: true,
        projects: scanLocalProjects(HOME),
      },
    };
  }

  spawnViaSwarm(request: SwarmSpawnRequest): SwarmResult {
    if (!this.spawnHandler) return { ok: false, error: "Spawn control not available" };
    return this.spawnHandler(request);
  }

  killViaSwarm(workerId: string, fromMachine?: string): SwarmResult {
    if (!this.killHandler) return { ok: false, error: "Kill control not available" };
    return this.killHandler(workerId, fromMachine);
  }

  maintainSatelliteViaSwarm(machineId: string, action?: string, fromMachine?: string): SwarmResult {
    if (!this.satelliteMaintenanceHandler) return { ok: false, error: "Satellite maintenance control not available" };
    return this.satelliteMaintenanceHandler(machineId, action, fromMachine);
  }

  async execViaSwarm(request: SwarmExecRequest): Promise<SwarmExecResult> {
    if (!this.execHandler) {
      return {
        ok: false,
        machine: request.machine || request.fromMachine || "local",
        command: request.command,
        cwd: request.cwd || HOME,
        stdout: "",
        stderr: "",
        exitCode: null,
        timedOut: false,
        durationMs: 0,
        error: "Exec control not available",
      };
    }
    return this.execHandler(request);
  }
}
