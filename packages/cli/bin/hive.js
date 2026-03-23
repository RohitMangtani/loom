#!/usr/bin/env node

import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { dirname, resolve } from "path";
import process from "process";
import { createInterface } from "readline/promises";
import { fileURLToPath } from "url";

const BIN_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(BIN_DIR, "../../..");
const INSTALL_SCRIPT = resolve(ROOT, "scripts/install.sh");
const DOCTOR_SCRIPT = resolve(ROOT, "scripts/doctor.sh");
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
  hive init [--desktop | --fresh | --connect <url> <token>] [--dry-run]
  hive doctor [doctor-args] [--dry-run]
  hive help

Commands:
  init    Setup Hive on this machine or connect it to an existing network
  doctor  Run runtime diagnostics or repair helpers

Examples:
  hive init --fresh
  hive init --connect wss://example.trycloudflare.com YOUR_TOKEN
  hive init --desktop
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

function ensureRepoScripts() {
  for (const requiredPath of [INSTALL_SCRIPT, DOCTOR_SCRIPT, resolve(ROOT, "package.json")]) {
    if (!existsSync(requiredPath)) {
      fail(`Hive CLI could not find ${requiredPath}. Run it from a full Hive checkout.`);
    }
  }
}

function run(command, args, dryRun) {
  const printable = formatCommand(command, args);
  if (dryRun) {
    console.log(printable);
    return;
  }

  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: "inherit",
  });

  if (result.error) {
    fail(`Failed to run ${printable}: ${result.error.message}`);
  }
  if ((result.status ?? 1) !== 0) {
    process.exit(result.status ?? 1);
  }
}

function runDesktopInit(dryRun) {
  run(NPM_BIN, ["install"], dryRun);
  run(NPM_BIN, ["run", "desktop:prepare"], dryRun);
  run(NPM_BIN, ["run", "desktop:smoke"], dryRun);
  run(NPM_BIN, ["run", "desktop:dev"], dryRun);
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
  const normalized = [...args];
  if (normalized[0] === "desktop") {
    normalized.shift();
    normalized.unshift("--desktop");
  }

  const hasDesktop = normalized.includes("--desktop");
  const hasFresh = normalized.includes("--fresh");
  const connectIndex = normalized.indexOf("--connect");
  const hasConnect = connectIndex !== -1;
  const explicitModeCount = [hasDesktop, hasFresh, hasConnect].filter(Boolean).length;

  if (explicitModeCount > 1) {
    fail("Use only one init mode: --desktop, --fresh, or --connect <url> <token>.");
  }

  if (hasDesktop) {
    if (normalized.length !== 1) {
      fail("Desktop mode does not take extra arguments.");
    }
    return { kind: "desktop" };
  }
  if (hasFresh) {
    if (normalized.length !== 1) {
      fail("Fresh mode does not take extra arguments.");
    }
    return { kind: "fresh" };
  }
  if (hasConnect) {
    const url = normalized[connectIndex + 1];
    const token = normalized[connectIndex + 2];
    if (!url || !token) {
      fail("Connect mode requires: hive init --connect <url> <token>");
    }
    if (normalized.length !== 3) {
      fail("Connect mode only accepts: hive init --connect <url> <token>");
    }
    return { kind: "connect", url, token };
  }

  if (normalized.length > 0) {
    fail(`Unknown init arguments: ${normalized.join(" ")}`);
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return { kind: "fresh" };
  }

  return promptForInitMode();
}

async function handleInit(rawArgs, dryRun) {
  if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
    printUsage();
    return;
  }
  const plan = await resolveInitPlan(rawArgs);
  if (plan.kind === "desktop") {
    runDesktopInit(dryRun);
    return;
  }

  if (plan.kind === "connect") {
    run("bash", [INSTALL_SCRIPT, "--connect", plan.url, plan.token], dryRun);
    return;
  }

  run("bash", [INSTALL_SCRIPT, "--fresh"], dryRun);
}

function handleDoctor(rawArgs, dryRun) {
  if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
    printUsage();
    return;
  }
  run("bash", [DOCTOR_SCRIPT, ...rawArgs], dryRun);
}

async function main() {
  ensureRepoScripts();

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
