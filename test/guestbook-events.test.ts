import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { GuestMessageRow } from "../src/guest-message-repository.js";
import { GuestbookEventBroker } from "../src/guestbook-events.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("guestbook event broker", () => {
  it("closes and removes SSE clients that stay backpressured past the drain timeout", async () => {
    const broker = new GuestbookEventBroker({ drainTimeoutMs: 5 });
    const request = createRequestDouble();
    const { chunks, destroy, response } = createResponseDouble([true, false]);

    expect(broker.subscribe(request as unknown as IncomingMessage, response as unknown as ServerResponse, undefined)).toBe(
      true
    );
    expect(chunks).toEqual([":\n\n"]);
    expect(clientCount(broker)).toBe(1);

    broker.publishAccepted(guestMessageRow());

    expect(chunks.at(-1)).toContain("event: guest-message");
    expect(destroy).not.toHaveBeenCalled();
    expect(clientCount(broker)).toBe(1);

    await waitFor(() => response.destroyed);

    expect(destroy).toHaveBeenCalledOnce();
    expect(clientCount(broker)).toBe(0);
    expect(response.listenerCount("drain")).toBe(0);
  });
});

interface RequestDouble extends EventEmitter {
  socket: {
    setTimeout: ReturnType<typeof vi.fn>;
  };
}

interface ResponseDouble extends EventEmitter {
  destroyed: boolean;
  destroy(): ServerResponse;
  flushHeaders(): void;
  setHeader(name: string, value: number | readonly string[] | string): ServerResponse;
  write(chunk: string): boolean;
  writeHead(statusCode: number, headers?: Record<string, number | readonly string[] | string>): ServerResponse;
}

function createRequestDouble(): RequestDouble {
  return Object.assign(new EventEmitter(), {
    socket: {
      setTimeout: vi.fn()
    }
  });
}

function createResponseDouble(writeResults: boolean[]): {
  chunks: string[];
  destroy: ReturnType<typeof vi.fn>;
  response: ResponseDouble;
} {
  const chunks: string[] = [];
  const response = Object.assign(new EventEmitter(), {
    destroyed: false,
    flushHeaders: vi.fn(() => undefined),
    setHeader: vi.fn(() => response as unknown as ServerResponse),
    write: vi.fn((chunk: string) => {
      chunks.push(chunk);
      return writeResults.shift() ?? true;
    }),
    writeHead: vi.fn(() => response as unknown as ServerResponse)
  }) as unknown as Omit<ResponseDouble, "destroy"> & Partial<Pick<ResponseDouble, "destroy">>;
  const destroy = vi.fn(() => {
    response.destroyed = true;
    response.emit("close");
    return response as unknown as ServerResponse;
  });
  response.destroy = destroy;

  return { chunks, destroy, response: response as ResponseDouble };
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

function clientCount(broker: GuestbookEventBroker): number {
  return (broker as unknown as { clients: Map<unknown, unknown> }).clients.size;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) {
      return;
    }

    await delay(5);
  }

  throw new Error("Timed out waiting for predicate.");
}
