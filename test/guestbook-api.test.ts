import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { createConnection } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { GuestMessageRow } from "../src/guest-message-repository.js";
import { createGuestbookApi, type GuestbookApiRepository, type GuestbookApiLogger } from "../src/guestbook-api.js";
import { GuestbookEventBroker } from "../src/guestbook-events.js";

const servers: Server[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map(closeServer));
});

describe("guestbook API", () => {
  it("returns an empty public guest message list", async () => {
    const repository = repositoryStub({ records: [] });
    const { baseUrl } = await startApi({ repository });

    const response = await fetch(`${baseUrl}/api/guest-messages`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ messages: [] });
    expect(repository.listGuestMessages).toHaveBeenCalledWith({});
  });

  it("returns public guest message DTOs without messageKey or source", async () => {
    const repository = repositoryStub({ records: [guestMessageRow()] });
    const { baseUrl } = await startApi({ repository });

    const response = await fetch(`${baseUrl}/api/guest-messages?limit=1&offset=2`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      messages: [
        {
          id: 7,
          name: "Ada Lovelace",
          message: "Hello from the radio desk",
          receivedAt: "2026-08-31T10:15:00.000Z",
          storedAt: "2026-08-31T10:15:01.000Z"
        }
      ]
    });
    expect(JSON.stringify(body)).not.toContain("messageKey");
    expect(JSON.stringify(body)).not.toContain("source");
    expect(repository.listGuestMessages).toHaveBeenCalledWith({ limit: 1, offset: 2 });
  });

  it("returns live health without touching storage", async () => {
    const repository: GuestbookApiRepository = {
      initialize: vi.fn(() => {
        throw new Error("health must not initialize SQLite");
      }),
      listGuestMessages: vi.fn(() => {
        throw new Error("health must not list SQLite");
      })
    };
    const { baseUrl } = await startApi({ repository });

    const response = await fetch(`${baseUrl}/healthz`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, status: "live" });
    expect(repository.initialize).not.toHaveBeenCalled();
    expect(repository.listGuestMessages).not.toHaveBeenCalled();
  });

  it("returns ready when storage initializes", async () => {
    const repository = repositoryStub();
    const { baseUrl } = await startApi({ repository });

    const response = await fetch(`${baseUrl}/readyz`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, status: "ready" });
    expect(repository.initialize).toHaveBeenCalledOnce();
  });

  it("returns a stable not-ready error when storage initialization fails", async () => {
    const logger: GuestbookApiLogger = { error: vi.fn(() => undefined) };
    const repository = repositoryStub({
      initializeResult: { ok: false, operation: "initialize", error: new Error("cannot open database") }
    });
    const { baseUrl } = await startApi({ logger, repository });

    const response = await fetch(`${baseUrl}/readyz`);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: {
        code: "guestbook_not_ready",
        message: "Guestbook storage is not ready."
      }
    });
    expect(logger.error).toHaveBeenCalledWith(
      "Guestbook readiness check failed.",
      expect.objectContaining({ operation: "initialize", error: "cannot open database" })
    );
  });

  it("does not emit wildcard or access-control-allow-origin headers by default", async () => {
    const { baseUrl } = await startApi({ repository: repositoryStub() });

    const sameOriginResponse = await fetch(`${baseUrl}/api/guest-messages`);
    const crossOriginResponse = await fetch(`${baseUrl}/api/guest-messages`, {
      headers: { origin: "https://guestbook.example" }
    });

    expect(sameOriginResponse.status).toBe(200);
    expect(sameOriginResponse.headers.get("access-control-allow-origin")).toBeNull();
    expect(crossOriginResponse.status).toBe(403);
    expect(crossOriginResponse.headers.get("access-control-allow-origin")).toBeNull();
    expect(crossOriginResponse.headers.get("access-control-allow-origin")).not.toBe("*");
    expect(await crossOriginResponse.json()).toEqual({
      error: {
        code: "origin_not_allowed",
        message: "Origin is not allowed."
      }
    });
  });

  it("allows only the configured exact CORS origin", async () => {
    const { baseUrl } = await startApi({
      allowedOrigin: "https://guestbook.example",
      repository: repositoryStub()
    });

    const allowed = await fetch(`${baseUrl}/api/guest-messages`, {
      headers: { origin: "https://guestbook.example" }
    });
    const rejected = await fetch(`${baseUrl}/api/guest-messages`, {
      headers: { origin: "https://other.example" }
    });
    const preflight = await fetch(`${baseUrl}/api/guest-messages`, {
      method: "OPTIONS",
      headers: { origin: "https://guestbook.example" }
    });

    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://guestbook.example");
    expect(allowed.headers.get("vary")).toBe("Origin");
    expect(rejected.status).toBe(403);
    expect(rejected.headers.get("access-control-allow-origin")).toBeNull();
    expect(await rejected.json()).toEqual({
      error: {
        code: "origin_not_allowed",
        message: "Origin is not allowed."
      }
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("https://guestbook.example");
    expect(preflight.headers.get("access-control-allow-methods")).toBe("GET, OPTIONS");
  });

  it("returns stable JSON for method-not-allowed and not-found errors", async () => {
    const { baseUrl } = await startApi({ repository: repositoryStub() });

    const methodNotAllowed = await fetch(`${baseUrl}/healthz`, { method: "POST" });
    const notFound = await fetch(`${baseUrl}/missing-route`);

    expect(methodNotAllowed.status).toBe(405);
    expect(methodNotAllowed.headers.get("allow")).toBe("GET");
    expect(await methodNotAllowed.json()).toEqual({
      error: {
        code: "method_not_allowed",
        message: "Method is not allowed."
      }
    });
    expect(notFound.status).toBe(404);
    expect(await notFound.json()).toEqual({
      error: {
        code: "not_found",
        message: "Route not found."
      }
    });
  });

  it("returns 400 for a malformed request target without crashing", async () => {
    const logger: GuestbookApiLogger = { error: vi.fn(() => undefined) };
    const { baseUrl } = await startApi({ logger, repository: repositoryStub() });
    const port = Number(new URL(baseUrl).port);

    const rawResponse = await rawHttpRequest(port, "GET http://[ HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");

    expect(rawResponse.statusLine).toContain("400");
    expect(rawResponse.body).toContain("invalid_request_target");
    expect(logger.error).toHaveBeenCalledWith(
      "Guestbook API received an invalid request target.",
      expect.objectContaining({ error: expect.any(String) })
    );

    const healthy = await fetch(`${baseUrl}/healthz`);
    expect(healthy.status).toBe(200);
    expect(await healthy.json()).toEqual({ ok: true, status: "live" });
  });

  it("streams only future accepted guest-message events and cleans up disconnected clients", async () => {
    const broker = new GuestbookEventBroker();
    const { baseUrl } = await startApi({ broker, repository: repositoryStub() });
    const controller = new AbortController();

    const response = await fetch(`${baseUrl}/api/guest-messages/events`, { signal: controller.signal });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");

    const reader = response.body?.getReader();
    if (reader === undefined) {
      throw new Error("Expected SSE response body.");
    }

    expect(await readStreamChunk(reader)).toBe(":\n\n");
    expect(clientCount(broker)).toBe(1);

    const pendingEvent = reader.read();
    await expect(Promise.race([pendingEvent.then(() => "event"), delay(25).then(() => "timeout")])).resolves.toBe(
      "timeout"
    );

    broker.publishAccepted(guestMessageRow());
    const event = await pendingEvent;
    expect(event.done).toBe(false);
    expect(decodeChunk(event.value)).toBe(
      [
        "id: 7",
        "event: guest-message",
        'data: {"id":7,"name":"Ada Lovelace","message":"Hello from the radio desk","receivedAt":"2026-08-31T10:15:00.000Z","storedAt":"2026-08-31T10:15:01.000Z"}',
        "",
        ""
      ].join("\n")
    );

    const noSecondEvent = reader.read();
    await expect(Promise.race([noSecondEvent.then(() => "event"), delay(25).then(() => "timeout")])).resolves.toBe(
      "timeout"
    );

    await expect(reader.cancel()).resolves.toBeUndefined();
    controller.abort();
    await waitFor(() => clientCount(broker) === 0);
  });

  it("rejects excess SSE clients with a stable capacity error", async () => {
    const broker = new GuestbookEventBroker({ maxClients: 1 });
    const { baseUrl } = await startApi({ broker, repository: repositoryStub() });
    const controller = new AbortController();

    const first = await fetch(`${baseUrl}/api/guest-messages/events`, { signal: controller.signal });
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");

    const reader = first.body?.getReader();
    if (reader === undefined) {
      throw new Error("Expected SSE response body.");
    }
    expect(await readStreamChunk(reader)).toBe(":\n\n");
    expect(clientCount(broker)).toBe(1);

    const rejected = await fetch(`${baseUrl}/api/guest-messages/events`);

    expect(rejected.status).toBe(503);
    expect(await rejected.json()).toEqual({
      error: {
        code: "sse_capacity_exceeded",
        message: "Live update capacity is full."
      }
    });
    expect(clientCount(broker)).toBe(1);

    await expect(reader.cancel()).resolves.toBeUndefined();
    controller.abort();
    await waitFor(() => clientCount(broker) === 0);
  });
});

