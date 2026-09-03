#!/usr/bin/env node
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_CLI = resolve(ROOT, "dist/src/server-cli.js");
const DEFAULT_DEV_DATABASE = "data/guestbook.dev.sqlite3";
const DEFAULT_PRODUCTION_DATABASE = "data/guestbook.sqlite3";
const DEV_REPLAY_FIXTURES = [
  "fixtures/guest-messages/valid-basic.json",
  "fixtures/guest-messages/valid-boundary.json",
  "fixtures/guest-messages/valid-whitespace.json"
];

const modeAliases = new Map([
  ["dev", "dev"],
  ["development", "dev"],
  ["prod", "production"],
  ["production", "production"]
]);

async function main(argv = process.argv.slice(2), env = process.env) {
  let options;
  try {
    options = parseArgs(argv, env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    printUsage();
    return 1;
  }

  if (options.help) {
    printUsage();
    return 0;
  }

  try {
    await access(SERVER_CLI);
  } catch {
    console.error("The guestbook server has not been built. Run `npm run build` before starting the app.");
    return 1;
  }

  const child = spawn(process.execPath, [SERVER_CLI, ...buildServerArgs(options)], {
    cwd: ROOT,
    env,
    stdio: "inherit"
  });

  return await waitForExit(child);
}

export function parseArgs(argv, env = process.env) {
  const options = {
    forwardedArgs: [],
    help: false,
    mode: undefined
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }

    if (arg === "--mode") {
      const value = requiredValue(argv, index, "--mode");
      options.mode = parseMode(value);
      index += 1;
      continue;
    }

    if (arg?.startsWith("--mode=")) {
      options.mode = parseMode(arg.slice("--mode=".length));
      continue;
    }

    options.forwardedArgs.push(arg);
  }

  const envMode = env.GUESTBOOK_MODE === undefined ? undefined : parseMode(env.GUESTBOOK_MODE);
  const mode = options.mode ?? envMode ?? "dev";
  return {
    ...options,
    databasePath:
      mode === "dev"
        ? env.GUESTBOOK_DEV_DATABASE_PATH ?? DEFAULT_DEV_DATABASE
        : env.GUESTBOOK_DATABASE_PATH ?? DEFAULT_PRODUCTION_DATABASE,
    mode
  };
}

export function buildServerArgs(options) {
  const args = ["--database", options.databasePath, ...options.forwardedArgs];

  if (options.mode === "dev") {
    for (const fixture of DEV_REPLAY_FIXTURES) {
      args.push("--replay", fixture);
    }
  }

  return args;
}

function parseMode(value) {
  const mode = modeAliases.get(value.toLowerCase());
  if (mode === undefined) {
    throw new Error("--mode must be either dev or production.");
  }

  return mode;
}

function requiredValue(argv, index, name) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} requires a value.`);
  }

  return value;
}

function waitForExit(child) {
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => {
      if (signal !== null) {
        resolve(1);
        return;
      }

      resolve(code ?? 1);
    });
  });
}

function printUsage() {
  console.error(`Usage: npm run start:radio -- --mode <dev|production> [server options]

Modes:
  dev          Start with ${DEFAULT_DEV_DATABASE} and replay valid fixture messages.
  production   Start with ${DEFAULT_PRODUCTION_DATABASE} or GUESTBOOK_DATABASE_PATH and no dummy data.

Server options are passed through to lora-guestbook-server, for example:
  --host 0.0.0.0 --port 3000 --allowed-origin http://localhost:5173
`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main();
}
