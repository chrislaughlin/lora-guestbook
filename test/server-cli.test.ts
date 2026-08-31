import { describe, expect, it } from "vitest";

import { DEFAULT_GUESTBOOK_DATABASE_PATH } from "../src/guest-message-repository.js";
import { DEFAULT_GUESTBOOK_HOST, DEFAULT_GUESTBOOK_PORT } from "../src/guestbook-server.js";
import { parseArgs } from "../src/server-cli.js";

describe("guestbook server CLI config", () => {
  it("uses stable defaults without CORS by default", () => {
    expect(parseArgs([], {})).toEqual({
      databasePath: DEFAULT_GUESTBOOK_DATABASE_PATH,
      host: DEFAULT_GUESTBOOK_HOST,
      port: DEFAULT_GUESTBOOK_PORT,
      replayPaths: []
    });
  });

  it("parses environment defaults and command-line overrides", () => {
    expect(
      parseArgs(["--host", "0.0.0.0", "--port", "8080", "--allowed-origin", "https://guestbook.example", "--replay", "a.json"], {
        GUESTBOOK_ALLOWED_ORIGIN: "https://env.example",
        GUESTBOOK_DATABASE_PATH: "data/env.sqlite3",
        GUESTBOOK_HOST: "127.0.0.2",
        GUESTBOOK_PORT: "3001"
      })
    ).toEqual({
      allowedOrigin: "https://guestbook.example",
      databasePath: "data/env.sqlite3",
      host: "0.0.0.0",
      port: 8080,
      replayPaths: ["a.json"]
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
