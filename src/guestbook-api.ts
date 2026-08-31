import type { IncomingMessage, ServerResponse } from "node:http";

import type { GuestMessageRow, ListGuestMessagesOptions } from "./guest-message-repository.js";
import type { GuestbookEventBroker } from "./guestbook-events.js";

export interface PublicGuestMessage {
  id: number;
  name: string;
  message: string;
  receivedAt: string;
  storedAt: string;
}

export interface GuestbookApiRepository {
  initialize(): { ok: true } | { ok: false; operation: "initialize" | "insert" | "list"; error: Error };
  listGuestMessages(options?: ListGuestMessagesOptions):
    | { ok: true; records: GuestMessageRow[] }
    | { ok: false; operation: "initialize" | "insert" | "list"; error: Error };
}

export type GuestbookApiLogger = Pick<Console, "error">;

export interface GuestbookApiOptions {
  allowedOrigin?: string;
  broker: GuestbookEventBroker;
  logger?: GuestbookApiLogger;
  repository: GuestbookApiRepository;
}

interface JsonError {
  error: {
    code: string;
    message: string;
  };
}

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
} as const;

const CORS_ROUTE_METHODS = new Map<string, readonly string[]>([
  ["/readyz", ["GET", "OPTIONS"]],
  ["/api/guest-messages", ["GET", "OPTIONS"]],
  ["/api/guest-messages/events", ["GET", "OPTIONS"]]
]);

const ROUTE_METHODS = new Map<string, readonly string[]>([
  ["/healthz", ["GET"]],
  ...CORS_ROUTE_METHODS
]);

export function createGuestbookApi(options: GuestbookApiOptions): (request: IncomingMessage, response: ServerResponse) => void {
  const logger = options.logger ?? console;

  return (request, response) => {
    void handleRequest(request, response, {
      ...(options.allowedOrigin === undefined ? {} : { allowedOrigin: options.allowedOrigin }),
      broker: options.broker,
      logger,
      repository: options.repository
    });
  };
}

