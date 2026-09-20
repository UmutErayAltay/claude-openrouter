import { mapStopReason, mapUsage, messageId, parseToolArguments } from "./openAIToAnthropic.js";
import { sseEvent } from "./sse.js";
import type { OpenAIStreamChunk, OpenAIUsage } from "./types.js";

interface OpenBlock {
  index: number;
  kind: "text" | "tool_use";
  /** For tool blocks: the raw argument JSON seen so far. */
  argumentBuffer: string;
}

/**
 * Turns an OpenAI-shaped stream into the Anthropic event sequence Claude Code
 * expects: message_start, content_block_start/delta/stop pairs, message_delta,
 * message_stop.
 */
export class StreamTranslator {
  private started = false;
  private stopped = false;
  private nextIndex = 0;
  private open: OpenBlock | null = null;
  /** OpenAI tool_call index -> our content block. */
  private toolBlocks = new Map<number, OpenBlock>();
  private usage: OpenAIUsage | undefined;
  private finishReason: string | null | undefined;
  private id: string | undefined;

  constructor(private readonly requestedModel: string) {}

  /** True once message_stop has been emitted. */
  get isDone(): boolean {
    return this.stopped;
  }

  chunk(chunk: OpenAIStreamChunk): string[] {
    const events: string[] = [];
    if (this.stopped) return events;

    if (chunk.id && !this.id) this.id = chunk.id;
    if (chunk.usage) this.usage = chunk.usage;

    if (!this.started) {
      this.started = true;
      events.push(
        sseEvent("message_start", {
          type: "message_start",
          message: {
            id: messageId(this.id),
            type: "message",
            role: "assistant",
            model: this.requestedModel,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: chunk.usage?.prompt_tokens ?? 0, output_tokens: 0 },
          },
        }),
      );
    }

    const choice = chunk.choices?.[0];
    if (!choice) return events;

    if (choice.finish_reason) this.finishReason = choice.finish_reason;

    const delta = choice.delta;
    if (delta) {
      const text = delta.content;
      if (typeof text === "string" && text.length > 0) {
        events.push(...this.appendText(text));
      }

      for (const call of delta.tool_calls ?? []) {
        events.push(...this.appendToolCall(call));
      }
      // delta.reasoning is dropped: a thinking block without an Anthropic
      // signature is rejected when it is sent back on the next turn.
    }

    return events;
  }

  /** Emits the closing events. Safe to call more than once. */
  finish(): string[] {
    if (this.stopped) return [];
    const events: string[] = [];

    if (!this.started) {
      // The upstream closed without sending anything usable; still produce a
      // well-formed empty message so Claude Code doesn't see a broken stream.
      this.started = true;
      events.push(
        sseEvent("message_start", {
          type: "message_start",
          message: {
            id: messageId(this.id),
            type: "message",
            role: "assistant",
            model: this.requestedModel,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        }),
      );
    }

    events.push(...this.closeOpenBlock());

    // OpenRouter reports usage only in the final chunk, so message_start went
    // out with zeros; repeating input_tokens here keeps the cost readout right.
    const usage = mapUsage(this.usage);
    events.push(
      sseEvent("message_delta", {
        type: "message_delta",
        delta: { stop_reason: mapStopReason(this.finishReason), stop_sequence: null },
        usage: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens },
      }),
    );
    events.push(sseEvent("message_stop", { type: "message_stop" }));

    this.stopped = true;
    return events;
  }

  private appendText(text: string): string[] {
    const events: string[] = [];

    if (this.open?.kind !== "text") {
      events.push(...this.closeOpenBlock());
      const block: OpenBlock = { index: this.nextIndex++, kind: "text", argumentBuffer: "" };
      this.open = block;
      events.push(
        sseEvent("content_block_start", {
          type: "content_block_start",
          index: block.index,
          content_block: { type: "text", text: "" },
        }),
      );
    }

    events.push(
      sseEvent("content_block_delta", {
        type: "content_block_delta",
        index: this.open.index,
        delta: { type: "text_delta", text },
      }),
    );
    return events;
  }

  private appendToolCall(call: {
    index?: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }): string[] {
    const events: string[] = [];
    const toolIndex = call.index ?? 0;

    let block = this.toolBlocks.get(toolIndex);
    if (!block) {
      events.push(...this.closeOpenBlock());
      block = { index: this.nextIndex++, kind: "tool_use", argumentBuffer: "" };
      this.toolBlocks.set(toolIndex, block);
      this.open = block;
      events.push(
        sseEvent("content_block_start", {
          type: "content_block_start",
          index: block.index,
          content_block: {
            type: "tool_use",
            id: call.id || `toolu_${Math.random().toString(36).slice(2)}`,
            name: call.function?.name ?? "",
            input: {},
          },
        }),
      );
    } else if (this.open !== block) {
      // A provider that interleaves two tool calls: reopening isn't possible,
      // so keep appending to the block we already announced.
      this.open = block;
    }

    const args = call.function?.arguments;
    // Arguments are buffered rather than streamed through: a provider that
    // truncates mid-JSON would otherwise leave Claude Code with an unparsable
    // block that can't be retracted once its deltas are on the wire.
    if (typeof args === "string" && args.length > 0) block.argumentBuffer += args;

    return events;
  }

  private closeOpenBlock(): string[] {
    if (!this.open) return [];
    const block = this.open;
    this.open = null;

    const events: string[] = [];
    if (block.kind === "tool_use") {
      // parseToolArguments falls back to {} for truncated or malformed JSON,
      // so the block Claude Code receives always parses.
      const input = isParsableJson(block.argumentBuffer)
        ? block.argumentBuffer
        : JSON.stringify(parseToolArguments(block.argumentBuffer));
      events.push(
        sseEvent("content_block_delta", {
          type: "content_block_delta",
          index: block.index,
          delta: { type: "input_json_delta", partial_json: input },
        }),
      );
    }

    events.push(
      sseEvent("content_block_stop", { type: "content_block_stop", index: block.index }),
    );
    return events;
  }
}

function isParsableJson(value: string): boolean {
  if (value.trim() === "") return false;
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}
