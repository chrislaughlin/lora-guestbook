import type { IncomingMessage, ServerResponse } from "node:http";

import type { GuestMessageRow } from "./guest-message-repository.js";
import { publicGuestMessageFromRow, type PublicGuestMessage } from "./guestbook-api.js";

export const DEFAULT_MAX_SSE_CLIENTS = 100;
export const DEFAULT_SSE_DRAIN_TIMEOUT_MS = 2_000;

export interface GuestbookEventBrokerOptions {
  maxClients?: number;
  drainTimeoutMs?: number;
}

interface GuestbookEventClient {
  drainHandler: (() => void) | undefined;
  drainTimer: NodeJS.Timeout | undefined;
  pending: string[];
}

export class GuestbookEventBroker {
  private readonly clients = new Map<ServerResponse, GuestbookEventClient>();
  private readonly drainTimeoutMs: number;
  private readonly maxClients: number;

  constructor(options: GuestbookEventBrokerOptions = {}) {
    this.maxClients = normalizeNonNegativeInteger(
      options.maxClients,
      DEFAULT_MAX_SSE_CLIENTS,
      "maxClients"
    );
    this.drainTimeoutMs = normalizeNonNegativeInteger(
      options.drainTimeoutMs,
      DEFAULT_SSE_DRAIN_TIMEOUT_MS,
      "drainTimeoutMs"
    );
  }

  subscribe(request: IncomingMessage, response: ServerResponse, allowedOrigin: string | undefined): boolean {
    if (this.clients.size >= this.maxClients) {
      return false;
    }

    if (allowedOrigin !== undefined) {
      response.setHeader("access-control-allow-origin", allowedOrigin);
      response.setHeader("vary", "Origin");
    }

    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no"
    });
    response.flushHeaders();

    request.socket.setTimeout(0);
    this.clients.set(response, {
      drainHandler: undefined,
      drainTimer: undefined,
      pending: []
    });

    const remove = () => {
      this.removeClient(response);
    };
    request.once("close", remove);
    response.once("close", remove);
    this.writeToClient(response, ":\n\n");
    return true;
  }

  publishAccepted(row: GuestMessageRow): void {
    this.publish(publicGuestMessageFromRow(row));
  }

  close(): void {
    for (const client of [...this.clients.keys()]) {
      this.closeLaggingClient(client);
    }
  }

  private publish(message: PublicGuestMessage): void {
    const payload = [
      `id: ${String(message.id)}`,
      "event: guest-message",
      `data: ${JSON.stringify(message)}`,
      "",
      ""
    ].join("\n");

    for (const client of [...this.clients.keys()]) {
      this.writeToClient(client, payload);
    }
  }

  private writeToClient(client: ServerResponse, payload: string): void {
    const state = this.clients.get(client);
    if (state === undefined) {
      return;
    }

    if (state.drainTimer !== undefined) {
      state.pending.push(payload);
      return;
    }

    if (client.destroyed) {
      this.removeClient(client);
      return;
    }

    let flushed: boolean;
    try {
      flushed = client.write(payload);
    } catch {
      this.closeLaggingClient(client);
      return;
    }

    if (flushed) {
      return;
    }

    this.startDrainWatch(client);
  }

  private startDrainWatch(client: ServerResponse): void {
    const state = this.clients.get(client);
    if (state === undefined) {
      return;
    }

    const flush = () => {
      const current = this.clients.get(client);
      if (current === undefined) {
        return;
      }

      if (current.drainTimer !== undefined) {
        clearTimeout(current.drainTimer);
      }
      current.drainTimer = undefined;
      current.drainHandler = undefined;

      while (current.pending.length > 0 && current.drainTimer === undefined) {
        const pendingPayload = current.pending[0] as string;
        this.writeToClient(client, pendingPayload);
        if (current.drainTimer !== undefined) {
          break;
        }
        current.pending.shift();
      }
    };
    const drainTimer = setTimeout(() => {
      this.closeLaggingClient(client);
    }, this.drainTimeoutMs);
    drainTimer.unref();

    state.drainHandler = flush;
    state.drainTimer = drainTimer;
    client.once("drain", flush);
  }

  private removeClient(client: ServerResponse): void {
    const state = this.clients.get(client);
    if (state === undefined) {
      return;
    }

    if (state.drainTimer !== undefined) {
      clearTimeout(state.drainTimer);
    }
    if (state.drainHandler !== undefined) {
      client.off("drain", state.drainHandler);
    }
    this.clients.delete(client);
  }

  private closeLaggingClient(client: ServerResponse): void {
    this.removeClient(client);
    client.destroy();
  }
}

function normalizeNonNegativeInteger(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) {
    return fallback;
  }

  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }

  return value;
}
