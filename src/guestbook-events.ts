import type { IncomingMessage, ServerResponse } from "node:http";

import type { GuestMessageRow } from "./guest-message-repository.js";
import { publicGuestMessageFromRow, type PublicGuestMessage } from "./guestbook-api.js";

export class GuestbookEventBroker {
  private readonly clients = new Set<ServerResponse>();

  subscribe(request: IncomingMessage, response: ServerResponse, allowedOrigin: string | undefined): void {
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

    this.clients.add(response);
    request.on("close", () => {
      this.clients.delete(response);
    });
    response.write(":\n\n");
  }

  publishAccepted(row: GuestMessageRow): void {
    this.publish(publicGuestMessageFromRow(row));
  }

  close(): void {
    for (const client of this.clients) {
      client.end();
    }
    this.clients.clear();
  }

  private publish(message: PublicGuestMessage): void {
    const payload = [
      `id: ${String(message.id)}`,
      "event: guest-message",
      `data: ${JSON.stringify(message)}`,
      "",
      ""
    ].join("\n");

    for (const client of [...this.clients]) {
      if (client.destroyed) {
        this.clients.delete(client);
        continue;
      }

      client.write(payload);
    }
  }
}
