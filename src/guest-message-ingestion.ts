import { setTimeout as delay } from "node:timers/promises";

import {
  parseGuestMessagePayload,
  type GuestMessageRecord,
  type GuestMessageValidationError
} from "./guest-message-contract.js";
import { type GuestMessageRow, type StoreGuestMessageResult } from "./guest-message-repository.js";

export type GuestMessageIngestionLogger = Pick<Console, "error" | "info" | "warn">;

export interface RawRadioGuestMessage {
  payload: string | Buffer | unknown;
  receivedAt?: string;
}

export interface RadioGuestMessageTransportFailure {
  recoverable: true;
  error: Error;
}

export type RadioGuestMessageSourceEvent = RawRadioGuestMessage | RadioGuestMessageTransportFailure;

export interface RadioGuestMessageSource {
  readonly name: string;
  messages(): AsyncIterable<RadioGuestMessageSourceEvent>;
}

export interface GuestMessageStore {
  initialize(): StoreGuestMessageResult | { ok: true };
  insertAcceptedGuestMessage(record: GuestMessageRecord): StoreGuestMessageResult;
}

export type GuestMessageIngestionOutcome =
  | { status: "accepted"; source: string; messageKey: string; record: GuestMessageRow }
  | { status: "invalid"; source: string; error: GuestMessageValidationError }
  | { status: "duplicate"; source: string; messageKey: string; error: GuestMessageValidationError }
  | { status: "persistence_failed"; source: string; operation: "initialize" | "insert" | "list"; error: Error }
  | { status: "transport_failed"; source: string; error: Error; retryDelayMs: number; attempt: number };

export interface GuestMessageIngestionOptions {
  logger?: GuestMessageIngestionLogger;
  onOutcome?: (outcome: GuestMessageIngestionOutcome) => void | Promise<void>;
  retryDelayMs?: number;
  maxTransportRetries?: number;
}

export interface GuestMessageIngestionSummary {
  accepted: number;
  invalid: number;
  duplicate: number;
  persistenceFailed: number;
  transportFailed: number;
}

const DEFAULT_RETRY_DELAY_MS = 500;
const DEFAULT_MAX_TRANSPORT_RETRIES = 5;

export async function runGuestMessageIngestion(
  source: RadioGuestMessageSource,
  store: GuestMessageStore,
  options: GuestMessageIngestionOptions = {}
): Promise<{ outcomes: GuestMessageIngestionOutcome[]; summary: GuestMessageIngestionSummary }> {
  const logger = options.logger ?? console;
  const onOutcome = options.onOutcome;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const maxTransportRetries = options.maxTransportRetries ?? DEFAULT_MAX_TRANSPORT_RETRIES;
  const outcomes: GuestMessageIngestionOutcome[] = [];
  let transportFailures = 0;

  const initialized = store.initialize();
  if (!initialized.ok) {
    const outcome: GuestMessageIngestionOutcome = {
      status: "persistence_failed",
      source: source.name,
      operation: initialized.operation,
      error: initialized.error
    };
    logOutcome(logger, outcome);
    await notifyOutcome(logger, onOutcome, outcome);
    return { outcomes: [outcome], summary: summarize([outcome]) };
  }

  for await (const event of source.messages()) {
    if (isTransportFailure(event)) {
      transportFailures += 1;
      const outcome: GuestMessageIngestionOutcome = {
        status: "transport_failed",
        source: source.name,
        error: event.error,
        retryDelayMs,
        attempt: transportFailures
      };
      outcomes.push(outcome);
      logOutcome(logger, outcome);
      await notifyOutcome(logger, onOutcome, outcome);

      if (transportFailures >= maxTransportRetries) {
        break;
      }

      await delay(retryDelayMs);
      continue;
    }

    transportFailures = 0;
    const parsed = parseGuestMessagePayload(
      event.payload,
      event.receivedAt === undefined ? {} : { receivedAt: event.receivedAt }
    );
    if (!parsed.ok) {
      const outcome: GuestMessageIngestionOutcome = { status: "invalid", source: source.name, error: parsed.error };
      outcomes.push(outcome);
      logOutcome(logger, outcome);
      await notifyOutcome(logger, onOutcome, outcome);
      continue;
    }

    const inserted = store.insertAcceptedGuestMessage(parsed.record);
    if (!inserted.ok) {
      const outcome: GuestMessageIngestionOutcome = {
        status: "persistence_failed",
        source: source.name,
        operation: inserted.operation,
        error: inserted.error
      };
      outcomes.push(outcome);
      logOutcome(logger, outcome);
      await notifyOutcome(logger, onOutcome, outcome);
      continue;
    }

    if (inserted.status === "duplicate") {
      const outcome: GuestMessageIngestionOutcome = {
        status: "duplicate",
        source: source.name,
        messageKey: inserted.messageKey,
        error: inserted.error
      };
      outcomes.push(outcome);
      logOutcome(logger, outcome);
      await notifyOutcome(logger, onOutcome, outcome);
      continue;
    }

    const outcome: GuestMessageIngestionOutcome = {
      status: "accepted",
      source: source.name,
      messageKey: inserted.record.messageKey,
      record: inserted.record
    };
    outcomes.push(outcome);
    logOutcome(logger, outcome);
    await notifyOutcome(logger, onOutcome, outcome);
  }

  return { outcomes, summary: summarize(outcomes) };
}

