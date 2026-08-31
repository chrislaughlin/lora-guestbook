import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { GuestMessageRecord } from "../src/guest-message-contract.js";
import { GuestMessageRepository, type StoreGuestMessageResult } from "../src/guest-message-repository.js";
import {
  type GuestMessageIngestionLogger,
  type GuestMessageStore,
  type RadioGuestMessageSource,
  type RadioGuestMessageSourceEvent,
  runGuestMessageIngestion
} from "../src/guest-message-ingestion.js";
import { expandReplayPath, ReplayGuestMessageSource } from "../src/replay-guest-message-source.js";
import { main, parseArgs } from "../src/ingest-cli.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("guest message ingestion", () => {
  it("persists a valid replay fixture once", async () => {
    const repository = openRepository();

    const result = await runGuestMessageIngestion(sourceFromFixtures(["valid-basic.json"]), repository, {
      logger: quietLogger()
    });

    expect(result.summary).toEqual({
      accepted: 1,
      invalid: 0,
      duplicate: 0,
      persistenceFailed: 0,
      transportFailed: 0
    });
    expect(repository.listGuestMessages()).toMatchObject({
      ok: true,
      records: [
        {
          name: "Ada Lovelace",
          message: "Hello from the radio desk"
        }
      ]
    });
    repository.close();
  });

  it("rejects invalid and oversized fixtures without inserting rows", async () => {
    const repository = openRepository();

    const result = await runGuestMessageIngestion(
      sourceFromFixtures(["invalid-missing-message.json", "invalid-oversized-message.json"]),
      repository,
      { logger: quietLogger() }
    );

    expect(result.outcomes.map((outcome) => outcome.status)).toEqual(["invalid", "invalid"]);
    expect(result.outcomes).toMatchObject([
      { status: "invalid", error: { category: "missing_field" } },
      { status: "invalid", error: { category: "field_too_long" } }
    ]);
    expect(repository.listGuestMessages()).toEqual({ ok: true, records: [] });
    repository.close();
  });

  it("classifies duplicate replay messages and stores only the first row", async () => {
    const repository = openRepository();

    const result = await runGuestMessageIngestion(
      sourceFromFixtures(["duplicate-original.json", "duplicate-repeat.json"]),
      repository,
      { logger: quietLogger() }
    );

    expect(result.outcomes.map((outcome) => outcome.status)).toEqual(["accepted", "duplicate"]);
    const listed = repository.listGuestMessages();
    expect(listed).toMatchObject({
      ok: true,
      records: [{ messageKey: expect.any(String) }]
    });
    expect(listed.ok && listed.records).toHaveLength(1);
    repository.close();
  });

  it("logs recoverable transport failures and continues with later input", async () => {
    const repository = openRepository();
    const logger = quietLogger();

    const result = await runGuestMessageIngestion(
      {
        name: "fake-radio",
        async *messages() {
          yield { recoverable: true, error: new Error("disconnected") };
          yield fixtureEvent("valid-basic.json");
        }
      },
      repository,
      { logger, retryDelayMs: 0, maxTransportRetries: 3 }
    );

    expect(result.outcomes.map((outcome) => outcome.status)).toEqual(["transport_failed", "accepted"]);
    expect(result.summary).toMatchObject({ accepted: 1, transportFailed: 1 });
    expect(logger.warn).toHaveBeenCalledWith(
      "Guest message transport failed.",
      expect.objectContaining({ status: "transport_failed", source: "fake-radio", error: "disconnected" })
    );
    repository.close();
  });

  it("logs per-message persistence failures and keeps processing later messages", async () => {
    const logger = quietLogger();
    const store = new FailingOnceStore();

    const result = await runGuestMessageIngestion(
      sourceFromFixtures(["valid-basic.json", "valid-whitespace.json"]),
      store,
      { logger }
    );

    expect(result.outcomes.map((outcome) => outcome.status)).toEqual(["persistence_failed", "accepted"]);
    expect(result.summary).toMatchObject({ accepted: 1, persistenceFailed: 1 });
    expect(logger.error).toHaveBeenCalledWith(
      "Guest message persistence failed.",
      expect.objectContaining({ status: "persistence_failed", operation: "insert" })
    );
  });

  it("calls onOutcome in processing order after persistence has classified each message", async () => {
    const repository = openRepository();
    const callbackStatuses: string[] = [];
    const publishedRecords: string[] = [];

    const result = await runGuestMessageIngestion(
      sourceFromFixtures(["duplicate-original.json", "duplicate-repeat.json", "invalid-missing-message.json"]),
      repository,
      {
        logger: quietLogger(),
        onOutcome(outcome) {
          callbackStatuses.push(outcome.status);
          if (outcome.status === "accepted") {
            publishedRecords.push(outcome.record.messageKey);
          }
        }
      }
    );

    expect(result.outcomes.map((outcome) => outcome.status)).toEqual(["accepted", "duplicate", "invalid"]);
    expect(callbackStatuses).toEqual(["accepted", "duplicate", "invalid"]);
    expect(publishedRecords).toHaveLength(1);
    expect(publishedRecords[0]).toMatch(/^[a-f0-9]{64}$/u);
    repository.close();
  });

  it("swallows onOutcome callback errors and keeps ingesting later messages", async () => {
    const repository = openRepository();
    const logger = quietLogger();
    const onOutcome = vi.fn(() => {
      throw new Error("callback failed");
    });

    const result = await runGuestMessageIngestion(
      sourceFromFixtures(["invalid-missing-message.json", "valid-basic.json"]),
      repository,
      { logger, onOutcome }
    );

    expect(result.outcomes.map((outcome) => outcome.status)).toEqual(["invalid", "accepted"]);
    expect(result.summary).toMatchObject({ accepted: 1, invalid: 1 });
    expect(onOutcome).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledWith(
      "Guest message ingestion outcome callback failed.",
      expect.objectContaining({ status: "invalid", source: "replay", error: "callback failed" })
    );
    expect(logger.error).toHaveBeenCalledWith(
      "Guest message ingestion outcome callback failed.",
      expect.objectContaining({ status: "accepted", source: "replay", error: "callback failed" })
    );
    repository.close();
  });

  it("returns a persistence failure outcome when startup initialization fails", async () => {
    const logger = quietLogger();
    const result = await runGuestMessageIngestion(sourceFromFixtures(["valid-basic.json"]), new InitializationFailingStore(), {
      logger
    });

    expect(result.outcomes).toMatchObject([{ status: "persistence_failed", operation: "initialize" }]);
    expect(result.summary).toMatchObject({ persistenceFailed: 1 });
  });

  it("expands replay directories deterministically by file name", () => {
    const expanded = expandReplayPath(join(process.cwd(), "fixtures", "guest-messages"));

    expect(expanded.map((path) => path.split("/").at(-1))).toEqual([...expanded.map((path) => path.split("/").at(-1))].sort());
    expect(expanded.every((path) => statSync(path).isFile())).toBe(true);
  });
});

