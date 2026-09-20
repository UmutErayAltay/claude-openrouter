/** Formats one Anthropic-style server-sent event. */
export function sseEvent(type: string, data: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

export const PING_EVENT = sseEvent("ping", { type: "ping" });

/**
 * Incremental parser for the `data:` lines of an SSE stream. Keeps a buffer so
 * a chunk that splits a line mid-way is handled correctly.
 */
export class SseDataParser {
  private buffer = "";

  /** Returns the complete `data:` payloads contained in this chunk. */
  push(chunk: string): string[] {
    this.buffer += chunk;
    const payloads: string[] = [];
    let newline = this.buffer.indexOf("\n");

    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      // Comment lines (": OPENROUTER PROCESSING") and blank lines carry no data.
      if (line.startsWith("data:")) {
        const payload = line.slice(5).trim();
        if (payload) payloads.push(payload);
      }
      newline = this.buffer.indexOf("\n");
    }

    return payloads;
  }
}