export function summarize(outcomes: readonly GuestMessageIngestionOutcome[]): GuestMessageIngestionSummary {
  return outcomes.reduce<GuestMessageIngestionSummary>(
    (summary, outcome) => {
      switch (outcome.status) {
        case "accepted":
          summary.accepted += 1;
          break;
        case "invalid":
          summary.invalid += 1;
          break;
        case "duplicate":
          summary.duplicate += 1;
          break;
        case "persistence_failed":
          summary.persistenceFailed += 1;
          break;
        case "transport_failed":
          summary.transportFailed += 1;
          break;
      }

      return summary;
    },
    { accepted: 0, invalid: 0, duplicate: 0, persistenceFailed: 0, transportFailed: 0 }
  );
}

export function isTransportFailure(event: RadioGuestMessageSourceEvent): event is RadioGuestMessageTransportFailure {
  return isRecord(event) && event.recoverable === true && event.error instanceof Error;
}

function logOutcome(logger: GuestMessageIngestionLogger, outcome: GuestMessageIngestionOutcome): void {
  switch (outcome.status) {
    case "accepted":
      logger.info("Guest message accepted.", {
        status: outcome.status,
        source: outcome.source,
        messageKey: outcome.messageKey
      });
      break;
    case "invalid":
      logger.warn("Guest message rejected.", {
        status: outcome.status,
        source: outcome.source,
        category: outcome.error.category,
        field: outcome.error.field
      });
      break;
    case "duplicate":
      logger.info("Guest message duplicate rejected.", {
        status: outcome.status,
        source: outcome.source,
        messageKey: outcome.messageKey,
        category: outcome.error.category
      });
      break;
    case "persistence_failed":
      logger.error("Guest message persistence failed.", {
        status: outcome.status,
        source: outcome.source,
        operation: outcome.operation,
        error: outcome.error.message
      });
      break;
    case "transport_failed":
      logger.warn("Guest message transport failed.", {
        status: outcome.status,
        source: outcome.source,
        attempt: outcome.attempt,
        retryDelayMs: outcome.retryDelayMs,
        error: outcome.error.message
      });
      break;
  }
}

async function notifyOutcome(
  logger: GuestMessageIngestionLogger,
  onOutcome: GuestMessageIngestionOptions["onOutcome"],
  outcome: GuestMessageIngestionOutcome
): Promise<void> {
  if (onOutcome === undefined) {
    return;
  }

  try {
    await onOutcome(outcome);
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    logger.error("Guest message ingestion outcome callback failed.", {
      status: outcome.status,
      source: outcome.source,
      error: error.message
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
