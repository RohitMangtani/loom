/**
 * Shared machine capability detection.
 *
 * Used by both the primary daemon and satellite to probe hardware/software
 * and write the result to ~/.hive/machine.json on startup.
 */

import { homedir, platform, arch, cpus, totalmem } from "os";
import { join } from "path";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "fs";
import { execFileSync } from "child_process";
import type { MachineCapabilities } from "@hive/types";

/** Probe this machine for hardware and software capabilities. */
export function detectCapabilities(): MachineCapabilities {
  const caps: MachineCapabilities = {
    platform: platform(),
    arch: arch(),
    cpuCores: cpus().length,
    ramGb: Math.round(totalmem() / (1024 ** 3)),
  };

  // GPU detection (macOS: system_profiler, Linux: nvidia-smi)
  try {
    if (platform() === "darwin") {
      const sp = execFileSync("/usr/sbin/system_profiler", ["SPDisplaysDataType"], { timeout: 5000, encoding: "utf-8" });
      caps.gpu = true;
      const nameMatch = sp.match(/Chipset Model:\s*(.+)/i) || sp.match(/Chip:\s*(.+)/i);
      caps.gpuName = nameMatch?.[1]?.trim() || "Apple GPU";
    } else {
      const nv = execFileSync("nvidia-smi", ["--query-gpu=name", "--format=csv,noheader"], { timeout: 5000, encoding: "utf-8" });
      caps.gpu = true;
      caps.gpuName = nv.trim().split("\n")[0] || "NVIDIA GPU";
      // VRAM detection (NVIDIA only)
      try {
        const vram = execFileSync("nvidia-smi", ["--query-gpu=memory.total", "--format=csv,noheader,nounits"], { timeout: 5000, encoding: "utf-8" });
        const mb = parseInt(vram.trim().split("\n")[0], 10);
        if (mb > 0) caps.gpuVramGb = Math.round(mb / 1024);
      } catch { /* skip */ }
    }
  } catch {
    caps.gpu = false;
  }

  // Disk free space
  try {
    if (platform() === "win32") {
      // Windows: use PowerShell to get free space on the system drive
      const ps = execFileSync("powershell", ["-NoProfile", "-Command",
        "Get-Volume -DriveLetter C -ErrorAction SilentlyContinue | Select-Object -ExpandProperty SizeRemaining",
      ], { timeout: 5000, encoding: "utf-8" }).trim();
      const bytes = parseInt(ps, 10);
      if (bytes > 0) caps.diskFreeGb = Math.round(bytes / (1024 ** 3));
    } else {
      const dfArgs = platform() === "darwin" ? ["-g", homedir()] : ["--block-size=G", homedir()];
      const dfCmd = platform() === "darwin" ? "/bin/df" : "df";
      const df = execFileSync(dfCmd, dfArgs, { timeout: 3000, encoding: "utf-8" });
      const parts = df.split("\n")[1]?.split(/\s+/);
      if (parts?.[3]) caps.diskFreeGb = parseInt(parts[3], 10);
    }
  } catch { /* skip */ }

  // Software detection  --  check if commands exist
  const check = (cmd: string, args: string[] = ["--version"]): boolean => {
    try { execFileSync(cmd, args, { timeout: 3000, encoding: "utf-8", stdio: "pipe" }); return true; }
    catch { return false; }
  };

  caps.ffmpeg = check("ffmpeg", ["-version"]);
  caps.docker = check("docker", ["--version"]);
  caps.python = check("python3", ["--version"]);
  caps.node = check("node", ["--version"]);

  // Python ML libraries
  if (caps.python) {
    caps.pytorch = check("python3", ["-c", "import torch"]);
    caps.tensorflow = check("python3", ["-c", "import tensorflow"]);
  }

  // Load custom config from ~/.hive/capabilities.json (tags + project overrides)
  let customProjects: Record<string, string> | undefined;
  try {
    const capFile = join(homedir(), ".hive", "capabilities.json");
    if (existsSync(capFile)) {
      const custom = JSON.parse(readFileSync(capFile, "utf-8")) as { tags?: string[]; projects?: Record<string, string> };
      if (custom.tags) caps.tags = custom.tags;
      if (custom.projects) customProjects = custom.projects;
    }
  } catch { /* skip */ }

  // Auto-detect projects: scan common locations for git repos.
  // Each project is identified by directory name -> absolute path.
  // Custom projects from capabilities.json override auto-detected ones.
  const projects: Record<string, string> = {};
  const scanDirs = [
    join(homedir(), "factory", "projects"),  // primary convention
    homedir(),                                // top-level repos (~/hive, ~/crawler)
    join(homedir(), "projects"),              // common convention
    join(homedir(), "code"),                  // common convention
    join(homedir(), "dev"),                   // common convention
  ];
  for (const dir of scanDirs) {
    try {
      if (!existsSync(dir)) continue;
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        try {
          if (!statSync(full).isDirectory()) continue;
          if (existsSync(join(full, ".git"))) {
            // Use directory name as project name (first match wins)
            if (!projects[entry]) projects[entry] = full;
          }
        } catch { /* skip unreadable dirs */ }
      }
    } catch { /* skip */ }
  }
  // Custom overrides take priority
  if (customProjects) Object.assign(projects, customProjects);
  if (Object.keys(projects).length > 0) caps.projects = projects;

  return caps;
}

/**
 * Detect capabilities and write to ~/.hive/machine.json.
 * Returns the capabilities object for further use.
 */
export function detectAndWriteMachineManifest(): MachineCapabilities {
  const caps = detectCapabilities();
  try {
    const hiveDir = join(homedir(), ".hive");
    mkdirSync(hiveDir, { recursive: true });
    writeFileSync(join(hiveDir, "machine.json"), JSON.stringify(caps, null, 2) + "\n");
  } catch {
    // Best-effort: don't crash if we can't write the file
  }
  return caps;
}
