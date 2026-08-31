# LoRa Guestbook

Shared contract and fixtures for a radio-backed public guestbook.

## Contract

Issue #1 defines the first stable boundary in the system: a protocol-independent guest message contract that radio ingestion, persistence, API, and UI work can share.

- Contract documentation: [docs/guest-message-contract.md](docs/guest-message-contract.md)
- TypeScript exports: [src/guest-message-contract.ts](src/guest-message-contract.ts)
- Representative fixtures: [fixtures/guest-messages](fixtures/guest-messages)

## Commands

```sh
npm install
npm test
npm run typecheck
npm run build
```
