import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import type { RadioGuestMessageSource, RadioGuestMessageSourceEvent } from "./guest-message-ingestion.js";

export class ReplayGuestMessageSource implements RadioGuestMessageSource {
  readonly name = "replay";

  private readonly fixturePaths: string[];

  constructor(paths: readonly string[]) {
    this.fixturePaths = paths.flatMap(expandReplayPath);
  }

  async *messages(): AsyncIterable<RadioGuestMessageSourceEvent> {
    for (const fixturePath of this.fixturePaths) {
      yield {
        payload: readFileSync(fixturePath)
      };
    }
  }
}

export function expandReplayPath(path: string): string[] {
  const stats = statSync(path);
  if (stats.isDirectory()) {
    return readdirSync(path)
      .filter((entry) => entry.endsWith(".json"))
      .sort((left, right) => left.localeCompare(right))
      .map((entry) => join(path, entry));
  }

  if (!stats.isFile()) {
    throw new Error(`Replay path is not a regular file: ${path}`);
  }

  return [path];
}

export function replayLabel(path: string): string {
  return basename(path);
}
