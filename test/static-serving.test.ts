import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createGuestbookServer, type GuestbookServer } from "../src/guestbook-server.js";
import { createStaticFileHandler } from "../src/static-file-server.js";
import { createServer, type Server } from "node:http";
import { once } from "node:events";

const servers: GuestbookServer[] = [];
const rawServers: Server[] = [];

let tempRoot: string;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "guestbook-static-test-"));
});

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.server.closeAllConnections();
    await server.close();
  }
  for (const server of rawServers.splice(0)) {
    server.closeAllConnections();
    await closeRawServer(server);
  }
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("static file and API serving", () => {
  function writeWeb(): string {
    const webDir = join(tempRoot, "web");
    mkdirSync(join(webDir, "assets"), { recursive: true });
    writeFileSync(join(webDir, "index.html"), "<html><body><div id=\"root\"></div></body></html>");
    writeFileSync(join(webDir, "assets", "app.js"), "console.log('asset')");
    return webDir;
  }

  it("serves index.html with 200 text/html at the root and routes /api/guest-messages to the API", async () => {
    const { baseUrl } = await startComposedServer();

    const indexResponse = await fetch(`${baseUrl}/`);
    expect(indexResponse.status).toBe(200);
    expect(indexResponse.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await indexResponse.text()).toContain("<div id=\"root\"></div>");
    expect(indexResponse.headers.get("cache-control")).toBe("no-store");

    const apiResponse = await fetch(`${baseUrl}/api/guest-messages`);
    expect(apiResponse.status).toBe(200);
    expect(apiResponse.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await apiResponse.json()).toEqual({ messages: [] });
  });

  it("serves an asset with the correct MIME type", async () => {
    const { baseUrl } = await startComposedServer();

    const assetResponse = await fetch(`${baseUrl}/assets/app.js`);
    expect(assetResponse.status).toBe(200);
    expect(assetResponse.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(await assetResponse.text()).toContain("console.log('asset')");
    expect(assetResponse.headers.get("cache-control")).toContain("max-age");
  });

  it("returns a sane error (no traversal leakage) for a path escaping the root", async () => {
    const { baseUrl } = await startComposedServer();

    const escape = await fetch(`${baseUrl}/../../secret.txt`);
    expect(escape.status).toBe(404);
    expect(await escape.text()).not.toContain("secret");
  });

  it("returns a 404 for a null-byte request without leaking content", async () => {
    const { baseUrl } = await startComposedServer();
    const nullByte = await rawHttpRequest(
      baseUrl,
      "GET /%00secret.txt HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"
    );
    expect(nullByte.statusLine).toContain("404");
  });

  it("does not crash on malformed percent-encoding and keeps serving afterwards", async () => {
    const { baseUrl } = await startComposedServer();

    for (const target of ["/%zz/", "/%c0%ae%c0%ae/", "/%c0/", "/%"]) {
      const malformed = await rawHttpRequest(
        baseUrl,
        `GET ${target} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`
      );
      expect(malformed.statusLine).toContain("404");
      // Sane structured error with no internal decode error or raw target echoed back.
      expect(JSON.parse(malformed.body)).toEqual({
        error: {
          code: "not_found",
          message: "Resource not found."
        }
      });
      expect(malformed.body).not.toContain("URIError");
      expect(malformed.body).not.toContain("URI malformed");
    }

    // The server process must survive the malformed requests.
    const indexResponse = await fetch(`${baseUrl}/`);
    expect(indexResponse.status).toBe(200);
    expect(indexResponse.headers.get("content-type")).toBe("text/html; charset=utf-8");
  });

  it("handles HEAD on malformed and valid static targets without crashing or leaking a body", async () => {
    const { baseUrl } = await startComposedServer();

    const malformedHead = await rawHttpRequest(
      baseUrl,
      "HEAD /%zz/ HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"
    );
    expect(malformedHead.statusLine).toContain("404");
    expect(malformedHead.body).toBe("");

    const validHead = await rawHttpRequest(
      baseUrl,
      "HEAD /assets/app.js HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"
    );
    expect(validHead.statusLine).toContain("200");
    expect(validHead.body).toBe("");

    const indexResponse = await fetch(`${baseUrl}/`);
    expect(indexResponse.status).toBe(200);
    expect(indexResponse.headers.get("content-type")).toBe("text/html; charset=utf-8");
  });

  it("keeps malformed percent-encoding off the API routes and returns sane static 404s", async () => {
    const { baseUrl } = await startComposedServer();

    for (const target of ["/api/guest-messages/%zz", "/healthz/%zz", "/%c0/api/guest-messages"]) {
      const malformed = await rawHttpRequest(
        baseUrl,
        `GET ${target} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`
      );
      expect(malformed.statusLine).toContain("404");
      expect(JSON.parse(malformed.body)).toEqual({
        error: {
          code: "not_found",
          message: "Resource not found."
        }
      });
      expect(malformed.body).not.toContain("URIError");
    }

    const indexResponse = await fetch(`${baseUrl}/`);
    expect(indexResponse.status).toBe(200);
  });

  it("returns a sane 400 for an invalid absolute-form target on the composed server and stays alive", async () => {
    const { baseUrl } = await startComposedServer();

    const invalid = await rawHttpRequest(
      baseUrl,
      "GET http://[ HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"
    );
    expect(invalid.statusLine).toContain("400");
    expect(JSON.parse(invalid.body)).toEqual({
      error: {
        code: "invalid_request_target",
        message: "Request target is not a valid URL path."
      }
    });
    // The internal URL parse error must not be echoed to the client.
    expect(invalid.body).not.toContain("Invalid URL");
    expect(invalid.body).not.toContain("URIError");

    const health = await fetch(`${baseUrl}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, status: "live" });
  });

  it("keeps /healthz and /readyz reachable", async () => {
    const { baseUrl } = await startComposedServer();

    const health = await fetch(`${baseUrl}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, status: "live" });

    const ready = await fetch(`${baseUrl}/readyz`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ ok: true, status: "ready" });
  });

  it("returns 405 in API-style JSON for non-GET/HEAD on a static path", async () => {
    const { baseUrl } = await startComposedServer();

    const post = await fetch(`${baseUrl}/`, { method: "POST" });
    expect(post.status).toBe(405);
    expect(await post.json()).toEqual({
      error: {
        code: "method_not_allowed",
        message: "Method is not allowed."
      }
    });
  });

  it("proves createStaticFileHandler rejects traversal directly", async () => {
    const webDir = writeWeb();
    const handler = createStaticFileHandler({ rootDir: webDir });
    const { baseUrl } = await startRaw(handler);

    const traversal = await fetch(`${baseUrl}/../outside.txt`);
    expect(traversal.status).toBe(404);

    const encodedTraversal = await fetch(`${baseUrl}/%2e%2e/outside.txt`);
    expect(encodedTraversal.status).toBe(404);
  });

  async function startComposedServer(): Promise<{ baseUrl: string }> {
    const webDir = writeWeb();
    const server = createGuestbookServer({
      clientDir: webDir,
      databasePath: join(tempRoot, "guestbook.sqlite3"),
      port: 0
    });
    servers.push(server);
    server.server.listen(0, "127.0.0.1");
    await once(server.server, "listening");
    const address = server.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected TCP server address.");
    }
    return { baseUrl: `http://127.0.0.1:${address.port}` };
  }
});

