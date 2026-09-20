import { describe, expect, it } from "vitest";
import {
  looksLikeTextToolCall,
  parseTextToolCalls,
  recoverToolCalls,
} from "../src/translate/textToolCall.js";

/** The exact text Qwen3 Coder returned through OpenRouter in a real session. */
const QWEN_OUTPUT =
  "<function=Read>\n<parameter=file_path>\n/etc/hostname\n</parameter>\n</function>\n</tool_call>";

const READ_TOOL = {
  name: "Read",
  input_schema: {
    type: "object",
    properties: {
      file_path: { type: "string" },
      limit: { type: "number" },
      verbose: { type: "boolean" },
    },
  },
};

describe("looksLikeTextToolCall", () => {
  it("recognizes the formats models fall back to", () => {
    expect(looksLikeTextToolCall(QWEN_OUTPUT)).toBe(true);
    expect(looksLikeTextToolCall('<tool_call>{"name":"Read"}</tool_call>')).toBe(true);
    expect(looksLikeTextToolCall('<invoke name="Read">')).toBe(true);
  });

  it("leaves ordinary prose alone", () => {
    expect(looksLikeTextToolCall("Dosyayi okudum, icinde 'merhaba dunya' yaziyor.")).toBe(false);
    expect(looksLikeTextToolCall("")).toBe(false);
  });
});

describe("parseTextToolCalls", () => {
  it("parses the shape Qwen3 Coder produced", () => {
    const { calls, remainingText } = parseTextToolCalls(QWEN_OUTPUT, [READ_TOOL]);

    expect(calls).toEqual([{ name: "Read", input: { file_path: "/etc/hostname" } }]);
    expect(remainingText).toBe("");
  });

  it("gives parameters the type their schema declares", () => {
    const { calls } = parseTextToolCalls(
      "<function=Read>\n<parameter=file_path>\na.txt\n</parameter>\n" +
        "<parameter=limit>\n50\n</parameter>\n<parameter=verbose>\ntrue\n</parameter>\n</function>",
      [READ_TOOL],
    );

    expect(calls[0]?.input).toEqual({ file_path: "a.txt", limit: 50, verbose: true });
  });

  it("keeps a numeric-looking string as a string when the schema says string", () => {
    const { calls } = parseTextToolCalls(
      "<function=Read>\n<parameter=file_path>\n123\n</parameter>\n</function>",
      [READ_TOOL],
    );

    expect(calls[0]?.input).toEqual({ file_path: "123" });
  });

  it("parses the JSON shape", () => {
    const { calls } = parseTextToolCalls(
      '<tool_call>{"name": "Read", "arguments": {"file_path": "a.txt"}}</tool_call>',
    );

    expect(calls).toEqual([{ name: "Read", input: { file_path: "a.txt" } }]);
  });

  it("parses two calls in one message and keeps the prose around them", () => {
    const { calls, remainingText } = parseTextToolCalls(
      "Once okuyorum.\n<function=Read>\n<parameter=file_path>\na.txt\n</parameter>\n</function>\n" +
        "<function=Glob>\n<parameter=pattern>\n*.ts\n</parameter>\n</function>",
      [READ_TOOL],
    );

    expect(calls.map((call) => call.name)).toEqual(["Read", "Glob"]);
    expect(remainingText).toBe("Once okuyorum.");
  });

  it("finds nothing in ordinary prose", () => {
    expect(parseTextToolCalls("Sadece duz bir cevap.").calls).toEqual([]);
  });
});

describe("recoverToolCalls", () => {
  it("turns prose into a normal tool-calling response", () => {
    const { response, recovered } = recoverToolCalls(
      {
        id: "gen-1",
        choices: [{ message: { content: QWEN_OUTPUT }, finish_reason: "stop" }],
      },
      [READ_TOOL],
    );

    expect(recovered).toBe(1);
    const choice = response.choices?.[0];
    expect(choice?.finish_reason).toBe("tool_calls");
    expect(choice?.message?.content).toBe("");
    expect(choice?.message?.tool_calls?.[0]?.function).toMatchObject({
      name: "Read",
      arguments: '{"file_path":"/etc/hostname"}',
    });
  });

  it("leaves a response with native tool calls untouched", () => {
    const original = {
      choices: [
        {
          message: {
            content: QWEN_OUTPUT,
            tool_calls: [
              { id: "c1", type: "function" as const, function: { name: "Read", arguments: "{}" } },
            ],
          },
        },
      ],
    };

    const { response, recovered } = recoverToolCalls(original);
    expect(recovered).toBe(0);
    expect(response).toBe(original);
  });

  it("leaves an ordinary text response untouched", () => {
    const original = { choices: [{ message: { content: "merhaba" }, finish_reason: "stop" }] };
    expect(recoverToolCalls(original).recovered).toBe(0);
  });
});
