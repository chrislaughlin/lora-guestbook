import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  classifyDuplicateMessage,
  GUEST_MESSAGE_MAX_LENGTH,
  GUEST_NAME_MAX_LENGTH,
  normalizeGuestMessage,
  parseGuestMessagePayload
} from "../src/guest-message-contract.js";

const fixtureRoot = join(process.cwd(), "fixtures", "guest-messages");

function readFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(fixtureRoot, name), "utf8"));
}

describe("guest message contract", () => {
  it("normalizes a valid guest message fixture", () => {
    const result = normalizeGuestMessage(readFixture("valid-basic.json"));

    expect(result).toMatchObject({
      ok: true,
      record: {
        name: "Ada Lovelace",
        message: "Hello from the radio desk",
        receivedAt: "2026-08-31T10:15:00.000Z",
        source: {
          senderId: "node-7",
          messageId: "packet-0001"
        }
      }
    });

    expect(result.ok && result.record.messageKey).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("accepts boundary-length name and message fields", () => {
    const result = normalizeGuestMessage(readFixture("valid-boundary.json"));

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error.detail);
    }

    expect(result.record.name).toHaveLength(GUEST_NAME_MAX_LENGTH);
    expect(result.record.message).toHaveLength(GUEST_MESSAGE_MAX_LENGTH);
  });

  it("collapses and trims whitespace before producing the normalized record", () => {
    const result = normalizeGuestMessage(readFixture("valid-whitespace.json"));

    expect(result).toMatchObject({
      ok: true,
      record: {
        name: "Grace Hopper",
        message: "Debugging from LoRa"
      }
    });
  });

  it.each([
    ["invalid-empty-name.json", "empty_field", "name"],
    ["invalid-missing-message.json", "missing_field", "message"],
    ["invalid-oversized-message.json", "field_too_long", "message"],
    ["invalid-timestamp.json", "invalid_timestamp", "receivedAt"],
    ["invalid-identifier.json", "invalid_identifier", "senderId"]
  ])("rejects %s with %s", (fixture, category, field) => {
    const result = normalizeGuestMessage(readFixture(fixture));

    expect(result).toMatchObject({
      ok: false,
      error: {
        category,
        field
      }
    });
    expect("record" in result).toBe(false);
  });

  it("rejects malformed JSON and unsupported control characters", () => {
    expect(parseGuestMessagePayload("{")).toMatchObject({
      ok: false,
      error: { category: "malformed_payload" }
    });

    expect(parseGuestMessagePayload("{\"name\":\"Null\u0000Byte\"}")).toMatchObject({
      ok: false,
      error: { category: "invalid_encoding" }
    });
  });

  it("classifies repeated message identity as a duplicate", () => {
    const original = normalizeGuestMessage(readFixture("duplicate-original.json"));
    const repeat = normalizeGuestMessage(readFixture("duplicate-repeat.json"));

    expect(original.ok).toBe(true);
    expect(repeat.ok).toBe(true);
    if (!original.ok || !repeat.ok) {
      throw new Error("Duplicate fixtures should be valid.");
    }

    expect(repeat.record.messageKey).toBe(original.record.messageKey);
    expect(classifyDuplicateMessage(original.record, new Set())).toEqual({
      duplicate: false,
      messageKey: original.record.messageKey
    });
    expect(classifyDuplicateMessage(repeat.record, new Set([original.record.messageKey]))).toMatchObject({
      duplicate: true,
      messageKey: original.record.messageKey,
      error: { category: "duplicate_message" }
    });
  });

  it("parses UTF-8 JSON buffers through the same contract", () => {
    const payload = Buffer.from(JSON.stringify(readFixture("valid-basic.json")), "utf8");
    const result = parseGuestMessagePayload(payload);

    expect(result).toMatchObject({
      ok: true,
      record: {
        name: "Ada Lovelace",
        message: "Hello from the radio desk"
      }
    });
  });
});
