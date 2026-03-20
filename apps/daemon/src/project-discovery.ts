import { existsSync, readdirSync, statSync } from "fs";
import { join } from "path";

export function getProjectScanDirs(homeDir: string): string[] {
  return [
    join(homeDir, "factory", "projects"),
    homeDir,
    join(homeDir, "projects"),
    join(homeDir, "code"),
    join(homeDir, "dev"),
  ];
}

/** Scan common directories for git repos and return name -> absolute path. */
export function scanLocalProjects(homeDir: string): Record<string, string> {
  const projects: Record<string, string> = {};
  for (const dir of getProjectScanDirs(homeDir)) {
    try {
      if (!existsSync(dir)) continue;
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        try {
          if (!statSync(full).isDirectory()) continue;
          if (!existsSync(join(full, ".git"))) continue;
          if (!projects[entry]) projects[entry] = full;
        } catch {
          // Skip unreadable entries.
        }
      }
    } catch {
      // Skip missing or unreadable scan roots.
    }
  }
  return projects;
}
