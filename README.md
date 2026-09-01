# LoRa Guestbook

Shared contract and fixtures for a radio-backed public guestbook.

## Contract

Issue #1 defines the first stable boundary in the system: a protocol-independent guest message contract that radio ingestion, persistence, API, and UI work can share.

- Contract documentation: [docs/guest-message-contract.md](docs/guest-message-contract.md)
- Guestbook API documentation: [docs/guestbook-api.md](docs/guestbook-api.md)
- TypeScript exports: [src/guest-message-contract.ts](src/guest-message-contract.ts)
- Representative fixtures: [fixtures/guest-messages](fixtures/guest-messages)

## Persistence

Issue #2 adds SQLite storage for accepted guest records. Application code should pass an explicit database file path when opening the repository. For the local MVP, use `data/guestbook.sqlite3`; the `data/` directory is ignored so local message data is not committed.

Accepted records are inserted once by their stable `messageKey`. Duplicate inserts return a duplicate result instead of creating a second guestbook entry. Reads are bounded and ordered newest-first by `receivedAt`, with insertion order as a deterministic tie-breaker.

For a simple local backup, stop the application and copy `data/guestbook.sqlite3` to a backup location. Restore by stopping the application and replacing the database file with the backup copy.

## Ingestion

Issue #3 adds a Node ingestion runner for turning radio payloads into durable guestbook rows. Hardware-specific LoRa transport remains behind the `RadioGuestMessageSource` interface; the checked-in CLI uses replay mode so local validation does not require a radio.

Build the project, then replay one or more fixture files or a fixture directory:

```sh
npm run build
npm run ingest:replay -- --database data/guestbook.sqlite3 --replay fixtures/guest-messages/valid-basic.json
npm run ingest:replay -- --database data/guestbook.sqlite3 --replay fixtures/guest-messages
```

The ingestion runner classifies each payload as `accepted`, `invalid`, `duplicate`, `persistence_failed`, or `transport_failed`. Logs include structured status metadata and message keys where useful, but not the full guest message text by default. A database initialization failure exits non-zero so an operator can fix setup. A per-message insert failure is logged as `persistence_failed` and processing continues.

## Guestbook API

Issue #4 adds a built-in Node HTTP server for reading public guestbook messages and streaming future accepted records over Server-Sent Events. The API exposes only public fields: `id`, `name`, `message`, `receivedAt`, and `storedAt`.

Build the project, then start the server:

```sh
npm run build
npm run serve -- --database data/guestbook.sqlite3 --host 127.0.0.1 --port 3000
```

Replay input can be attached to the same server process. Accepted replay records are persisted and published to connected SSE clients after they are stored:

```sh
npm run serve -- --database data/guestbook.sqlite3 --replay fixtures/guest-messages
```

The server supports `GET /healthz`, `GET /readyz`, `GET /api/guest-messages`, and `GET /api/guest-messages/events`. Configure browser access with an exact origin such as `--allowed-origin http://localhost:5173` or `GUESTBOOK_ALLOWED_ORIGIN=http://localhost:5173`. Live update streams are capped to protect the process; configure the cap with `--max-sse-clients` or `GUESTBOOK_MAX_SSE_CLIENTS`.

## Public guestbook UI

Issue #5 adds an isolated Vite/React single-page app under `client/` that renders the public guestbook and streams new entries live over Server-Sent Events. It is view-only; public message submission is intentionally out of scope.

Build the client, then the server serves the built SPA same-origin:

```sh
cd client
npm install
npm run build
cd ..
npm run build
npm run serve -- --database data/guestbook.sqlite3
```

Now serving the SPA is on by default. Control the static directory with `--client-dir <path>` or `GUESTBOOK_CLIENT_DIR`; it defaults to `client/dist`. The backend routes (`/api/*`, `/healthz`, `/readyz`) are always handled by the API regardless of the client directory. API-only usage is preserved: if you no longer want static serving, point `--client-dir` at an empty directory or remove the built assets.

### Development workflow

Run the backend and the Vite dev server side by side:

```sh
npm run serve -- --database data/guestbook.sqlite3
cd client
npm run dev
```

Vite dev server proxies `/api` (including `/api/guest-messages/events`) to `http://localhost:3000`, so the React app talks to the backend without CORS configuration during development.

### Live updates and reconnection

New accepted entries appear automatically without a page refresh via SSE. The client dedupes by message id so a live event that overlaps the initial fetch (or a refresh) never renders twice. If the stream drops, the client reconnects automatically; on reconnect it re-fetches the latest list and merges the records published during the gap, again deduplicating by id.

## Commands

```sh
npm install
npm test
npm run typecheck
npm run build
```

The SQLite repository uses Node's built-in `node:sqlite` module and requires Node.js 24 or newer.
