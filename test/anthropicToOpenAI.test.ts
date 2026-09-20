import { describe, expect, it } from "vitest";
import { anthropicToOpenAI, systemToText } from "../src/translate/anthropicToOpenAI.js";
import type { AnthropicRequest } from "../src/translate/types.js";

const entry = { id: "openai/gpt-5" };

function build(overrides: Partial<AnthropicRequest> = {}): AnthropicRequest {
  return {
    model: "openai/gpt-5",
    max_tokens: 1000,
    messages: [{ role: "user", content: "merhaba" }],
    ...overrides,
  };
}

describe("anthropicToOpenAI", () => {
  it("turns a system block array into a single system message", () => {
    const result = anthropicToOpenAI(
      build({
        system: [
          { type: "text", text: "sen bir asistansin", cache_control: { type: "ephemeral" } },
          { type: "text", text: "kurallar" },
        ],
      }),
      entry,
    );

    expect(result.messages[0]).toEqual({
      role: "system",
      content: "sen bir asistansin\n\nkurallar",
    });
    expect(JSON.stringify(result)).not.toContain("cache_control");
  });

  it("drops Anthropic-only request fields", () => {
    const result = anthropicToOpenAI(
      build({
        thinking: { type: "enabled", budget_tokens: 10000 },
        effort: "high",
        context_management: { edits: [] },
        metadata: { user_id: "x" },
      }),
      entry,
    ) as unknown as Record<string, unknown>;

    expect(result.thinking).toBeUndefined();
    expect(result.effort).toBeUndefined();
    expect(result.context_management).toBeUndefined();
    expect(result.metadata).toBeUndefined();
  });

  it("converts tool_use into assistant tool_calls", () => {
    const result = anthropicToOpenAI(
      build({
        messages: [
          { role: "user", content: "dosyayi oku" },
          {
            role: "assistant",
            content: [
              { type: "text", text: "okuyorum" },
              { type: "tool_use", id: "toolu_1", name: "Read", input: { path: "a.txt" } },
            ],
          },
        ],
      }),
      entry,
    );

    const assistant = result.messages[1];
    expect(assistant?.role).toBe("assistant");
    expect(assistant?.content).toBe("okuyorum");
    expect(assistant?.tool_calls).toEqual([
      { id: "toolu_1", type: "function", function: { name: "Read", arguments: '{"path":"a.txt"}' } },
    ]);
  });

  it("converts tool_result into a tool message that precedes the user text", () => {
    const result = anthropicToOpenAI(
      build({
        messages: [
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "toolu_1", content: "dosya icerigi" },
              { type: "text", text: "devam et" },
            ],
          },
        ],
      }),
      entry,
    );

    expect(result.messages[0]).toEqual({
      role: "tool",
      tool_call_id: "toolu_1",
      content: "dosya icerigi",
    });
    expect(result.messages[1]).toEqual({ role: "user", content: "devam et" });
  });

  it("marks a failed tool result as an error", () => {
    const result = anthropicToOpenAI(
      build({
        messages: [
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "t1", content: "izin yok", is_error: true },
            ],
          },
        ],
      }),
      entry,
    );

    expect(result.messages[0]?.content).toBe("Error: izin yok");
  });

  it("turns a base64 image into a data url part", () => {
    const result = anthropicToOpenAI(
      build({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "bu ne?" },
              { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } },
            ],
          },
        ],
      }),
      entry,
    );

    expect(result.messages[0]?.content).toEqual([
      { type: "text", text: "bu ne?" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
    ]);
  });

  it("drops thinking blocks, which carry Anthropic-only signatures", () => {
    const result = anthropicToOpenAI(
      build({
        messages: [
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "gizli", signature: "abc" },
              { type: "text", text: "cevap" },
            ],
          },
        ],
      }),
      entry,
    );

    expect(result.messages[0]?.content).toBe("cevap");
    expect(JSON.stringify(result)).not.toContain("gizli");
  });

  it("delivers a mid-conversation system turn as a user turn", () => {
    const result = anthropicToOpenAI(
      build({
        system: "ana sistem istemi",
        messages: [
          { role: "user", content: "selam" },
          { role: "system", content: "<system-reminder>bugun 2026</system-reminder>" },
          { role: "assistant", content: "merhaba" },
        ],
      }),
      entry,
    );

    // Only the leading system message stays system; providers that reject a
    // later one would otherwise fail the whole request.
    expect(result.messages.map((message) => message.role)).toEqual([
      "system",
      "user",
      "user",
      "assistant",
    ]);
    expect(result.messages[2]?.content).toBe("<system-reminder>bugun 2026</system-reminder>");
  });

  it("delivers a block-form system turn as a user turn too", () => {
    const result = anthropicToOpenAI(
      build({
        messages: [
          { role: "system", content: [{ type: "text", text: "hatirlatma" }] },
        ],
      }),
      entry,
    );

    expect(result.messages).toEqual([{ role: "user", content: "hatirlatma" }]);
  });

  it("maps tools and tool_choice", () => {
    const result = anthropicToOpenAI(
      build({
        tools: [
          {
            name: "Read",
            description: "dosya oku",
            input_schema: { type: "object", properties: { path: { type: "string" } } },
          },
          { name: "web_search", type: "web_search_20250305" },
        ],
        tool_choice: { type: "any" },
      }),
      entry,
    );

    // The server-side tool with no input_schema can't run on OpenRouter.
    expect(result.tools).toHaveLength(1);
    expect(result.tools?.[0]?.function.name).toBe("Read");
    expect(result.tools?.[0]?.function.parameters).toEqual({
      type: "object",
      properties: { path: { type: "string" } },
    });
    expect(result.tool_choice).toBe("required");
  });

  it("maps a named tool_choice", () => {
    const result = anthropicToOpenAI(
      build({
        tools: [{ name: "Read", input_schema: { type: "object" } }],
        tool_choice: { type: "tool", name: "Read" },
      }),
      entry,
    );

    expect(result.tool_choice).toEqual({ type: "function", function: { name: "Read" } });
  });

  it("caps max_tokens at the model's output limit", () => {
    const result = anthropicToOpenAI(build({ max_tokens: 64000 }), {
      id: "openai/gpt-5",
      maxOutputTokens: 8192,
    });

    expect(result.max_tokens).toBe(8192);
  });

  it("asks for usage when streaming", () => {
    const result = anthropicToOpenAI(build({ stream: true }), entry);
    expect(result.stream).toBe(true);
    expect(result.stream_options).toEqual({ include_usage: true });
  });

  it("omits upstream streaming when the model is configured without it", () => {
    const result = anthropicToOpenAI(build({ stream: true }), {
      id: "openai/gpt-5",
      stream: false,
    });

    expect(result.stream).toBeUndefined();
    expect(result.stream_options).toBeUndefined();
  });

  it("sends the OpenRouter id, not the id Claude Code asked for", () => {
    const result = anthropicToOpenAI(build({ model: "openai/gpt-5[1m]" }), entry);
    expect(result.model).toBe("openai/gpt-5");
  });
});

describe("systemToText", () => {
  it("passes a plain string through", () => {
    expect(systemToText("merhaba")).toBe("merhaba");
  });

  it("returns an empty string when there is no system prompt", () => {
    expect(systemToText(undefined)).toBe("");
  });
});
