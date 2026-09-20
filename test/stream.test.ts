import { describe, expect, it } from "vitest";
import { StreamTranslator } from "../src/translate/stream.js";
import { SseDataParser } from "../src/translate/sse.js";
import type { OpenAIStreamChunk } from "../src/translate/types.js";

interface ParsedEvent {
  type: string;
  data: Record<string, unknown>;
}

function parse(events: string[]): ParsedEvent[] {
  return events.map((raw) => {
    const [eventLine, dataLine] = raw.trim().split("\n");
    return {
      type: (eventLine ?? "").replace("event: ", ""),
      data: JSON.parse((dataLine ?? "").replace("data: ", "")) as Record<string, unknown>,
    };
  });
}

function run(chunks: OpenAIStreamChunk[], model = "openai/gpt-5"): ParsedEvent[] {
  const translator = new StreamTranslator(model);
  const events: string[] = [];
  for (const chunk of chunks) events.push(...translator.chunk(chunk));
  events.push(...translator.finish());
  return parse(events);
}

describe("StreamTranslator", () => {
  it("emits the full event sequence for a text response", () => {
    const events = run([
      { id: "gen-1", choices: [{ delta: { role: "assistant", content: "Mer" } }] },
      { choices: [{ delta: { content: "haba" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 3 } },
    ]);

    expect(events.map((event) => event.type)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);

    expect(events[0]?.data.message).toMatchObject({ role: "assistant", model: "openai/gpt-5" });
    expect(events[2]?.data.delta).toEqual({ type: "text_delta", text: "Mer" });
    expect(events[5]?.data).toMatchObject({
      delta: { stop_reason: "end_turn", stop_sequence: null },
      // input_tokens is repeated because message_start went out before the
      // provider reported any usage.
      usage: { input_tokens: 10, output_tokens: 3 },
    });
  });

  it("reassembles tool arguments split across chunks into one valid block", () => {
    const events = run([
      { id: "gen-2", choices: [{ delta: { role: "assistant" } }] },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "call_1", type: "function", function: { name: "Read", arguments: "" } },
              ],
            },
          },
        ],
      },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"pa' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.txt"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ]);

    const start = events.find((event) => event.type === "content_block_start");
    expect(start?.data.content_block).toEqual({
      type: "tool_use",
      id: "call_1",
      name: "Read",
      input: {},
    });

    const delta = events.find(
      (event) =>
        event.type === "content_block_delta" &&
        (event.data.delta as { type?: string }).type === "input_json_delta",
    );
    const partial = (delta?.data.delta as { partial_json: string }).partial_json;
    expect(JSON.parse(partial)).toEqual({ path: "a.txt" });

    expect(events.at(-2)?.data).toMatchObject({ delta: { stop_reason: "tool_use" } });
  });

  it("repairs truncated tool arguments instead of emitting unparsable JSON", () => {
    const events = run([
      {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: "c1", function: { name: "Write", arguments: '{"path":' } }],
            },
          },
        ],
      },
      { choices: [{ delta: {}, finish_reason: "length" }] },
    ]);

    const delta = events.find(
      (event) =>
        event.type === "content_block_delta" &&
        (event.data.delta as { type?: string }).type === "input_json_delta",
    );
    const partial = (delta?.data.delta as { partial_json: string }).partial_json;
    expect(() => JSON.parse(partial)).not.toThrow();
    expect(JSON.parse(partial)).toEqual({});
  });

  it("gives two tool calls their own content blocks", () => {
    const events = run([
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "c1", function: { name: "Read", arguments: "{}" } },
                { index: 1, id: "c2", function: { name: "Glob", arguments: "{}" } },
              ],
            },
          },
        ],
      },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ]);

    const starts = events.filter((event) => event.type === "content_block_start");
    expect(starts).toHaveLength(2);
    expect(starts.map((event) => event.data.index)).toEqual([0, 1]);
    expect(events.filter((event) => event.type === "content_block_stop")).toHaveLength(2);
  });

  it("closes the text block before opening a tool block", () => {
    const events = run([
      { choices: [{ delta: { content: "okuyorum" } }] },
      {
        choices: [
          { delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "Read", arguments: "{}" } }] } },
        ],
      },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ]);

    const types = events.map((event) => event.type);
    expect(types.indexOf("content_block_stop")).toBeLessThan(types.lastIndexOf("content_block_start"));
  });

  it("drops reasoning deltas, which carry no Anthropic signature", () => {
    const events = run([
      { choices: [{ delta: { reasoning: "dusunuyorum" } }] },
      { choices: [{ delta: { content: "cevap" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ]);

    expect(JSON.stringify(events)).not.toContain("dusunuyorum");
    expect(events.filter((event) => event.type === "content_block_start")).toHaveLength(1);
  });

  it("produces a well-formed empty message when the upstream sends nothing", () => {
    const translator = new StreamTranslator("openai/gpt-5");
    const events = parse(translator.finish());

    expect(events.map((event) => event.type)).toEqual([
      "message_start",
      "message_delta",
      "message_stop",
    ]);
    expect(translator.isDone).toBe(true);
  });

  it("ignores chunks after the stream is finished", () => {
    const translator = new StreamTranslator("m");
    translator.finish();
    expect(translator.chunk({ choices: [{ delta: { content: "geç" } }] })).toEqual([]);
    expect(translator.finish()).toEqual([]);
  });
});

describe("SseDataParser", () => {
  it("collects data lines and skips comments and blank lines", () => {
    const parser = new SseDataParser();
    expect(parser.push(': OPENROUTER PROCESSING\n\ndata: {"a":1}\n')).toEqual(['{"a":1}']);
  });

  it("holds a line that arrives split across two chunks", () => {
    const parser = new SseDataParser();
    expect(parser.push('data: {"a"')).toEqual([]);
    expect(parser.push(':1}\ndata: [DONE]\n')).toEqual(['{"a":1}', "[DONE]"]);
  });

  it("handles CRLF line endings", () => {
    const parser = new SseDataParser();
    expect(parser.push('data: {"a":1}\r\n')).toEqual(['{"a":1}']);
  });
});