async function startRaw(
  handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void
): Promise<{ baseUrl: string }> {
  const server = createServer(handler);
  rawServers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected TCP server address.");
  }
  return { baseUrl: `http://127.0.0.1:${address.port}` };
}

function closeRawServer(server: Server): Promise<void> {
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

async function rawHttpRequest(baseUrl: string, raw: string): Promise<{ statusLine: string; body: string }> {
  const port = Number(new URL(baseUrl).port);
  const { createConnection } = await import("node:net");
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
      const headerEnd = data.indexOf("\r\n\r\n");
      const bodyStart = headerEnd === -1 ? data.length : headerEnd + 4;
      const headerBlock = headerEnd === -1 ? data : data.slice(0, headerEnd);
      const transferEncoding = /transfer-encoding:\s*chunked/i.test(headerBlock);
      const body = transferEncoding ? stripChunkedEncoding(data.slice(bodyStart)) : data.slice(bodyStart);
      resolve({ statusLine: data.split("\r\n")[0] ?? "", body });
    };
    socket.on("connect", () => socket.write(raw));
    socket.on("data", (chunk) => {
      data += chunk.toString("utf8");
    });
    socket.on("end", finish);
    socket.on("close", finish);
    socket.on("error", reject);
    setTimeout(finish, 2000).unref();
  });
}

function stripChunkedEncoding(body: string): string {
  const chunks: string[] = [];
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
    chunks.push(body.slice(lineEnd + 2, lineEnd + 2 + size));
    cursor = lineEnd + 2 + size + 2;
  }
  return chunks.join("");
}
