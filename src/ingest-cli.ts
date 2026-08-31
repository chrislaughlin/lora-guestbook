#!/usr/bin/env node
import { DEFAULT_GUESTBOOK_DATABASE_PATH, GuestMessageRepository } from "./guest-message-repository.js";
import { runGuestMessageIngestion } from "./guest-message-ingestion.js";
import { ReplayGuestMessageSource } from "./replay-guest-message-source.js";

interface CliOptions {
  databasePath: string;
  replayPaths: string[];
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  let options: CliOptions;
  try {
    options = parseArgs(argv);
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    console.error(error.message);
    return 1;
  }

  if (options.replayPaths.length === 0) {
    console.error("At least one --replay file or directory is required until a hardware adapter is configured.");
    return 1;
  }

  const repository = new GuestMessageRepository({ databasePath: options.databasePath });
  try {
    const startup = repository.initialize();
    if (!startup.ok) {
      return 1;
    }

    const source = new ReplayGuestMessageSource(options.replayPaths);
    const result = await runGuestMessageIngestion(source, repository);
    console.info("Guest message ingestion complete.", result.summary);
    return 0;
  } finally {
    repository.close();
  }
}

export function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    databasePath: DEFAULT_GUESTBOOK_DATABASE_PATH,
    replayPaths: []
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--database") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("--database requires a file path.");
      }

      options.databasePath = value;
      index += 1;
      continue;
    }

    if (arg === "--replay") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("--replay requires a file or directory path.");
      }

      options.replayPaths.push(value);
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg ?? ""}`);
  }

  return options;
}

if (process.argv[1]?.endsWith("ingest-cli.js")) {
  process.exitCode = await main();
}
