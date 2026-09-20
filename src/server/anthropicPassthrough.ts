import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { Config } from "../config.js";
import { anthropicError } from "../translate/errors.js";
import { forwardableHeaders, sendJson } from "./http.js";

/**
 * Relays the request to the real Anthropic API byte for byte, including the
 * credential Claude Code sent and the anthropic-beta / anthropic-version
 * headers the gateway guide requires to be forwarded unchanged. That
 * credential never reaches OpenRouter.
 */
export async function passthroughToAnthropic(
  config: Config,
  req: IncomingMessage,
  res: ServerResponse,
  body: Buffer,
): Promise<void> {
  const url = `${config.anthropicBaseUrl}${req.url ?? "/"}`;

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: req.method ?? "POST",
      headers: forwardableHeaders(req),
      body: body.length > 0 ? body : undefined,
      // Claude Code applies its own timeouts; a stream may run for a long time.
      signal: AbortSignal.timeout(30 * 60 * 1000),
    });
  } catch (err) {
    sendJson(
      res,
      502,
      anthropicError(502, `Anthropic API'sine ulasilamadi: ${(err as Error).message}`),
    );
    return;
  }

  const headers: Record<string, string> = {};
  upstream.headers.forEach((value, name) => {
    if (name === "content-encoding" || name === "content-length" || name === "connection") return;
    headers[name] = value;
  });
  res.writeHead(upstream.status, headers);

  if (!upstream.body) {
    res.end();
    return;
  }

  // Piped rather than buffered: buffering a stream stalls Claude Code.
  Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]).pipe(res);
}
