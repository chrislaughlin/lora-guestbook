# Guestbook API

Issue #4 exposes accepted guestbook messages over a built-in Node HTTP server. The server uses the existing SQLite repository directly and does not add an HTTP framework dependency.

## Public message DTO

API responses and SSE events expose only public guest-visible fields:

```ts
interface PublicGuestMessage {
  id: number;
  name: string;
  message: string;
  receivedAt: string;
  storedAt: string;
}
```

`messageKey`, sender identifiers, message identifiers, database paths, stack traces, and raw payload details are never included in HTTP responses.

## Configuration

The server CLI is available after build:

```sh
npm run build
npm run serve -- --database data/guestbook.sqlite3 --host 127.0.0.1 --port 3000
```

Options:

- `--database` or `GUESTBOOK_DATABASE_PATH`: SQLite database path. Defaults to `data/guestbook.sqlite3`.
- `--host` or `GUESTBOOK_HOST`: bind host. Defaults to `127.0.0.1`.
- `--port`, `PORT`, or `GUESTBOOK_PORT`: bind port. Defaults to `3000` and must be an integer from 1 to 65535.
- `--allowed-origin` or `GUESTBOOK_ALLOWED_ORIGIN`: exact `http` or `https` origin with no path, query, or fragment.
- `--replay`: optional replay file or directory. May be repeated. Without replay paths, the server runs API-only.

## Routes

### `GET /healthz`

Returns a liveness response without touching SQLite:

```json
{ "ok": true, "status": "live" }
```

### `GET /readyz`

Checks that guestbook storage can initialize.

Ready response:

```json
{ "ok": true, "status": "ready" }
```

Unavailable response:

```json
{
  "error": {
    "code": "guestbook_not_ready",
    "message": "Guestbook storage is not ready."
  }
}
```

### `GET /api/guest-messages`

Returns stored public messages:

```json
{
  "messages": [
    {
      "id": 1,
      "name": "Ada Lovelace",
      "message": "Hello from the radio desk",
      "receivedAt": "2026-08-31T10:15:00.000Z",
      "storedAt": "2026-08-31T10:15:01.000Z"
    }
  ]
}
```

Optional query parameters:

- `limit`
- `offset`

Bounds, defaults, invalid values, and newest-first ordering are handled by `GuestMessageRepository.listGuestMessages`.

Unavailable response:

```json
{
  "error": {
    "code": "guest_messages_unavailable",
    "message": "Guest messages are unavailable."
  }
}
```

### `GET /api/guest-messages/events`

Opens a Server-Sent Events stream with no initial snapshot. Only future accepted records are emitted after they are persisted.

Each event uses:

- `event: guest-message`
- `id`: the public message `id` as a string
- `data`: a JSON `PublicGuestMessage`

## CORS and errors

`/readyz`, `/api/guest-messages`, and `/api/guest-messages/events` support browser access only when the request `Origin` exactly matches the configured allowed origin. Non-matching cross-origin requests return:

```json
{
  "error": {
    "code": "origin_not_allowed",
    "message": "Origin is not allowed."
  }
}
```

Unsupported methods return `405` with:

```json
{
  "error": {
    "code": "method_not_allowed",
    "message": "Method is not allowed."
  }
}
```

Unknown routes return `404` with:

```json
{
  "error": {
    "code": "not_found",
    "message": "Route not found."
  }
}
