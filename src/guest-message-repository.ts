import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { GuestMessageRecord, GuestMessageValidationError } from "./guest-message-contract.js";

export const DEFAULT_GUESTBOOK_DATABASE_PATH = "data/guestbook.sqlite3";
export const DEFAULT_GUEST_MESSAGE_LIST_LIMIT = 50;
export const MAX_GUEST_MESSAGE_LIST_LIMIT = 200;

export type GuestMessageRepositoryLogger = Pick<Console, "error">;

export interface GuestMessageRow extends GuestMessageRecord {
  id: number;
  storedAt: string;
}

export interface GuestMessageRepositoryFailure {
  ok: false;
  status: "failed";
  operation: "initialize" | "insert" | "list";
  error: Error;
}

export type StoreGuestMessageResult =
  | { ok: true; status: "inserted"; record: GuestMessageRow }
  | { ok: true; status: "duplicate"; messageKey: string; error: GuestMessageValidationError }
  | GuestMessageRepositoryFailure;

export type ListGuestMessagesResult =
  | { ok: true; records: GuestMessageRow[] }
  | GuestMessageRepositoryFailure;

export interface ListGuestMessagesOptions {
  limit?: number;
  offset?: number;
}

export interface GuestMessageRepositoryOptions {
  databasePath: string;
  logger?: GuestMessageRepositoryLogger;
}

interface GuestMessageDatabaseRow {
  id: number;
  message_key: string;
  name: string;
  message: string;
  received_at: string;
  sender_id: string | null;
  message_id: string | null;
  stored_at: string;
}

const SQLITE_CONSTRAINT_UNIQUE = 2067;

export class GuestMessageRepository {
  readonly databasePath: string;

  private readonly database: DatabaseSync;
  private readonly logger: GuestMessageRepositoryLogger;
  private initialized = false;

  constructor(options: GuestMessageRepositoryOptions) {
    this.databasePath = options.databasePath;
    this.logger = options.logger ?? console;
    mkdirSync(dirname(options.databasePath), { recursive: true });
    this.database = new DatabaseSync(options.databasePath);
  }

  initialize(): StoreGuestMessageResult | { ok: true } {
    if (this.initialized) {
      return { ok: true };
    }

    try {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS guest_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          message_key TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          message TEXT NOT NULL,
          received_at TEXT NOT NULL,
          sender_id TEXT,
          message_id TEXT,
          stored_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        );

        CREATE INDEX IF NOT EXISTS idx_guest_messages_order
          ON guest_messages (received_at DESC, id DESC);
      `);
      this.initialized = true;
      return { ok: true };
    } catch (cause) {
      return this.fail("initialize", cause);
    }
  }

  insertAcceptedGuestMessage(record: GuestMessageRecord): StoreGuestMessageResult {
    const initialized = this.initialize();
    if (!initialized.ok) {
      return initialized;
    }

    try {
      this.database
        .prepare(
          `
            INSERT INTO guest_messages (
              message_key,
              name,
              message,
              received_at,
              sender_id,
              message_id
            )
            VALUES (?, ?, ?, ?, ?, ?)
          `
        )
        .run(
          record.messageKey,
          record.name,
          record.message,
          record.receivedAt,
          record.source.senderId ?? null,
          record.source.messageId ?? null
        );

      const inserted = this.findByMessageKey(record.messageKey);
      if (inserted === undefined) {
        return this.fail("insert", new Error("Inserted guest message could not be read back."));
      }

      return { ok: true, status: "inserted", record: inserted };
    } catch (cause) {
      if (isUniqueConstraintError(cause)) {
        return {
          ok: true,
          status: "duplicate",
          messageKey: record.messageKey,
          error: {
            category: "duplicate_message",
            detail: "Message identity has already been accepted."
          }
        };
      }

      return this.fail("insert", cause);
    }
  }

  listGuestMessages(options: ListGuestMessagesOptions = {}): ListGuestMessagesResult {
    const initialized = this.initialize();
    if (!initialized.ok) {
      return initialized;
    }

    const limit = normalizeLimit(options.limit);
    const offset = normalizeOffset(options.offset);

    try {
      const rows = this.database
        .prepare(
          `
            SELECT
              id,
              message_key,
              name,
              message,
              received_at,
              sender_id,
              message_id,
              stored_at
            FROM guest_messages
            ORDER BY received_at DESC, id DESC
            LIMIT ? OFFSET ?
          `
        )
        .all(limit, offset) as unknown as GuestMessageDatabaseRow[];

      return { ok: true, records: rows.map(rowToGuestMessage) };
    } catch (cause) {
      return this.fail("list", cause);
    }
  }

  close(): void {
    this.database.close();
  }

  private findByMessageKey(messageKey: string): GuestMessageRow | undefined {
    const row = this.database
      .prepare(
        `
          SELECT
            id,
            message_key,
            name,
            message,
            received_at,
            sender_id,
            message_id,
            stored_at
          FROM guest_messages
          WHERE message_key = ?
        `
      )
      .get(messageKey) as GuestMessageDatabaseRow | undefined;

    return row === undefined ? undefined : rowToGuestMessage(row);
  }

  private fail(operation: "initialize" | "insert" | "list", cause: unknown): GuestMessageRepositoryFailure {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    this.logger.error("Guest message repository operation failed.", {
      operation,
      databasePath: this.databasePath,
      error: error.message
    });

    return { ok: false, status: "failed", operation, error };
  }
}

function rowToGuestMessage(row: GuestMessageDatabaseRow): GuestMessageRow {
  return {
    id: row.id,
    messageKey: row.message_key,
    name: row.name,
    message: row.message,
    receivedAt: row.received_at,
    storedAt: row.stored_at,
    source: {
      ...(row.sender_id === null ? {} : { senderId: row.sender_id }),
      ...(row.message_id === null ? {} : { messageId: row.message_id })
    }
  };
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isInteger(limit) || limit < 1) {
    return DEFAULT_GUEST_MESSAGE_LIST_LIMIT;
  }

  return Math.min(limit, MAX_GUEST_MESSAGE_LIST_LIMIT);
}

function normalizeOffset(offset: number | undefined): number {
  if (offset === undefined || !Number.isInteger(offset) || offset < 0) {
    return 0;
  }

  return offset;
}

function isUniqueConstraintError(cause: unknown): boolean {
  return (
    cause instanceof Error &&
    "code" in cause &&
    "errcode" in cause &&
    cause.code === "ERR_SQLITE_ERROR" &&
    cause.errcode === SQLITE_CONSTRAINT_UNIQUE
  );
}
