#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.js";
import { createLogger, safeErrorMessage } from "./logging.js";
import { createRuntimeAdapter } from "./runtime/create-adapter.js";
import { runBridge } from "./runner.js";
import { installShutdownHandlers } from "./shutdown.js";
import { GardenSseClient } from "./sse/client.js";
import { VERSION } from "./version.js";

const HELP = `garden-wake ${VERSION}

Usage:
  garden-wake run       Open one foreground Garden SSE connection
  garden-wake check     Validate configuration and the SSE handshake
  garden-wake --version Print the version
  garden-wake --help    Show this help
`;

export function exitCodeForError(_error: unknown): 2 {
  // Version 0.1 systemd/watchdog examples treated exit code 2 as permanent.
  // Keep every failure non-restartable so an upgraded binary cannot inherit a
  // reconnect loop from an old supervisor configuration.
  return 2;
}

export async function runCli(
  args: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const command = args[0];
  if (command === "--version" || command === "-v") {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (command === "--help" || command === "-h" || command === undefined) {
    process.stdout.write(HELP);
    return 0;
  }
  if (command !== "run" && command !== "check") {
    process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
    return 2;
  }

  let config;
  try {
    config = loadConfig(env);
  } catch (error) {
    process.stderr.write(`Configuration error: ${safeErrorMessage(error)}\n`);
    return 2;
  }

  const logger = createLogger(config.logLevel, {
    secrets: [config.machineToken],
  });
  const shutdown = new AbortController();
  const removeHandlers = installShutdownHandlers(shutdown);

  try {
    if (command === "check") {
      const checkTimer = setTimeout(
        () => shutdown.abort(new Error("connectivity check timed out")),
        config.timeouts.checkMs,
      );
      try {
        const client = new GardenSseClient({
          baseUrl: config.baseUrl,
          machineToken: config.machineToken,
          connectTimeoutMs: config.timeouts.connectMs,
          logger,
        });
        await client.probe(shutdown.signal);
        logger.info("configuration and Garden SSE handshake are valid");
      } finally {
        clearTimeout(checkTimer);
      }
      return 0;
    }

    const adapter = createRuntimeAdapter(config, logger);
    await runBridge(config, adapter, logger, shutdown.signal);
    return 0;
  } catch (error) {
    logger.error("bridge failed", {
      error: safeErrorMessage(error, [config.machineToken]),
    });
    return exitCodeForError(error);
  } finally {
    removeHandlers();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCli();
}