interface RepositoryStubOptions {
  initializeResult?: ReturnType<GuestbookApiRepository["initialize"]>;
  records?: GuestMessageRow[];
}

function repositoryStub(options: RepositoryStubOptions = {}): GuestbookApiRepository {
  const initializeResult = options.initializeResult ?? { ok: true };
  const records = options.records ?? [];

  return {
    initialize: vi.fn((): ReturnType<GuestbookApiRepository["initialize"]> => initializeResult),
    listGuestMessages: vi.fn((): ReturnType<GuestbookApiRepository["listGuestMessages"]> => ({ ok: true, records }))
  };
}

async function startApi(options: {
  allowedOrigin?: string;
  broker?: GuestbookEventBroker;
  logger?: GuestbookApiLogger;
  repository: GuestbookApiRepository;
}): Promise<{ baseUrl: string; broker: GuestbookEventBroker }> {
  const broker = options.broker ?? new GuestbookEventBroker();
  const server = createServer(
    createGuestbookApi({
      ...(options.allowedOrigin === undefined ? {} : { allowedOrigin: options.allowedOrigin }),
      broker,
      logger: options.logger ?? { error: vi.fn(() => undefined) },
      repository: options.repository
    })
  );
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected TCP server address.");
  }

  return { baseUrl: `http://127.0.0.1:${address.port}`, broker };
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

