import { describe, expect, it } from "vitest";

import { DEFAULT_GUESTBOOK_DATABASE_PATH } from "../src/guest-message-repository.js";
import { DEFAULT_MAX_SSE_CLIENTS, DEFAULT_SSE_DRAIN_TIMEOUT_MS } from "../src/guestbook-events.js";
import { DEFAULT_GUESTBOOK_HOST, DEFAULT_GUESTBOOK_PORT } from "../src/guestbook-server.js";
import { DEFAULT_GUESTBOOK_CLIENT_DIR, parseArgs } from "../src/server-cli.js";

describe("guestbook server CLI config", () => {
  it("uses stable defaults without CORS by default", () => {
    expect(parseArgs([], {})).toEqual({
      clientDir: DEFAULT_GUESTBOOK_CLIENT_DIR,
      databasePath: DEFAULT_GUESTBOOK_DATABASE_PATH,
      host: DEFAULT_GUESTBOOK_HOST,
      port: DEFAULT_GUESTBOOK_PORT,
      replayPaths: []
    });
  });

  it("parses environment defaults and command-line overrides", () => {
    expect(
      parseArgs(
        [
          "--host",
          "0.0.0.0",
          "--port",
          "8080",
          "--allowed-origin",
          "https://guestbook.example",
          "--max-sse-clients",
          "12",
          "--sse-drain-timeout-ms",
          "750",
          "--replay",
          "a.json"
        ],
        {
          GUESTBOOK_ALLOWED_ORIGIN: "https://env.example",
          GUESTBOOK_DATABASE_PATH: "data/env.sqlite3",
          GUESTBOOK_HOST: "127.0.0.2",
          GUESTBOOK_MAX_SSE_CLIENTS: String(DEFAULT_MAX_SSE_CLIENTS),
          GUESTBOOK_PORT: "3001",
          GUESTBOOK_SSE_DRAIN_TIMEOUT_MS: String(DEFAULT_SSE_DRAIN_TIMEOUT_MS)
        }
      )
    ).toEqual({
      allowedOrigin: "https://guestbook.example",
      clientDir: DEFAULT_GUESTBOOK_CLIENT_DIR,
      databasePath: "data/env.sqlite3",
      host: "0.0.0.0",
      maxSseClients: 12,
      port: 8080,
      replayPaths: ["a.json"],
      sseDrainTimeoutMs: 750
    });
  });

  it("parses SSE capacity and drain timeout from the environment", () => {
    expect(
      parseArgs([], {
        GUESTBOOK_MAX_SSE_CLIENTS: "3",
        GUESTBOOK_SSE_DRAIN_TIMEOUT_MS: "250"
      })
    ).toEqual({
      clientDir: DEFAULT_GUESTBOOK_CLIENT_DIR,
      databasePath: DEFAULT_GUESTBOOK_DATABASE_PATH,
      host: DEFAULT_GUESTBOOK_HOST,
      maxSseClients: 3,
      port: DEFAULT_GUESTBOOK_PORT,
      replayPaths: [],
      sseDrainTimeoutMs: 250
    });
  });

  it.each([
    ["0"],
    ["65536"],
    ["3000.5"],
    ["abc"]
  ])("rejects invalid port %s", (port) => {
    expect(() => parseArgs(["--port", port], {})).toThrow("--port must be an integer from 1 to 65535.");
  });

  it.each([
    ["--max-sse-clients", "-1"],
    ["--max-sse-clients", "1.5"],
    ["--max-sse-clients", "many"],
    ["--sse-drain-timeout-ms", "-1"],
    ["--sse-drain-timeout-ms", "1.5"],
    ["--sse-drain-timeout-ms", "soon"]
  ])("rejects invalid %s value %s", (option, value) => {
    expect(() => parseArgs([option, value], {})).toThrow(`${option} must be a non-negative integer.`);
  });

  it.each([
    ["GUESTBOOK_MAX_SSE_CLIENTS", "-1"],
    ["GUESTBOOK_MAX_SSE_CLIENTS", "1.5"],
    ["GUESTBOOK_MAX_SSE_CLIENTS", "many"],
    ["GUESTBOOK_SSE_DRAIN_TIMEOUT_MS", "-1"],
    ["GUESTBOOK_SSE_DRAIN_TIMEOUT_MS", "1.5"],
    ["GUESTBOOK_SSE_DRAIN_TIMEOUT_MS", "soon"]
  ])("rejects invalid %s environment value %s", (name, value) => {
    expect(() => parseArgs([], { [name]: value })).toThrow(`${name} must be a non-negative integer.`);
  });

  it.each([
    ["https://guestbook.example/"],
    ["https://guestbook.example/path"],
    ["https://guestbook.example?mode=test"],
    ["ftp://guestbook.example"],
    ["not a url"]
  ])("rejects non-exact allowed origin %s", (origin) => {
    expect(() => parseArgs(["--allowed-origin", origin], {})).toThrow(
      "--allowed-origin must be an exact http or https origin"
    );
  });
});
