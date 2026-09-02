import { createReadStream, existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, normalize, resolve, sep } from "node:path";

export interface StaticFileServerOptions {
  defaultHeaders?: Record<string, string>;
  fallback?: string;
  rootDir: string;
}

const MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

const DEFAULT_MIME_TYPE = "application/octet-stream";
const LONG_CACHED_ASSET_PREFIX = "/assets/";

export type StaticFileHandler = (request: IncomingMessage, response: ServerResponse) => void;

export function createStaticFileHandler(options: StaticFileServerOptions): StaticFileHandler {
  const rootDir = resolve(options.rootDir);
  const fallback = options.fallback ?? "index.html";

  return (request, response) => {
    void handleStaticRequest(request, response, {
      defaultHeaders: options.defaultHeaders,
      fallback,
      rootDir
    });
  };
}

async function handleStaticRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: { defaultHeaders: Record<string, string> | undefined; fallback: string; rootDir: string }
): Promise<void> {
  const method = request.method ?? "";
  if (method !== "GET" && method !== "HEAD") {
    writeStaticJson(response, 405, {
      error: {
        code: "method_not_allowed",
        message: "Method is not allowed."
      }
    });
    return;
  }

  const pathname = parseRequestPath(request);
  if (pathname === undefined) {
    writeStaticJson(response, 404, {
      error: {
        code: "not_found",
        message: "Resource not found."
      }
    });
    return;
  }

  const resolved = resolvePathWithinRoot(options.rootDir, pathname);
  if (resolved === undefined) {
    writeStaticJson(response, 404, {
      error: {
        code: "not_found",
        message: "Resource not found."
      }
    });
    return;
  }

  let filePath: string;
  if (isFileLike(pathname)) {
    filePath = resolved;
    if (!isExistingFile(filePath)) {
      writeStaticJson(response, 404, {
        error: {
          code: "not_found",
          message: "Resource not found."
        }
      });
      return;
    }
  } else {
    const indexCandidate = resolve(options.rootDir, options.fallback);
    if (isExistingFile(indexCandidate)) {
      filePath = indexCandidate;
    } else {
      writeStaticJson(response, 404, {
        error: {
          code: "not_found",
          message: "Resource not found."
        }
      });
      return;
    }
  }

  serveFile(request, response, filePath, pathname, options.defaultHeaders);
}

function parseRequestPath(request: IncomingMessage): string | undefined {
  let url: URL;
  try {
    url = new URL(request.url ?? "/", "http://localhost");
  } catch {
    return undefined;
  }
  const pathname = url.pathname;
  if (pathname.includes("\u0000")) {
    return undefined;
  }
  return pathname;
}

function resolvePathWithinRoot(rootDir: string, pathname: string): string | undefined {
  // Reject null bytes and traversal attempts early.
  if (pathname.includes("..")) {
    return undefined;
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // Malformed percent-encoding (e.g. "%zz", "%c0") — treat as unresolvable.
    return undefined;
  }

  if (decoded.includes("\u0000") || decoded.includes("..")) {
    return undefined;
  }

  const candidate = normalize(decoded);
  if (candidate.includes("..")) {
    return undefined;
  }

  const absoluteCandidate = resolve(rootDir, `.${sep}${candidate.replace(/^\/+/, "")}`);
  const rootPrefix = rootDir.endsWith(sep) ? rootDir : `${rootDir}${sep}`;
  if (absoluteCandidate !== rootDir && !absoluteCandidate.startsWith(rootPrefix)) {
    return undefined;
  }

  return absoluteCandidate;
}

function isFileLike(pathname: string): boolean {
  const lastSegment = pathname.split("/").pop() ?? "";
  return extname(lastSegment) !== "";
}

function isExistingFile(filePath: string): boolean {
  try {
    return existsSync(filePath) && statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function serveFile(
  request: IncomingMessage,
  response: ServerResponse,
  filePath: string,
  pathname: string,
  defaultHeaders: Record<string, string> | undefined
): void {
  if (defaultHeaders !== undefined) {
    for (const [name, value] of Object.entries(defaultHeaders)) {
      response.setHeader(name, value);
    }
  }

  response.setHeader("content-type", MIME_TYPES[extname(filePath).toLowerCase()] ?? DEFAULT_MIME_TYPE);

  if (pathname.startsWith(LONG_CACHED_ASSET_PREFIX)) {
    response.setHeader("cache-control", "public, max-age=31536000, immutable");
  } else if (pathname === "/") {
    response.setHeader("cache-control", "no-store");
  } else if (!isFileLike(pathname)) {
    response.setHeader("cache-control", "no-store");
  }

  if (request.method === "HEAD") {
    response.writeHead(200);
    response.end();
    return;
  }

  const stream = createReadStream(filePath);
  stream.on("error", () => {
    if (!response.headersSent) {
      writeStaticJson(response, 500, {
        error: {
          code: "internal_error",
          message: "Resource could not be served."
        }
      });
    } else {
      response.destroy();
    }
  });
  response.writeHead(200);
  stream.pipe(response);
}

function writeStaticJson(response: ServerResponse, statusCode: number, payload: Record<string, unknown>): void {
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.writeHead(statusCode);
  response.end(`${JSON.stringify(payload)}\n`);
}