export function publicGuestMessageFromRow(row: GuestMessageRow): PublicGuestMessage {
  return {
    id: row.id,
    name: row.name,
    message: row.message,
    receivedAt: row.receivedAt,
    storedAt: row.storedAt
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: Required<Pick<GuestbookApiOptions, "broker" | "logger" | "repository">> &
    Pick<GuestbookApiOptions, "allowedOrigin">
): Promise<void> {
  const method = request.method ?? "";
  const requestUrl = parseRequestUrl(request, options.logger);
  if (requestUrl === undefined) {
    writeJson(response, 400, {
      error: {
        code: "invalid_request_target",
        message: "Request target is not a valid URL path."
      }
    });
    return;
  }
  const path = requestUrl.pathname;

  if (method === "OPTIONS" && CORS_ROUTE_METHODS.has(path)) {
    if (!allowCorsPreflight(request, response, options.allowedOrigin)) {
      writeJson(response, 403, originNotAllowed());
      return;
    }

    writeCorsPreflight(response, options.allowedOrigin);
    return;
  }

  if (CORS_ROUTE_METHODS.has(path) && !allowCorsRequest(request, response, options.allowedOrigin)) {
    writeJson(response, 403, originNotAllowed());
    return;
  }

  if (path === "/healthz") {
    if (method !== "GET") {
      writeMethodNotAllowed(response, ROUTE_METHODS.get(path));
      return;
    }

    writeJson(response, 200, { ok: true, status: "live" });
    return;
  }

  if (path === "/readyz") {
    if (method !== "GET") {
      writeMethodNotAllowed(response, ROUTE_METHODS.get(path));
      return;
    }

    const readiness = options.repository.initialize();
    if (!readiness.ok) {
      options.logger.error("Guestbook readiness check failed.", {
        operation: readiness.operation,
        error: readiness.error.message
      });
      writeJson(response, 503, {
        error: {
          code: "guestbook_not_ready",
          message: "Guestbook storage is not ready."
        }
      });
      return;
    }

    writeJson(response, 200, { ok: true, status: "ready" });
    return;
  }

  if (path === "/api/guest-messages") {
    if (method !== "GET") {
      writeMethodNotAllowed(response, ROUTE_METHODS.get(path));
      return;
    }

    const listed = options.repository.listGuestMessages(queryListOptions(requestUrl));

    if (!listed.ok) {
      options.logger.error("Guest messages list failed.", {
        operation: listed.operation,
        error: listed.error.message
      });
      writeJson(response, 500, {
        error: {
          code: "guest_messages_unavailable",
          message: "Guest messages are unavailable."
        }
      });
      return;
    }

    writeJson(response, 200, { messages: listed.records.map(publicGuestMessageFromRow) });
    return;
  }

  if (path === "/api/guest-messages/events") {
    if (method !== "GET") {
      writeMethodNotAllowed(response, ROUTE_METHODS.get(path));
      return;
    }

    if (!options.broker.subscribe(request, response, options.allowedOrigin)) {
      writeJson(response, 503, sseCapacityExceeded());
    }
    return;
  }

  writeJson(response, 404, {
    error: {
      code: "not_found",
      message: "Route not found."
    }
  });
}

function parseRequestUrl(
  request: IncomingMessage,
  logger: GuestbookApiLogger
): URL | undefined {
  try {
    return new URL(request.url ?? "/", "http://localhost");
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    logger.error("Guestbook API received an invalid request target.", { error: error.message });
    return undefined;
  }
}

function queryNumber(url: URL, name: string): number | undefined {
  const value = url.searchParams.get(name);
  return value === null ? undefined : Number(value);
}

function queryListOptions(url: URL): ListGuestMessagesOptions {
  const limit = queryNumber(url, "limit");
  const offset = queryNumber(url, "offset");

  return {
    ...(limit === undefined ? {} : { limit }),
    ...(offset === undefined ? {} : { offset })
  };
}

function allowCorsPreflight(
  request: IncomingMessage,
  response: ServerResponse,
  allowedOrigin: string | undefined
): allowedOrigin is string {
  const origin = request.headers.origin;
  if (allowedOrigin === undefined || origin !== allowedOrigin) {
    return false;
  }

  response.setHeader("access-control-allow-origin", allowedOrigin);
  response.setHeader("vary", "Origin");
  return true;
}

function allowCorsRequest(request: IncomingMessage, response: ServerResponse, allowedOrigin: string | undefined): boolean {
  const origin = request.headers.origin;
  if (origin === undefined) {
    return true;
  }

  if (allowedOrigin === undefined || origin !== allowedOrigin) {
    return false;
  }

  response.setHeader("access-control-allow-origin", allowedOrigin);
  response.setHeader("vary", "Origin");
  return true;
}

function writeCorsPreflight(response: ServerResponse, allowedOrigin: string | undefined): void {
  if (allowedOrigin !== undefined) {
    response.setHeader("access-control-allow-origin", allowedOrigin);
    response.setHeader("access-control-allow-methods", "GET, OPTIONS");
    response.setHeader("access-control-allow-headers", "Content-Type");
    response.setHeader("access-control-max-age", "600");
    response.setHeader("vary", "Origin");
  }

  response.writeHead(204);
  response.end();
}

function writeMethodNotAllowed(response: ServerResponse, allowedMethods: readonly string[] | undefined): void {
  if (allowedMethods !== undefined) {
    response.setHeader("allow", allowedMethods.join(", "));
  }

  writeJson(response, 405, {
    error: {
      code: "method_not_allowed",
      message: "Method is not allowed."
    }
  });
}

function writeJson(response: ServerResponse, statusCode: number, payload: Record<string, unknown> | JsonError): void {
  response.writeHead(statusCode, JSON_HEADERS);
  response.end(`${JSON.stringify(payload)}\n`);
}

function originNotAllowed(): JsonError {
  return {
    error: {
      code: "origin_not_allowed",
      message: "Origin is not allowed."
    }
  };
}

function sseCapacityExceeded(): JsonError {
  return {
    error: {
      code: "sse_capacity_exceeded",
      message: "Live update capacity is full."
    }
  };
}