describe("ingestion CLI", () => {
  it("parses database and repeated replay arguments", () => {
    expect(parseArgs(["--database", "data/custom.sqlite3", "--replay", "a.json", "--replay", "fixtures"])).toEqual({
      databasePath: "data/custom.sqlite3",
      replayPaths: ["a.json", "fixtures"]
    });
  });

  it("returns non-zero when replay input is missing", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(main([])).resolves.toBe(1);
    expect(error).toHaveBeenCalledWith("At least one --replay file or directory is required until a hardware adapter is configured.");
  });

  it("runs replay mode and writes to the selected database", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const databasePath = join(temporaryDirectory(), "guestbook.sqlite3");

    await expect(main(["--database", databasePath, "--replay", fixturePath("valid-basic.json")])).resolves.toBe(0);

    const repository = new GuestMessageRepository({ databasePath });
    expect(repository.listGuestMessages()).toMatchObject({
      ok: true,
      records: [{ name: "Ada Lovelace" }]
    });
    repository.close();
    expect(info).toHaveBeenCalledWith(
      "Guest message ingestion complete.",
      expect.objectContaining({ accepted: 1, invalid: 0 })
    );
  });
});

function sourceFromFixtures(names: readonly string[]): RadioGuestMessageSource {
  return {
    name: "replay",
    async *messages(): AsyncIterable<RadioGuestMessageSourceEvent> {
      for (const name of names) {
        yield fixtureEvent(name);
      }
    }
  };
}

function fixtureEvent(name: string): RadioGuestMessageSourceEvent {
  return { payload: readFileSync(fixturePath(name)) };
}

function fixturePath(name: string): string {
  return join(process.cwd(), "fixtures", "guest-messages", name);
}

function openRepository(): GuestMessageRepository {
  return new GuestMessageRepository({ databasePath: join(temporaryDirectory(), "guestbook.sqlite3") });
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "guestbook-ingestion-"));
  temporaryDirectories.push(directory);
  return directory;
}

function quietLogger(): GuestMessageIngestionLogger {
  return {
    error: vi.fn(() => undefined),
    info: vi.fn(() => undefined),
    warn: vi.fn(() => undefined)
  };
}

class FailingOnceStore implements GuestMessageStore {
  private failed = false;

  initialize(): { ok: true } {
    return { ok: true };
  }

  insertAcceptedGuestMessage(record: GuestMessageRecord): StoreGuestMessageResult {
    if (!this.failed) {
      this.failed = true;
      return { ok: false, status: "failed", operation: "insert", error: new Error("database is busy") };
    }

    return {
      ok: true,
      status: "inserted",
      record: {
        id: 1,
        storedAt: "2026-08-31T10:15:01.000Z",
        ...record
      }
    };
  }
}

class InitializationFailingStore implements GuestMessageStore {
  initialize(): StoreGuestMessageResult {
    return { ok: false, status: "failed", operation: "initialize", error: new Error("cannot open database") };
  }

  insertAcceptedGuestMessage(_record: GuestMessageRecord): StoreGuestMessageResult {
    throw new Error("insert should not be called after initialization failure");
  }
}
