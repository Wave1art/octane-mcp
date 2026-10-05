import { readFileSync } from "node:fs";
import { EnvHttpProxyAgent, type Dispatcher } from "undici";

export interface DispatcherOptions {
  verifySsl: boolean;
  caCertPath?: string;
  timeoutMs: number;
}

/**
 * Build the undici dispatcher used for every Octane request.
 *
 * - Honours HTTP_PROXY / HTTPS_PROXY / NO_PROXY (Node's fetch ignores them by default).
 * - TLS settings are scoped to this dispatcher. We never touch
 *   NODE_TLS_REJECT_UNAUTHORIZED, which would weaken every TLS connection in the process.
 */
export function createDispatcher(opts: DispatcherOptions): Dispatcher {
  const connect: Record<string, unknown> = {
    rejectUnauthorized: opts.verifySsl,
    timeout: opts.timeoutMs,
  };
  if (opts.caCertPath) {
    connect.ca = readFileSync(opts.caCertPath, "utf8");
  }
  return new EnvHttpProxyAgent({
    connect,
    headersTimeout: opts.timeoutMs,
    bodyTimeout: opts.timeoutMs,
  });
}
