import { describe, expect, it } from "vitest";

import { buildServerArgs, parseArgs } from "../scripts/start-radio-guestbook.mjs";

describe("radio guestbook startup script", () => {
  it("defaults to dev mode with a dev database and seeded fixture replay", () => {
    const options = parseArgs([], {});

    expect(options.mode).toBe("dev");
    expect(buildServerArgs(options)).toEqual([
      "--database",
      "data/guestbook.dev.sqlite3",
      "--replay",
      "fixtures/guest-messages/valid-basic.json",
      "--replay",
      "fixtures/guest-messages/valid-boundary.json",
      "--replay",
      "fixtures/guest-messages/valid-whitespace.json"
    ]);
  });

  it("starts production with the real database and no dummy replay data", () => {
    const options = parseArgs(["--mode", "production", "--host", "0.0.0.0", "--port", "8080"], {});

    expect(options.mode).toBe("production");
    expect(buildServerArgs(options)).toEqual([
      "--database",
      "data/guestbook.sqlite3",
      "--host",
      "0.0.0.0",
      "--port",
      "8080"
    ]);
  });

  it("allows environment defaults and command-line mode override", () => {
    const options = parseArgs(["--mode=dev"], {
      GUESTBOOK_DATABASE_PATH: "data/prod.sqlite3",
      GUESTBOOK_DEV_DATABASE_PATH: "data/local.sqlite3",
      GUESTBOOK_MODE: "production"
    });

    expect(options.mode).toBe("dev");
    expect(buildServerArgs(options)[1]).toBe("data/local.sqlite3");
  });

  it("rejects unknown modes", () => {
    expect(() => parseArgs(["--mode", "test"], {})).toThrow("--mode must be either dev or production.");
  });
});
