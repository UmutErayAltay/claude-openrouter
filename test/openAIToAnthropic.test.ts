import { describe, expect, it } from "vitest";
import {
  mapStopReason,
  mapUsage,
  openAIToAnthropic,
  parseToolArguments,
} from "../src/translate/openAIToAnthropic.js";

describe("openAIToAnthropic", () => {
  it("builds a text response", () => {
    const result = openAIToAnthropic(
      {
        id: "gen-1",
        choices: [{ message: { role: "assistant", content: "merhaba" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 12, completion_tokens: 4 },
      },
      "openai/gpt-5",
    );

    expect(result.type).toBe("message");
    expect(result.model).toBe("openai/gpt-5");
    expect(result.content).toEqual([{ type: "text", text: "merhaba" }]);
    expect(result.stop_reason).toBe("end_turn");
    expect(result.usage).toEqual({ input_tokens: 12, output_tokens: 4 });
  });

  it("builds tool_use blocks alongside text", () => {
    const result = openAIToAnthropic(
      {
        choices: [
          {
            message: {
              content: "okuyorum",
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "Read", arguments: '{"path":"a.txt"}' },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
      "openai/gpt-5",
    );

    expect(result.content).toEqual([
      { type: "text", text: "okuyorum" },
      { type: "tool_use", id: "call_1", name: "Read", input: { path: "a.txt" } },
    ]);
    expect(result.stop_reason).toBe("tool_use");
  });

  it("always returns at least one content block", () => {
    const result = openAIToAnthropic({ choices: [{ message: { content: "" } }] }, "m");
    expect(result.content).toEqual([{ type: "text", text: "" }]);
  });

  it("prefixes the id so it looks like an Anthropic message id", () => {
    expect(openAIToAnthropic({ id: "gen-abc" }, "m").id).toBe("msg_genabc");
    expect(openAIToAnthropic({ id: "msg_keep" }, "m").id).toBe("msg_keep");
  });
});

describe("mapStopReason", () => {
  it("maps each finish reason", () => {
    expect(mapStopReason("stop")).toBe("end_turn");
    expect(mapStopReason("length")).toBe("max_tokens");
    expect(mapStopReason("tool_calls")).toBe("tool_use");
    expect(mapStopReason("function_call")).toBe("tool_use");
    expect(mapStopReason("content_filter")).toBe("stop_sequence");
    expect(mapStopReason(null)).toBe("end_turn");
  });
});

describe("mapUsage", () => {
  it("defaults to zero when the provider omits usage", () => {
    expect(mapUsage(undefined)).toEqual({ input_tokens: 0, output_tokens: 0 });
  });
});

describe("parseToolArguments", () => {
  it("parses well-formed JSON", () => {
    expect(parseToolArguments('{"a":1}')).toEqual({ a: 1 });
  });

  it("falls back to an empty object for truncated or empty JSON", () => {
    expect(parseToolArguments('{"a":')).toEqual({});
    expect(parseToolArguments("")).toEqual({});
    expect(parseToolArguments(undefined)).toEqual({});
  });
});
