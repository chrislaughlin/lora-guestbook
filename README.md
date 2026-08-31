# LoRa Guestbook

Shared contract and fixtures for a radio-backed public guestbook.

## Contract

Issue #1 defines the first stable boundary in the system: a protocol-independent guest message contract that radio ingestion, persistence, API, and UI work can share.

- Contract documentation: [docs/guest-message-contract.md](docs/guest-message-contract.md)
- TypeScript exports: [src/guest-message-contract.ts](src/guest-message-contract.ts)
- Representative fixtures: [fixtures/guest-messages](fixtures/guest-messages)

## Persistence

Issue #2 adds SQLite storage for accepted guest records. Application code should pass an explicit database file path when opening the repository. For the local MVP, use `data/guestbook.sqlite3`; the `data/` directory is ignored so local message data is not committed.

Accepted records are inserted once by their stable `messageKey`. Duplicate inserts return a duplicate result instead of creating a second guestbook entry. Reads are bounded and ordered newest-first by `receivedAt`, with insertion order as a deterministic tie-breaker.

For a simple local backup, stop the application and copy `data/guestbook.sqlite3` to a backup location. Restore by stopping the application and replacing the database file with the backup copy.

## Commands

```sh
npm install
npm test
npm run typecheck
npm run build
```

The SQLite repository uses Node's built-in `node:sqlite` module and requires Node.js 24 or newer.
