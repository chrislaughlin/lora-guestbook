import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { GuestMessageRecord } from "../src/guest-message-contract.js";
import {
  DEFAULT_GUEST_MESSAGE_LIST_LIMIT,
  GuestMessageRepository,
  type GuestMessageRepositoryLogger,
  MAX_GUEST_MESSAGE_LIST_LIMIT
} from "../src/guest-message-repository.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("guest message repository", () => {
  it("creates the schema in a new data directory without manual SQL", () => {
    const repository = openRepository("nested/guestbook.sqlite3");

    const listed = repository.listGuestMessages();

    expect(listed).toEqual({ ok: true, records: [] });
    repository.close();
  });

  it("inserts and reads back guest-visible fields unchanged after reopening", () => {
    const databasePath = temporaryDatabasePath("guestbook.sqlite3");
    const record = guestMessage({
      messageKey: "first-message",
      name: "Ada Lovelace",
      message: "Hello from the radio desk",
      receivedAt: "2026-08-31T10:15:00.000Z",
      source: {
        senderId: "node-7",
        messageId: "packet-0001"
      }
    });

    const writer = new GuestMessageRepository({ databasePath });
    expect(writer.insertAcceptedGuestMessage(record)).toMatchObject({
      ok: true,
      status: "inserted",
      record
    });
    writer.close();

    const reader = new GuestMessageRepository({ databasePath });
    expect(reader.listGuestMessages()).toMatchObject({
      ok: true,
      records: [record]
    });
    reader.close();
  });

  it("returns a duplicate result and keeps exactly one row for repeated message keys", () => {
    const repository = openRepository("guestbook.sqlite3");
    const original = guestMessage({ messageKey: "same-message" });
    const repeat = guestMessage({
      messageKey: "same-message",
      name: "Grace Hopper",
      message: "Repeated packet"
    });

    expect(repository.insertAcceptedGuestMessage(original)).toMatchObject({
      ok: true,
      status: "inserted"
    });
    expect(repository.insertAcceptedGuestMessage(repeat)).toMatchObject({
      ok: true,
      status: "duplicate",
      messageKey: "same-message",
      error: { category: "duplicate_message" }
    });

    const listed = repository.listGuestMessages();
    expect(listed.ok && listed.records).toHaveLength(1);
    expect(listed.ok && listed.records[0]?.messageKey).toBe("same-message");
    repository.close();
  });

  it("lists records newest-first with insertion order as a deterministic tie-breaker", () => {
    const repository = openRepository("guestbook.sqlite3");
    const older = guestMessage({
      messageKey: "older",
      receivedAt: "2026-08-31T09:00:00.000Z"
    });
    const tiedFirst = guestMessage({
      messageKey: "tie-first",
      receivedAt: "2026-08-31T10:00:00.000Z"
    });
    const tiedSecond = guestMessage({
      messageKey: "tie-second",
      receivedAt: "2026-08-31T10:00:00.000Z"
    });

    repository.insertAcceptedGuestMessage(older);
    repository.insertAcceptedGuestMessage(tiedFirst);
    repository.insertAcceptedGuestMessage(tiedSecond);

    const listed = repository.listGuestMessages({ limit: 3 });

    expect(listed.ok && listed.records.map((record) => record.messageKey)).toEqual([
      "tie-second",
      "tie-first",
      "older"
    ]);
    repository.close();
  });

  it("bounds invalid and excessive list limits", () => {
    const repository = openRepository("guestbook.sqlite3");

    for (let index = 0; index < MAX_GUEST_MESSAGE_LIST_LIMIT + 5; index += 1) {
      repository.insertAcceptedGuestMessage(
        guestMessage({
          messageKey: `message-${index.toString().padStart(3, "0")}`,
          receivedAt: `2026-08-31T10:${String(index % 60).padStart(2, "0")}:00.000Z`
        })
      );
    }

    const invalidLimit = repository.listGuestMessages({ limit: 0 });
    const excessiveLimit = repository.listGuestMessages({ limit: MAX_GUEST_MESSAGE_LIST_LIMIT + 1 });

    expect(invalidLimit.ok && invalidLimit.records).toHaveLength(DEFAULT_GUEST_MESSAGE_LIST_LIMIT);
    expect(excessiveLimit.ok && excessiveLimit.records).toHaveLength(MAX_GUEST_MESSAGE_LIST_LIMIT);
    repository.close();
  });

  it("returns a structured failure and logs when database initialization fails", () => {
    const logger: GuestMessageRepositoryLogger = { error: vi.fn((..._data: unknown[]) => undefined) };
    const directory = mkdtempSync(join(tmpdir(), "guestbook-repository-"));
    temporaryDirectories.push(directory);
    const blockingFile = join(directory, "not-a-directory");
    writeFileSync(blockingFile, "");
    const repository = new GuestMessageRepository({
      databasePath: join(blockingFile, "guestbook.sqlite3"),
      logger
    });

    const result = repository.insertAcceptedGuestMessage(guestMessage({ messageKey: "after-close" }));

    expect(result).toMatchObject({
      ok: false,
      status: "failed",
      operation: "initialize"
    });
    expect(logger.error).toHaveBeenCalledWith(
      "Guest message repository operation failed.",
      expect.objectContaining({
        operation: "initialize",
        error: expect.any(String)
      })
    );
  });

  it("preserves existing records when initialization runs again", () => {
    const databasePath = temporaryDatabasePath("guestbook.sqlite3");
    const record = guestMessage({ messageKey: "preserved" });

    const first = new GuestMessageRepository({ databasePath });
    first.insertAcceptedGuestMessage(record);
    expect(first.initialize()).toEqual({ ok: true });
    first.close();

    const second = new GuestMessageRepository({ databasePath });
    expect(second.initialize()).toEqual({ ok: true });
    expect(second.listGuestMessages()).toMatchObject({
      ok: true,
      records: [record]
    });
    second.close();
  });
});

function openRepository(path: string, logger?: GuestMessageRepositoryLogger): GuestMessageRepository {
  return new GuestMessageRepository({
    databasePath: temporaryDatabasePath(path),
    ...(logger === undefined ? {} : { logger })
  });
}

function temporaryDatabasePath(path: string): string {
  const directory = mkdtempSync(join(tmpdir(), "guestbook-repository-"));
  temporaryDirectories.push(directory);
  return join(directory, path);
}

function guestMessage(overrides: Partial<GuestMessageRecord> = {}): GuestMessageRecord {
  return {
    messageKey: "message-key",
    name: "Ada Lovelace",
    message: "Hello from the radio desk",
    receivedAt: "2026-08-31T10:15:00.000Z",
    source: {},
    ...overrides
  };
}
