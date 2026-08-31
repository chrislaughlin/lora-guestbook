import { createHash } from "node:crypto";

export const GUEST_NAME_MAX_LENGTH = 80;
export const GUEST_MESSAGE_MAX_LENGTH = 500;
export const IDENTIFIER_MAX_LENGTH = 128;

export type GuestMessageErrorCategory =
  | "malformed_payload"
  | "invalid_encoding"
  | "missing_field"
  | "empty_field"
  | "field_too_long"
  | "invalid_timestamp"
  | "invalid_identifier"
  | "duplicate_message";

export interface RawGuestMessagePayload {
  name: string;
  message: string;
  senderId?: string;
  messageId?: string;
  receivedAt?: string;
}

export interface GuestMessageRecord {
  name: string;
  message: string;
  messageKey: string;
  receivedAt: string;
  source: {
    senderId?: string;
    messageId?: string;
  };
}

export interface GuestMessageValidationError {
  category: GuestMessageErrorCategory;
  field?: keyof RawGuestMessagePayload;
  detail: string;
}

export type ParseGuestMessageResult =
  | { ok: true; record: GuestMessageRecord }
  | { ok: false; error: GuestMessageValidationError };

export type DuplicateMessageResult =
  | { duplicate: false; messageKey: string }
  | { duplicate: true; messageKey: string; error: GuestMessageValidationError };

type RejectedGuestMessageResult = Extract<ParseGuestMessageResult, { ok: false }>;

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9._:-]+$/u;

export function parseGuestMessagePayload(
  input: string | Buffer | unknown,
  options: { receivedAt?: string } = {}
): ParseGuestMessageResult {
  const decoded = decodePayload(input);
  if (!decoded.ok) {
    return decoded;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded.payload);
  } catch {
    return reject("malformed_payload", undefined, "Payload must be valid JSON.");
  }

  return normalizeGuestMessage(parsed, options);
}

export function normalizeGuestMessage(
  payload: unknown,
  options: { receivedAt?: string } = {}
): ParseGuestMessageResult {
  if (!isRecord(payload)) {
    return reject("malformed_payload", undefined, "Payload must be a JSON object.");
  }

  const name = normalizeRequiredText(payload, "name", GUEST_NAME_MAX_LENGTH);
  if (!name.ok) {
    return name;
  }

  const message = normalizeRequiredText(payload, "message", GUEST_MESSAGE_MAX_LENGTH);
  if (!message.ok) {
    return message;
  }

  const senderId = normalizeOptionalIdentifier(payload, "senderId");
  if (!senderId.ok) {
    return senderId;
  }

  const messageId = normalizeOptionalIdentifier(payload, "messageId");
  if (!messageId.ok) {
    return messageId;
  }

  const receivedAtInput = payload.receivedAt ?? options.receivedAt;
  const receivedAt = normalizeReceivedAt(receivedAtInput);
  if (!receivedAt.ok) {
    return receivedAt;
  }

  const source = {
    ...(senderId.value === undefined ? {} : { senderId: senderId.value }),
    ...(messageId.value === undefined ? {} : { messageId: messageId.value })
  };

  return {
    ok: true,
    record: {
      name: name.value,
      message: message.value,
      messageKey: buildMessageKey({
        name: name.value,
        message: message.value,
        receivedAt: receivedAt.value,
        ...source
      }),
      receivedAt: receivedAt.value,
      source
    }
  };
}

export function classifyDuplicateMessage(
  record: GuestMessageRecord,
  existingMessageKeys: ReadonlySet<string>
): DuplicateMessageResult {
  if (!existingMessageKeys.has(record.messageKey)) {
    return { duplicate: false, messageKey: record.messageKey };
  }

  return {
    duplicate: true,
    messageKey: record.messageKey,
    error: {
      category: "duplicate_message",
      detail: "Message identity has already been accepted."
    }
  };
}

function decodePayload(input: string | Buffer | unknown): RejectedGuestMessageResult | { ok: true; payload: string } {
  if (typeof input === "string") {
    if (CONTROL_CHARACTER_PATTERN.test(input)) {
      return reject("invalid_encoding", undefined, "Payload contains unsupported control characters.");
    }

    return { ok: true, payload: input };
  }

  if (Buffer.isBuffer(input)) {
    const payload = input.toString("utf8");
    if (payload.includes("\uFFFD") || CONTROL_CHARACTER_PATTERN.test(payload)) {
      return reject("invalid_encoding", undefined, "Payload must be valid UTF-8 text.");
    }

    return { ok: true, payload };
  }

  return reject("malformed_payload", undefined, "Payload must be a JSON string, UTF-8 buffer, or object.");
}

function normalizeRequiredText(
  payload: Record<string, unknown>,
  field: "name" | "message",
  maxLength: number
): RejectedGuestMessageResult | { ok: true; value: string } {
  if (!(field in payload)) {
    return reject("missing_field", field, `${field} is required.`);
  }

  if (typeof payload[field] !== "string") {
    return reject("malformed_payload", field, `${field} must be a string.`);
  }

  const value = payload[field].replace(/\s+/gu, " ").trim();
  if (value.length === 0) {
    return reject("empty_field", field, `${field} cannot be empty.`);
  }

  if (value.length > maxLength) {
    return reject("field_too_long", field, `${field} must be ${maxLength} characters or fewer.`);
  }

  return { ok: true, value };
}

function normalizeOptionalIdentifier(
  payload: Record<string, unknown>,
  field: "senderId" | "messageId"
): RejectedGuestMessageResult | { ok: true; value?: string } {
  if (!(field in payload) || payload[field] === undefined || payload[field] === null) {
    return { ok: true };
  }

  if (typeof payload[field] !== "string") {
    return reject("invalid_identifier", field, `${field} must be a string when present.`);
  }

  const value = payload[field].trim();
  if (value.length === 0 || value.length > IDENTIFIER_MAX_LENGTH || !IDENTIFIER_PATTERN.test(value)) {
    return reject(
      "invalid_identifier",
      field,
      `${field} must be 1-${IDENTIFIER_MAX_LENGTH} URL-safe identifier characters.`
    );
  }

  return { ok: true, value };
}

function normalizeReceivedAt(input: unknown): RejectedGuestMessageResult | { ok: true; value: string } {
  if (typeof input !== "string") {
    return reject("missing_field", "receivedAt", "receivedAt is required until the adapter supplies one.");
  }

  const timestamp = new Date(input);
  if (Number.isNaN(timestamp.getTime())) {
    return reject("invalid_timestamp", "receivedAt", "receivedAt must be an ISO 8601 timestamp.");
  }

  return { ok: true, value: timestamp.toISOString() };
}

function buildMessageKey(input: {
  name: string;
  message: string;
  senderId?: string;
  messageId?: string;
  receivedAt: string;
}): string {
  const identity = input.messageId
    ? `message:${input.messageId}`
    : JSON.stringify({
        senderId: input.senderId ?? "anonymous",
        name: input.name,
        message: input.message,
        receivedAt: input.receivedAt
      });

  return createHash("sha256").update(identity).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reject(
  category: GuestMessageErrorCategory,
  field: keyof RawGuestMessagePayload | undefined,
  detail: string
): RejectedGuestMessageResult {
  return {
    ok: false,
    error: {
      category,
      ...(field === undefined ? {} : { field }),
      detail
    }
  };
}
