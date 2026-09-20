import type {
  AnthropicContentBlock,
  AnthropicResponse,
  AnthropicStopReason,
  AnthropicUsage,
  OpenAIResponse,
  OpenAIUsage,
} from "./types.js";

export function mapStopReason(finishReason: string | null | undefined): AnthropicStopReason {
  switch (finishReason) {
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "stop_sequence";
    default:
      return "end_turn";
  }
}

export function mapUsage(usage: OpenAIUsage | undefined): AnthropicUsage {
  return {
    input_tokens: usage?.prompt_tokens ?? 0,
    output_tokens: usage?.completion_tokens ?? 0,
  };
}

export function messageId(id: string | undefined): string {
  if (id && id.startsWith("msg_")) return id;
  const suffix = (id ?? Math.random().toString(36).slice(2)).replace(/[^A-Za-z0-9]/g, "");
  return `msg_${suffix || "openrouter"}`;
}

export function openAIToAnthropic(
  response: OpenAIResponse,
  requestedModel: string,
): AnthropicResponse {
  const choice = response.choices?.[0];
  const content: AnthropicContentBlock[] = [];

  const text = choice?.message?.content;
  if (typeof text === "string" && text.length > 0) {
    content.push({ type: "text", text });
  }

  for (const call of choice?.message?.tool_calls ?? []) {
    content.push({
      type: "tool_use",
      id: call.id || `toolu_${Math.random().toString(36).slice(2)}`,
      name: call.function?.name ?? "",
      input: parseToolArguments(call.function?.arguments),
    });
  }

  // Claude Code expects at least one block back.
  if (content.length === 0) content.push({ type: "text", text: "" });

  return {
    id: messageId(response.id),
    type: "message",
    role: "assistant",
    model: requestedModel,
    content,
    stop_reason: mapStopReason(choice?.finish_reason),
    stop_sequence: null,
    usage: mapUsage(response.usage),
  };
}

/** Models sometimes emit malformed or empty JSON for tool arguments. */
export function parseToolArguments(args: string | undefined): unknown {
  if (!args || args.trim() === "") return {};
  try {
    const parsed = JSON.parse(args);
    return typeof parsed === "object" && parsed !== null ? parsed : { value: parsed };
  } catch {
    return {};
  }
}
