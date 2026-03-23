#!/usr/bin/env node

import { spawnSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { homedir } from "os";
import process from "process";
import { createInterface } from "readline/promises";
import { fileURLToPath } from "url";

const BIN_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(BIN_DIR, "../../..");
const DEFAULT_REPO_URL = "https://github.com/RohitMangtani/hive.git";
const DEFAULT_REPO_REF = "main";
const DEFAULT_INSTALL_DIR = resolve(homedir(), "hive");
const HIVE_HOME = resolve(homedir(), ".hive");
const INSTALL_ROOT_FILE = resolve(HIVE_HOME, "install-root");
const NPM_BIN = process.platform === "win32" ? "npm.cmd" : "npm";

function quoteArg(value) {
  if (/^[A-Za-z0-9_./:=+-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function formatCommand(command, args) {
  return [command, ...args].map(quoteArg).join(" ");
}

function printUsage() {
  console.log(`Hive CLI

Usage:
  hive init [--desktop | --fresh | --connect <url> <token>] [--dir <path>] [--repo <url>] [--ref <git-ref>] [--dry-run]
  hive doctor [doctor-args] [--dir <path>] [--dry-run]
  hive help

Commands:
  init    Setup Hive on this machine or connect it to an existing network
  doctor  Run runtime diagnostics or repair helpers

Examples:
  hive init --fresh
  hive init --connect wss://example.trycloudflare.com YOUR_TOKEN
  hive init --desktop
  hive init --dir ~/src/hive
  hive doctor --repair-daemon
`);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function extractDryRun(args) {
  const filtered = [];
  let dryRun = false;
  for (const arg of args) {
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    filtered.push(arg);
  }
  return { args: filtered, dryRun };
}

function requireValue(args, index, flag) {
  const value = args[index + 1];
  if (!value) {
    fail(`Missing value for ${flag}`);
  }
  return value;
}

function resolvePath(inputPath) {
  if (!inputPath) return inputPath;
  if (inputPath.startsWith("~/")) {
    return resolve(homedir(), inputPath.slice(2));
  }
  return resolve(inputPath);
}

function isHiveRepoRoot(root) {
  return existsSync(resolve(root, "package.json")) &&
    existsSync(resolve(root, "scripts/install.sh")) &&
    existsSync(resolve(root, "scripts/doctor.sh"));
}

function getBundledRepoRoot() {
  return isHiveRepoRoot(PACKAGE_ROOT) ? PACKAGE_ROOT : null;
}

function getInstallScript(root) {
  return resolve(root, "scripts/install.sh");
}

function getDoctorScript(root) {
  return resolve(root, "scripts/doctor.sh");
}

function readSavedInstallRoot() {
  if (!existsSync(INSTALL_ROOT_FILE)) return null;
  const saved = readFileSync(INSTALL_ROOT_FILE, "utf-8").trim();
  if (!saved) return null;
  const normalized = resolvePath(saved);
  return isHiveRepoRoot(normalized) ? normalized : null;
}

function rememberInstallRoot(root, dryRun) {
  if (dryRun) {
    console.log(`# would remember install root: ${root}`);
    return;
  }
  mkdirSync(HIVE_HOME, { recursive: true });
  writeFileSync(INSTALL_ROOT_FILE, `${root}\n`, "utf-8");
}

function ensureCommand(command) {
  const result = spawnSync(command, ["--version"], {
    stdio: "ignore",
  });
  if (result.error) {
    fail(`Required command not found: ${command}`);
  }
}

function run(command, args, options = {}) {
  const { cwd = process.cwd(), dryRun = false } = options;
  const printable = formatCommand(command, args);
  if (dryRun) {
    console.log(`(cd ${quoteArg(cwd)} && ${printable})`);
    return;
  }

  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
  });

  if (result.error) {
    fail(`Failed to run ${printable}: ${result.error.message}`);
  }
  if ((result.status ?? 1) !== 0) {
    process.exit(result.status ?? 1);
  }
}

function cloneRepo(targetDir, repoUrl, ref, dryRun) {
  ensureCommand("git");
  run("git", ["clone", "--depth", "1", "--branch", ref, repoUrl, targetDir], { dryRun });
}

function ensureRepoDirectory(targetDir, repoUrl, ref, dryRun) {
  if (existsSync(targetDir)) {
    if (isHiveRepoRoot(targetDir)) {
      return targetDir;
    }
    const entries = readdirSync(targetDir);
    if (entries.length === 0) {
      cloneRepo(targetDir, repoUrl, ref, dryRun);
      return targetDir;
    }
    fail(`Target directory already exists and is not a Hive repo: ${targetDir}`);
  }

  cloneRepo(targetDir, repoUrl, ref, dryRun);
  return targetDir;
}

function resolveRepoOptions(rawArgs, allowRepoFlags) {
  const repoOptions = {
    dir: null,
    repoUrl: DEFAULT_REPO_URL,
    ref: DEFAULT_REPO_REF,
  };
  const remaining = [];

  for (let i = 0; i < rawArgs.length; i += 1) {
    const arg = rawArgs[i];
    if (arg === "--dir") {
      repoOptions.dir = resolvePath(requireValue(rawArgs, i, "--dir"));
      i += 1;
      continue;
    }
    if (allowRepoFlags && arg === "--repo") {
      repoOptions.repoUrl = requireValue(rawArgs, i, "--repo");
      i += 1;
      continue;
    }
    if (allowRepoFlags && arg === "--ref") {
      repoOptions.ref = requireValue(rawArgs, i, "--ref");
      i += 1;
      continue;
    }
    remaining.push(arg);
  }

  return { repoOptions, remaining };
}

function resolveManagedRepoRoot(repoOptions, options = {}) {
  const { bootstrap = false, dryRun = false } = options;
  if (repoOptions.dir) {
    const dir = ensureRepoDirectory(repoOptions.dir, repoOptions.repoUrl, repoOptions.ref, dryRun);
    rememberInstallRoot(dir, dryRun);
    return dir;
  }

  const bundled = getBundledRepoRoot();
  if (bundled) {
    return bundled;
  }

  const saved = readSavedInstallRoot();
  if (saved) {
    return saved;
  }

  if (!bootstrap) {
    fail("Hive install root not found. Run `hive init` first or pass --dir /path/to/hive.");
  }

  const repoRoot = ensureRepoDirectory(DEFAULT_INSTALL_DIR, repoOptions.repoUrl, repoOptions.ref, dryRun);
  rememberInstallRoot(repoRoot, dryRun);
  return repoRoot;
}

function runDesktopInit(repoRoot, dryRun) {
  run(NPM_BIN, ["install"], { cwd: repoRoot, dryRun });
  run(NPM_BIN, ["run", "desktop:prepare"], { cwd: repoRoot, dryRun });
  run(NPM_BIN, ["run", "desktop:smoke"], { cwd: repoRoot, dryRun });
  run(NPM_BIN, ["run", "desktop:dev"], { cwd: repoRoot, dryRun });
}

async function promptForInitMode() {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    console.log("");
    console.log("Hive init");
    console.log("");
    console.log("  1) Desktop app on this Mac");
    console.log("  2) New Hive environment with your own hosted dashboard");
    console.log("  3) Connect this Mac to an existing Hive network");
    console.log("");

    const selection = (await rl.question("Select setup [1/2/3]: ")).trim().toLowerCase();
    if (selection === "1" || selection === "desktop") {
      return { kind: "desktop" };
    }
    if (selection === "2" || selection === "fresh") {
      return { kind: "fresh" };
    }
    if (selection === "3" || selection === "connect") {
      const url = (await rl.question("Primary tunnel URL: ")).trim();
      const token = (await rl.question("Primary token: ")).trim();
      if (!url || !token) {
        fail("Connect mode requires both a tunnel URL and token.");
      }
      return { kind: "connect", url, token };
    }
  } finally {
    rl.close();
  }

  fail("Unsupported selection. Use 1, 2, or 3.");
}

async function resolveInitPlan(args) {
  const { repoOptions, remaining } = resolveRepoOptions(args, true);
  let mode = null;
  let connect = null;

  for (let i = 0; i < remaining.length; i += 1) {
    const arg = remaining[i];
    if (arg === "desktop" || arg === "--desktop") {
      if (mode) fail("Use only one init mode: --desktop, --fresh, or --connect <url> <token>.");
      mode = "desktop";
      continue;
    }
    if (arg === "--fresh") {
      if (mode) fail("Use only one init mode: --desktop, --fresh, or --connect <url> <token>.");
      mode = "fresh";
      continue;
    }
    if (arg === "--connect") {
      if (mode) fail("Use only one init mode: --desktop, --fresh, or --connect <url> <token>.");
      const url = requireValue(remaining, i, "--connect");
      const token = remaining[i + 2];
      if (!token) {
        fail("Connect mode requires: hive init --connect <url> <token>");
      }
      connect = { url, token };
      mode = "connect";
      i += 2;
      continue;
    }
    fail(`Unknown init arguments: ${remaining.join(" ")}`);
  }

  if (mode === "desktop") {
    return { kind: "desktop", repoOptions };
  }
  if (mode === "fresh") {
    return { kind: "fresh", repoOptions };
  }
  if (mode === "connect" && connect) {
    return { kind: "connect", url: connect.url, token: connect.token, repoOptions };
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return { kind: "fresh", repoOptions };
  }

  const prompted = await promptForInitMode();
  return { ...prompted, repoOptions };
}

async function handleInit(rawArgs, dryRun) {
  if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
    printUsage();
    return;
  }
  const plan = await resolveInitPlan(rawArgs);
  const repoRoot = resolveManagedRepoRoot(plan.repoOptions, {
    bootstrap: true,
    dryRun,
  });
  if (plan.kind === "desktop") {
    runDesktopInit(repoRoot, dryRun);
    return;
  }

  if (plan.kind === "connect") {
    run("bash", [getInstallScript(repoRoot), "--connect", plan.url, plan.token], {
      cwd: repoRoot,
      dryRun,
    });
    return;
  }

  run("bash", [getInstallScript(repoRoot), "--fresh"], {
    cwd: repoRoot,
    dryRun,
  });
}

function handleDoctor(rawArgs, dryRun) {
  if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
    printUsage();
    return;
  }
  const { repoOptions, remaining } = resolveRepoOptions(rawArgs, false);
  const repoRoot = resolveManagedRepoRoot(repoOptions, { dryRun });
  run("bash", [getDoctorScript(repoRoot), ...remaining], {
    cwd: repoRoot,
    dryRun,
  });
}

async function main() {
  const [command = "help", ...rest] = process.argv.slice(2);
  const { args, dryRun } = extractDryRun(rest);

  if (command === "help" || command === "--help" || command === "-h") {
    printUsage();
    return;
  }

  if (command === "doctor") {
    handleDoctor(args, dryRun);
    return;
  }

  if (command === "init") {
    await handleInit(args, dryRun);
    return;
  }

  fail(`Unknown command: ${command}`);
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
