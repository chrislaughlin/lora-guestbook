import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { DEFAULT_GUESTBOOK_DATABASE_PATH, GuestMessageRepository } from "./guest-message-repository.js";
import { runGuestMessageIngestion, type GuestMessageIngestionLogger } from "./guest-message-ingestion.js";
import { ReplayGuestMessageSource } from "./replay-guest-message-source.js";
import { createGuestbookApi } from "./guestbook-api.js";
import { GuestbookEventBroker } from "./guestbook-events.js";
import { createStaticFileHandler } from "./static-file-server.js";

export const DEFAULT_GUESTBOOK_HOST = "127.0.0.1";
export const DEFAULT_GUESTBOOK_PORT = 3000;
export const DEFAULT_HTTP_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_HTTP_KEEP_ALIVE_TIMEOUT_MS = 5_000;

export type GuestbookServerLogger = GuestMessageIngestionLogger;

export interface GuestbookServerOptions {
  allowedOrigin?: string;
  clientDir?: string;
  databasePath?: string;
  host?: string;
  logger?: GuestbookServerLogger;
  maxSseClients?: number;
  port?: number;
  replayPaths?: readonly string[];
  sseDrainTimeoutMs?: number;
}

export interface GuestbookServer {
  broker: GuestbookEventBroker;
  close(): Promise<void>;
  repository: GuestMessageRepository;
  server: Server;
  start(): Promise<void>;
}

export function createGuestbookServer(options: GuestbookServerOptions = {}): GuestbookServer {
  const logger = options.logger ?? console;
  const repository = new GuestMessageRepository({
    databasePath: options.databasePath ?? DEFAULT_GUESTBOOK_DATABASE_PATH,
    logger
  });
  const broker = new GuestbookEventBroker({
    ...(options.maxSseClients === undefined ? {} : { maxClients: options.maxSseClients }),
    ...(options.sseDrainTimeoutMs === undefined ? {} : { drainTimeoutMs: options.sseDrainTimeoutMs })
  });
  const apiHandler = createGuestbookApi({
    ...(options.allowedOrigin === undefined ? {} : { allowedOrigin: options.allowedOrigin }),
    broker,
    logger,
    repository
  });

  let requestHandler: (request: IncomingMessage, response: ServerResponse) => void = apiHandler;
  if (options.clientDir !== undefined) {
    const staticHandler = createStaticFileHandler({ rootDir: options.clientDir });
    requestHandler = composeApiAndStatic(apiHandler, staticHandler);
  }

  const server = createServer(requestHandler);
  server.requestTimeout = DEFAULT_HTTP_REQUEST_TIMEOUT_MS;
  server.headersTimeout = DEFAULT_HTTP_REQUEST_TIMEOUT_MS;
  server.keepAliveTimeout = DEFAULT_HTTP_KEEP_ALIVE_TIMEOUT_MS;

  const host = options.host ?? DEFAULT_GUESTBOOK_HOST;
  const port = options.port ?? DEFAULT_GUESTBOOK_PORT;

  return {
    broker,
    repository,
    server,
    async start() {
      await listen(server, port, host);
      const replayPaths = options.replayPaths ?? [];
      if (replayPaths.length > 0) {
        void runReplayIngestion(replayPaths, repository, broker, logger).catch((cause: unknown) => {
          const error = cause instanceof Error ? cause : new Error(String(cause));
          logger.error("Guest message replay ingestion failed.", { error: error.message });
        });
      }
    },
    async close() {
      broker.close();
      await closeServer(server);
      repository.close();
    }
  };
}

type RequestHandler = (request: IncomingMessage, response: ServerResponse) => void;

const API_ROUTE_PATHS = new Set<string>([
  "/api/guest-messages",
  "/api/guest-messages/events",
  "/healthz",
  "/readyz"
]);

function composeApiAndStatic(apiHandler: RequestHandler, staticHandler: RequestHandler): RequestHandler {
  return (request, response) => {
    const method = request.method ?? "";
    let url: URL;
    try {
      url = new URL(request.url ?? "/", "http://localhost");
    } catch {
      apiHandler(request, response);
      return;
    }

    if (API_ROUTE_PATHS.has(url.pathname)) {
      apiHandler(request, response);
      return;
    }

    if (method !== "GET" && method !== "HEAD") {
      writeStaticMethodNotAllowed(response);
      return;
    }

    staticHandler(request, response);
  };
}

function writeStaticMethodNotAllowed(response: ServerResponse): void {
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.writeHead(405);
  response.end(
    `${JSON.stringify({
      error: {
        code: "method_not_allowed",
        message: "Method is not allowed."
      }
    })}\n`
  );
}

async function runReplayIngestion(
  replayPaths: readonly string[],
  repository: GuestMessageRepository,
  broker: GuestbookEventBroker,
  logger: GuestbookServerLogger
): Promise<void> {
  const source = new ReplayGuestMessageSource(replayPaths);
  const result = await runGuestMessageIngestion(source, repository, {
    logger,
    onOutcome(outcome) {
      if (outcome.status === "accepted") {
        broker.publishAccepted(outcome.record);
      }
    }
  });
  logger.info("Guest message replay ingestion complete.", result.summary);
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }

    server.close((error) => {
      if (error === undefined) {
        resolve();
        return;
      }

      reject(error);
    });
  });
}
