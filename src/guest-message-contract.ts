import { createHash } from "node:crypto";
import { z } from "zod";

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

const normalizedText = (maxLength: number) =>
  z
    .string()
    .transform((value) => value.replace(/\s+/gu, " ").trim())
    .pipe(z.string().min(1).max(maxLength));

const optionalIdentifier = z.preprocess(
  (value) => (value === null ? undefined : value),
  z.string().trim().min(1).max(IDENTIFIER_MAX_LENGTH).regex(IDENTIFIER_PATTERN).optional()
);

const receivedAtSchema = z
  .string()
  .refine((value) => !Number.isNaN(new Date(value).getTime()))
  .transform((value) => new Date(value).toISOString());

const guestMessagePayloadSchema = z.object({
  name: normalizedText(GUEST_NAME_MAX_LENGTH),
  message: normalizedText(GUEST_MESSAGE_MAX_LENGTH),
  senderId: optionalIdentifier,
  messageId: optionalIdentifier,
  receivedAt: receivedAtSchema
});

type NormalizedGuestMessagePayload = z.infer<typeof guestMessagePayloadSchema>;

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

  const candidate = { ...payload, receivedAt: payload.receivedAt ?? options.receivedAt };
  const parsed = guestMessagePayloadSchema.safeParse(candidate);
  if (!parsed.success) {
    return zodErrorToValidationError(parsed.error, candidate);
  }

  const source = {
    ...(parsed.data.senderId === undefined ? {} : { senderId: parsed.data.senderId }),
    ...(parsed.data.messageId === undefined ? {} : { messageId: parsed.data.messageId })
  };

  return {
    ok: true,
    record: {
      name: parsed.data.name,
      message: parsed.data.message,
      messageKey: buildMessageKey({
        name: parsed.data.name,
        message: parsed.data.message,
        receivedAt: parsed.data.receivedAt,
        ...source
      }),
      receivedAt: parsed.data.receivedAt,
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

function zodErrorToValidationError(
  error: z.ZodError<NormalizedGuestMessagePayload>,
  candidate: Record<string, unknown>
): RejectedGuestMessageResult {
  const issue = error.issues[0];
  const field = issue?.path[0] as keyof RawGuestMessagePayload | undefined;

  if (field === "name" || field === "message") {
    if (!(field in candidate) || candidate[field] === undefined) {
      return reject("missing_field", field, `${field} is required.`);
    }

    if (typeof candidate[field] !== "string") {
      return reject("malformed_payload", field, `${field} must be a string.`);
    }

    const normalized = candidate[field].replace(/\s+/gu, " ").trim();
    if (normalized.length === 0) {
      return reject("empty_field", field, `${field} cannot be empty.`);
    }

    return reject("field_too_long", field, `${field} is too long.`);
  }

  if (field === "senderId" || field === "messageId") {
    return reject(
      "invalid_identifier",
      field,
      `${field} must be 1-${IDENTIFIER_MAX_LENGTH} URL-safe identifier characters.`
    );
  }

  if (field === "receivedAt") {
    if (!("receivedAt" in candidate) || candidate.receivedAt === undefined) {
      return reject("missing_field", "receivedAt", "receivedAt is required until the adapter supplies one.");
    }

    return reject("invalid_timestamp", "receivedAt", "receivedAt must be an ISO 8601 timestamp.");
  }

  return reject("malformed_payload", undefined, issue?.message ?? "Payload failed schema validation.");
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