function guestMessageRow(): GuestMessageRow {
  return {
    id: 7,
    messageKey: "secret-message-key",
    name: "Ada Lovelace",
    message: "Hello from the radio desk",
    receivedAt: "2026-08-31T10:15:00.000Z",
    storedAt: "2026-08-31T10:15:01.000Z",
    source: {
      senderId: "node-7",
      messageId: "packet-0001"
    }
  };
}

async function readStreamChunk(
  reader: ReadableStreamDefaultReader<Uint8Array<ArrayBufferLike>>
): Promise<string> {
  const result = await reader.read();
  if (result.done) {
    throw new Error("Expected stream chunk.");
  }

  return decodeChunk(result.value);
}

function decodeChunk(value: Uint8Array<ArrayBufferLike> | undefined): string {
  if (value === undefined) {
    throw new Error("Expected stream chunk value.");
  }

  return new TextDecoder().decode(value);
}

function clientCount(broker: GuestbookEventBroker): number {
  return (broker as unknown as { clients: Set<unknown> }).clients.size;
}

async function rawHttpRequest(port: number, raw: string): Promise<{ statusLine: string; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let data = "";
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      const firstLineEnd = data.indexOf("\r\n");
      const cursor = firstLineEnd === -1 ? data.length : firstLineEnd + 2;
      const headerEnd = data.indexOf("\r\n\r\n");
      const bodyStart = headerEnd === -1 ? data.length : headerEnd + 4;
      const rawBody = data.slice(bodyStart);
      const headerBlock = data.slice(cursor, bodyStart);
      const transferEncoding = /transfer-encoding:\s*chunked/i.test(headerBlock);
      const body = transferEncoding ? stripChunkedEncoding(rawBody) : rawBody;
      resolve({ statusLine: data.slice(0, firstLineEnd), body });
    };
    socket.on("connect", () => socket.write(raw));
    socket.on("data", (chunk) => {
      data += chunk.toString("utf8");
      if (data.includes("\r\n\r\n") && !/transfer-encoding:\s*chunked/i.test(data)) {
        finish();
      }
    });
    socket.on("end", finish);
    socket.on("close", finish);
    socket.on("error", reject);
    setTimeout(finish, 2000).unref();
  });
}

function stripChunkedEncoding(body: string): string {
  const lines: string[] = [];
  let cursor = 0;
  while (cursor < body.length) {
    const lineEnd = body.indexOf("\r\n", cursor);
    if (lineEnd === -1) {
      break;
    }
    const size = Number.parseInt(body.slice(cursor, lineEnd), 16);
    if (!Number.isFinite(size) || size <= 0) {
      break;
    }
    lines.push(body.slice(lineEnd + 2, lineEnd + 2 + size));
    cursor = lineEnd + 2 + size + 2;
  }
  return lines.join("");
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) {
      return;
    }

    await delay(10);
  }

  throw new Error("Timed out waiting for predicate.");
}
