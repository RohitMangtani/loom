import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync, chmodSync, readFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(scriptDir, "..");
const repoRoot = resolve(desktopDir, "..", "..");
const generatedRoot = join(desktopDir, ".generated", "runtime");
const hiveRuntimeRoot = join(generatedRoot, "hive");
const daemonDist = join(repoRoot, "apps", "daemon", "dist");
const hookDir = join(repoRoot, "apps", "daemon", "src", "hooks");
const dashboardOut = join(repoRoot, "apps", "dashboard", "out");
const launcherSrc = join(desktopDir, "scripts", "desktop-launcher.mjs");
const runtimeNodeModules = join(hiveRuntimeRoot, "node_modules");
const daemonPackage = JSON.parse(readFileSync(join(repoRoot, "apps", "daemon", "package.json"), "utf8"));

if (!existsSync(daemonDist)) {
  throw new Error("apps/daemon/dist is missing. Run `npm -w apps/daemon run build` first.");
}

if (!existsSync(dashboardOut)) {
  throw new Error("apps/dashboard/out is missing. Run `npm -w apps/dashboard run build` first.");
}

rmSync(generatedRoot, { recursive: true, force: true });
mkdirSync(join(hiveRuntimeRoot, "apps", "daemon", "dist"), { recursive: true });
mkdirSync(join(hiveRuntimeRoot, "apps", "daemon", "src"), { recursive: true });
mkdirSync(join(hiveRuntimeRoot, "apps", "dashboard"), { recursive: true });
mkdirSync(join(generatedRoot, "launcher"), { recursive: true });
mkdirSync(join(generatedRoot, "bin"), { recursive: true });

cpSync(daemonDist, join(hiveRuntimeRoot, "apps", "daemon", "dist"), { recursive: true });
cpSync(hookDir, join(hiveRuntimeRoot, "apps", "daemon", "src", "hooks"), { recursive: true });
cpSync(dashboardOut, join(hiveRuntimeRoot, "apps", "dashboard", "out"), { recursive: true });
cpSync(launcherSrc, join(generatedRoot, "launcher", "desktop-launcher.mjs"));
cpSync(process.execPath, join(generatedRoot, "bin", "node"));
chmodSync(join(generatedRoot, "bin", "node"), 0o755);

const runtimePackageJson = {
  name: "hive-desktop-runtime",
  private: true,
  type: "module",
  dependencies: {
    express: daemonPackage.dependencies.express,
    "web-push": daemonPackage.dependencies["web-push"],
    ws: daemonPackage.dependencies.ws,
  },
};

writeFileSync(
  join(hiveRuntimeRoot, "package.json"),
  JSON.stringify(runtimePackageJson, null, 2) + "\n",
);

const install = spawnSync(
  "npm",
  ["install", "--omit=dev", "--no-package-lock", "--silent"],
  {
    cwd: hiveRuntimeRoot,
    stdio: "inherit",
  },
);

if (install.status !== 0) {
  throw new Error("Failed to install desktop runtime dependencies.");
}

if (!existsSync(runtimeNodeModules)) {
  throw new Error("Desktop runtime node_modules were not created.");
}

console.log(`Staged desktop runtime → ${generatedRoot}`);
