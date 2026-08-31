# Guest Message Contract

This contract defines the stable shape shared by the LoRa reader adapter, validation layer, database/API work, and public guestbook UI. It deliberately does not choose a radio vendor, packet framing protocol, or transport library.

## Adapter Boundary

The hardware-specific reader is responsible for converting radio frames into a UTF-8 JSON object before this contract is applied. The normalized domain record is safe for downstream application code to consume, but public renderers must still render `name` and `message` as text, never as HTML.

## Raw Payload

The canonical adapter output is a JSON object:

```json
{
  "name": "Ada Lovelace",
  "message": "Hello from the radio desk",
  "senderId": "node-7",
  "messageId": "packet-0001",
  "receivedAt": "2026-08-31T10:15:00.000Z"
}
```

Fields:

- `name`: required string, whitespace-collapsed and trimmed, 1 to 80 characters.
- `message`: required string, whitespace-collapsed and trimmed, 1 to 500 characters.
- `senderId`: optional opaque adapter identifier, 1 to 128 characters, using letters, numbers, `.`, `_`, `:`, or `-`.
- `messageId`: optional opaque adapter message identifier, 1 to 128 characters, using letters, numbers, `.`, `_`, `:`, or `-`.
- `receivedAt`: required ISO 8601 timestamp. Until a radio adapter exists, fixtures include it explicitly; an adapter may supply it at receipt time.

## Normalized Record

Accepted payloads produce:

```ts
interface GuestMessageRecord {
  name: string;
  message: string;
  messageKey: string;
  receivedAt: string;
  source: {
    senderId?: string;
    messageId?: string;
  };
}
```

`messageKey` is a deterministic SHA-256 identity. If `messageId` is present, it is the preferred identity input. Otherwise the key is derived from `senderId`, normalized `name`, normalized `message`, and normalized `receivedAt`.

Raw device identifiers are kept under `source` and should not be exposed in the public guestbook by default.

## Validation Errors

Rejected payloads return no partial record and one stable error category:

- `malformed_payload`: payload is not a JSON object or has the wrong field types.
- `invalid_encoding`: payload cannot be treated as supported UTF-8 text.
- `missing_field`: a required field is absent.
- `empty_field`: a required string is empty after trimming.
- `field_too_long`: `name` or `message` exceeds its maximum length.
- `invalid_timestamp`: `receivedAt` is not a valid timestamp.
- `invalid_identifier`: `senderId` or `messageId` is empty, too long, or contains unsupported characters.
- `duplicate_message`: a normalized `messageKey` has already been accepted.

## Duplicate Rule

The ingestion path must compare each accepted record's `messageKey` with the set of already accepted keys. A second record with the same key is classified as `duplicate_message` and must not create another guestbook entry.

## Unknown Hardware Assumptions

The exact LoRa module, packet framing, retry semantics, and sender identity source are intentionally unresolved. Future adapter work must map those details into this JSON payload without changing downstream consumers unless this contract is versioned.
