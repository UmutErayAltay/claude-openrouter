import type { AnthropicTool, OpenAIResponse, OpenAIToolCall } from "./types.js";

/**
 * Markers of a model writing a tool call into its prose instead of using the
 * tool-call channel. Several models do this under a large tool set — Qwen3
 * Coder does it on every turn of a real Claude Code session — which silently
 * breaks every tool: the call arrives as ordinary text, so nothing runs.
 */
const MARKERS = ["<tool_call", "</tool_call", "<function=", "<|tool_call", "<invoke name="];

export function looksLikeTextToolCall(text: string): boolean {
  const lowered = text.toLowerCase();
  return MARKERS.some((marker) => lowered.includes(marker));
}

export interface RecoveredCall {
  name: string;
  input: Record<string, unknown>;
}

/**
 * The Qwen/Hermes shape:
 *
 *   <function=Read>
 *   <parameter=file_path>
 *   /etc/hostname
 *   </parameter>
 *   </function>
 *
 * The closing tags are often missing or unbalanced, so the parser anchors on
 * the opening tags and reads up to the next one.
 */
const FUNCTION_BLOCK = /<function=([^>\s]+)\s*>([\s\S]*?)(?=<\/function>|<function=|$)/gi;
const PARAMETER_BLOCK = /<parameter=([^>\s]+)\s*>([\s\S]*?)(?=<\/parameter>|<parameter=|$)/gi;
/** The JSON shape: <tool_call>{"name": "...", "arguments": {...}}</tool_call> */
const JSON_BLOCK = /<tool_call>\s*(\{[\s\S]*?\})\s*(?:<\/tool_call>|$)/gi;

export function parseTextToolCalls(
  text: string,
  tools: AnthropicTool[] = [],
): { calls: RecoveredCall[]; remainingText: string } {
  const calls: RecoveredCall[] = [];
  let remaining = text;

  for (const match of text.matchAll(JSON_BLOCK)) {
    try {
      const parsed = JSON.parse(match[1] ?? "{}") as {
        name?: string;
        arguments?: Record<string, unknown>;
      };
      if (parsed.name) {
        calls.push({ name: parsed.name, input: parsed.arguments ?? {} });
        remaining = remaining.replace(match[0], "");
      }
    } catch {
      // Not the JSON shape after all; the XML pass below may still match.
    }
  }

  for (const match of text.matchAll(FUNCTION_BLOCK)) {
    const name = match[1];
    if (!name) continue;

    const input: Record<string, unknown> = {};
    for (const parameter of (match[2] ?? "").matchAll(PARAMETER_BLOCK)) {
      const key = parameter[1];
      if (!key) continue;
      input[key] = coerce(trimBlock(parameter[2] ?? ""), schemaTypeFor(tools, name, key));
    }

    calls.push({ name, input });
    remaining = remaining.replace(match[0], "");
  }

  return { calls, remainingText: stripLeftovers(remaining) };
}

function trimBlock(value: string): string {
  return value.replace(/^\r?\n/, "").replace(/\r?\n$/, "").trim();
}

function stripLeftovers(text: string): string {
  return text.replace(/<\/?tool_call>/gi, "").replace(/<\/?function>/gi, "").trim();
}

/** Parameters arrive as text, so numbers and booleans need their real type. */
function schemaTypeFor(
  tools: AnthropicTool[],
  toolName: string,
  parameter: string,
): string | undefined {
  const schema = tools.find((tool) => tool.name === toolName)?.input_schema;
  const properties = (schema as { properties?: Record<string, { type?: string }> } | undefined)
    ?.properties;
  return properties?.[parameter]?.type;
}

function coerce(value: string, type: string | undefined): unknown {
  switch (type) {
    case "number":
    case "integer": {
      const parsed = Number(value);
      return Number.isNaN(parsed) ? value : parsed;
    }
    case "boolean":
      if (value === "true") return true;
      if (value === "false") return false;
      return value;
    case "array":
    case "object":
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    default:
      return value;
  }
}

/**
 * Fills in `tool_calls` for a response whose model wrote them as prose, so the
 * rest of the pipeline sees an ordinary tool-calling response. A response that
 * already carries native tool calls is returned untouched.
 */
export function recoverToolCalls(
  response: OpenAIResponse,
  tools: AnthropicTool[] = [],
): { response: OpenAIResponse; recovered: number } {
  const choice = response.choices?.[0];
  const text = choice?.message?.content;

  if (
    !choice ||
    choice.message?.tool_calls?.length ||
    typeof text !== "string" ||
    !looksLikeTextToolCall(text)
  ) {
    return { response, recovered: 0 };
  }

  const { calls, remainingText } = parseTextToolCalls(text, tools);
  if (calls.length === 0) return { response, recovered: 0 };

  const toolCalls: OpenAIToolCall[] = calls.map((call, index) => ({
    id: `toolu_recovered_${index}_${Math.random().toString(36).slice(2, 10)}`,
    type: "function",
    function: { name: call.name, arguments: JSON.stringify(call.input) },
  }));

  return {
    response: {
      ...response,
      choices: [
        {
          ...choice,
          message: { ...choice.message, content: remainingText, tool_calls: toolCalls },
          finish_reason: "tool_calls",
        },
        ...(response.choices ?? []).slice(1),
      ],
    },
    recovered: toolCalls.length,
  };
}
