import type { EventEmitter } from 'node:events';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { Logger } from '../logger.js';
import { channelPush } from '../mcp/channel.js';
import type { PushFn } from '../watch/delivery.js';

/** A slow poll must not delay the exit for long. */
export const STOP_TIMEOUT_MS = 3_000;

export interface ServeWatch {
  start(push: PushFn | null): Promise<void>;
  stop(): Promise<void>;
}

export interface ServeDeps {
  server: McpServer;
  watch: ServeWatch;
  transport: Transport;
  log: Logger;
  /** Client side of stdio: `end` / `close` mean the client is gone. */
  stdin: EventEmitter;
  /** Emits SIGINT / SIGTERM (the process). */
  signals: EventEmitter;
  exit: (code: number) => void;
  stopTimeoutMs?: number;
}

/** `marvin-drive serve`: MCP server plus the Drive watch lifecycle (spec §3, §8.2). */
export async function serve(deps: ServeDeps): Promise<void> {
  const { server, watch, log } = deps;
  // Drive watch starts once the client is initialized (pushes before that would be lost).
  server.server.oninitialized = (): void => {
    watch.start(channelPush(server, log)).catch((err: unknown) => {
      log.error('Drive watch failed to start', { error: err });
    });
  };
  let stopping = false;
  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    const timeout = new Promise<void>((resolve) =>
      setTimeout(resolve, deps.stopTimeoutMs ?? STOP_TIMEOUT_MS).unref(),
    );
    Promise.race([watch.stop(), timeout])
      .catch((err: unknown) => {
        log.error('Drive watch failed to stop cleanly', { error: err });
      })
      .finally(() => deps.exit(0));
  };
  deps.stdin.once('end', shutdown);
  deps.stdin.once('close', shutdown);
  deps.signals.once('SIGINT', shutdown);
  deps.signals.once('SIGTERM', shutdown);
  await server.connect(deps.transport);
}
