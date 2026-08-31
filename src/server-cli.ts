#!/usr/bin/env node
import { DEFAULT_GUESTBOOK_DATABASE_PATH } from "./guest-message-repository.js";
import { createGuestbookServer, DEFAULT_GUESTBOOK_HOST, DEFAULT_GUESTBOOK_PORT } from "./guestbook-server.js";

interface ServerCliOptions {
  allowedOrigin?: string;
  databasePath: string;
  host: string;
  maxSseClients?: number;
  port: number;
  replayPaths: string[];
  sseDrainTimeoutMs?: number;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  let options: ServerCliOptions;
  try {
    options = parseArgs(argv, process.env);
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    console.error(error.message);
    return 1;
  }

  const guestbook = createGuestbookServer({
    ...(options.allowedOrigin === undefined ? {} : { allowedOrigin: options.allowedOrigin }),
    databasePath: options.databasePath,
    host: options.host,
    ...(options.maxSseClients === undefined ? {} : { maxSseClients: options.maxSseClients }),
    port: options.port,
    replayPaths: options.replayPaths,
    ...(options.sseDrainTimeoutMs === undefined ? {} : { sseDrainTimeoutMs: options.sseDrainTimeoutMs })
  });

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    void guestbook
      .close()
      .then(() => {
        console.info("Guestbook server stopped.", { signal });
      })
      .catch((cause: unknown) => {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        console.error("Guestbook server shutdown failed.", { signal, error: error.message });
        process.exitCode = 1;
      });
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  try {
    await guestbook.start();
    console.info("Guestbook server listening.", {
      host: options.host,
      port: options.port,
      databasePath: options.databasePath,
      replay: options.replayPaths.length
    });
    return 0;
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    console.error("Guestbook server failed to start.", { error: error.message });
    await guestbook.close();
    return 1;
  }
}

export function parseArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): ServerCliOptions {
  const options: ServerCliOptions = {
    databasePath: env.GUESTBOOK_DATABASE_PATH ?? DEFAULT_GUESTBOOK_DATABASE_PATH,
    host: env.GUESTBOOK_HOST ?? DEFAULT_GUESTBOOK_HOST,
    port: parsePort(env.PORT ?? env.GUESTBOOK_PORT ?? String(DEFAULT_GUESTBOOK_PORT), "port"),
    replayPaths: []
  };

  const envAllowedOrigin = env.GUESTBOOK_ALLOWED_ORIGIN;
  if (envAllowedOrigin !== undefined) {
    options.allowedOrigin = parseAllowedOrigin(envAllowedOrigin);
  }
  const envMaxSseClients = env.GUESTBOOK_MAX_SSE_CLIENTS;
  if (envMaxSseClients !== undefined) {
    options.maxSseClients = parseNonNegativeInteger(envMaxSseClients, "GUESTBOOK_MAX_SSE_CLIENTS");
  }
  const envSseDrainTimeoutMs = env.GUESTBOOK_SSE_DRAIN_TIMEOUT_MS;
  if (envSseDrainTimeoutMs !== undefined) {
    options.sseDrainTimeoutMs = parseNonNegativeInteger(envSseDrainTimeoutMs, "GUESTBOOK_SSE_DRAIN_TIMEOUT_MS");
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--database") {
      const value = requiredValue(argv, index, "--database");
      options.databasePath = value;
      index += 1;
      continue;
    }

    if (arg === "--host") {
      const value = requiredValue(argv, index, "--host");
      options.host = value;
      index += 1;
      continue;
    }

    if (arg === "--port") {
      const value = requiredValue(argv, index, "--port");
      options.port = parsePort(value, "--port");
      index += 1;
      continue;
    }

    if (arg === "--allowed-origin") {
      const value = requiredValue(argv, index, "--allowed-origin");
      options.allowedOrigin = parseAllowedOrigin(value);
      index += 1;
      continue;
    }

    if (arg === "--max-sse-clients") {
      const value = requiredValue(argv, index, "--max-sse-clients");
      options.maxSseClients = parseNonNegativeInteger(value, "--max-sse-clients");
      index += 1;
      continue;
    }

    if (arg === "--replay") {
      const value = requiredValue(argv, index, "--replay");
      options.replayPaths.push(value);
      index += 1;
      continue;
    }

    if (arg === "--sse-drain-timeout-ms") {
      const value = requiredValue(argv, index, "--sse-drain-timeout-ms");
      options.sseDrainTimeoutMs = parseNonNegativeInteger(value, "--sse-drain-timeout-ms");
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg ?? ""}`);
  }

  return options;
}

function requiredValue(argv: readonly string[], index: number, name: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} requires a value.`);
  }

  return value;
}

function parsePort(value: string, label: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${label} must be an integer from 1 to 65535.`);
  }

  return port;
}

function parseAllowedOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("--allowed-origin must be an exact http or https origin.");
  }

  const isHttpOrigin = parsed.protocol === "http:" || parsed.protocol === "https:";
  if (!isHttpOrigin || parsed.origin !== value || parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") {
    throw new Error("--allowed-origin must be an exact http or https origin with no path, query, or fragment.");
  }

  return value;
}

function parseNonNegativeInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }

  return parsed;
}

if (process.argv[1]?.endsWith("server-cli.js")) {
  process.exitCode = await main();
}
