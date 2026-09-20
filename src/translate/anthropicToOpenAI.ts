import type { ModelEntry } from "../config.js";
import type {
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicRequest,
  AnthropicToolResultBlock,
  AnthropicToolUseBlock,
  OpenAIContentPart,
  OpenAIMessage,
  OpenAIRequest,
  OpenAIToolCall,
} from "./types.js";

/**
 * Claude Code sends every field the Claude API accepts when it doesn't
 * recognize a model id — adaptive reasoning, effort, context management,
 * cache_control. OpenRouter models reject those, so the translation drops
 * them rather than forwarding them.
 */
export function anthropicToOpenAI(
  request: AnthropicRequest,
  entry: ModelEntry,
): OpenAIRequest {
  const messages: OpenAIMessage[] = [];

  const system = systemToText(request.system);
  if (system) messages.push({ role: "system", content: system });

  for (const message of request.messages) {
    messages.push(...convertMessage(message));
  }

  const out: OpenAIRequest = {
    model: entry.id,
    messages: mergeAdjacentSystem(messages),
  };

  const maxTokens = clampMaxTokens(request.max_tokens, entry.maxOutputTokens);
  if (maxTokens !== undefined) out.max_tokens = maxTokens;
  if (typeof request.temperature === "number") out.temperature = request.temperature;
  if (typeof request.top_p === "number") out.top_p = request.top_p;
  if (request.stop_sequences?.length) out.stop = request.stop_sequences;
  if (request.stream) {
    out.stream = true;
    out.stream_options = { include_usage: true };
  }

  if (request.tools?.length) {
    const tools = request.tools
      // Server-side tools (web_search, computer, …) have no input_schema and
      // can't be executed by OpenRouter, so they're left out.
      .filter((tool) => tool.input_schema !== undefined)
      .map((tool) => ({
        type: "function" as const,
        function: {
          name: tool.name,
          ...(tool.description ? { description: tool.description } : {}),
          parameters: (tool.input_schema ?? { type: "object", properties: {} }) as Record<
            string,
            unknown
          >,
        },
      }));
    if (tools.length) out.tools = tools;
  }

  if (out.tools && request.tool_choice) {
    const choice = toolChoiceToOpenAI(request.tool_choice);
    if (choice) out.tool_choice = choice;
  }

  return out;
}

function clampMaxTokens(
  requested: number | undefined,
  cap: number | undefined,
): number | undefined {
  if (typeof requested !== "number") return cap;
  return typeof cap === "number" ? Math.min(requested, cap) : requested;
}

function toolChoiceToOpenAI(
  choice: NonNullable<AnthropicRequest["tool_choice"]>,
): OpenAIRequest["tool_choice"] {
  switch (choice.type) {
    case "auto":
      return "auto";
    case "none":
      return "none";
    case "any":
      return "required";
    case "tool":
      return { type: "function", function: { name: choice.name } };
    default:
      return undefined;
  }
}

export function systemToText(system: AnthropicRequest["system"]): string {
  if (!system) return "";
  if (typeof system === "string") return system;
  return system
    .filter((block) => block.type === "text")
    .map((block) => String((block as { text?: unknown }).text ?? ""))
    .join("\n\n")
    .trim();
}

function convertMessage(message: AnthropicMessage): OpenAIMessage[] {
  // Claude Code sends mid-conversation reminders as "system" turns. Only the
  // leading system message is portable across OpenAI-shaped providers — some
  // reject a later one — so the rest are delivered as user turns.
  const role = message.role === "system" ? "user" : message.role;

  if (typeof message.content === "string") {
    return [{ role, content: message.content }];
  }

  // tool_result blocks must become their own `tool` messages, and they have to
  // precede the text of the same user turn for OpenAI-shaped APIs.
  const toolMessages: OpenAIMessage[] = [];
  const parts: OpenAIContentPart[] = [];
  const toolCalls: OpenAIToolCall[] = [];

  for (const block of message.content) {
    switch (block.type) {
      case "text": {
        const text = String((block as { text?: unknown }).text ?? "");
        if (text) parts.push({ type: "text", text });
        break;
      }
      case "image": {
        const url = imageBlockToUrl(block);
        if (url) parts.push({ type: "image_url", image_url: { url } });
        break;
      }
      case "tool_use": {
        const tool = block as AnthropicToolUseBlock;
        toolCalls.push({
          id: tool.id,
          type: "function",
          function: {
            name: tool.name,
            arguments: JSON.stringify(tool.input ?? {}),
          },
        });
        break;
      }
      case "tool_result": {
        toolMessages.push(toolResultMessage(block as AnthropicToolResultBlock));
        break;
      }
      // thinking / redacted_thinking carry Anthropic signatures that mean
      // nothing to another provider, so they're dropped.
      default:
        break;
    }
  }

  const messages: OpenAIMessage[] = [...toolMessages];

  if (role === "assistant") {
    if (parts.length || toolCalls.length) {
      messages.push({
        role: "assistant",
        content: textOnly(parts),
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
    }
    return messages;
  }

  if (parts.length) {
    // Keep plain strings when there is no image: some models handle the array
    // form of a single text part poorly.
    const onlyText = parts.every((part) => part.type === "text");
    messages.push({
      role,
      content: onlyText ? textOnly(parts) : parts,
    });
  }

  return messages;
}

function textOnly(parts: OpenAIContentPart[]): string {
  return parts
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function imageBlockToUrl(block: AnthropicContentBlock): string | undefined {
  const source = (block as { source?: Record<string, unknown> }).source;
  if (!source) return undefined;
  if (source.type === "url" && typeof source.url === "string") return source.url;
  if (
    source.type === "base64" &&
    typeof source.data === "string" &&
    typeof source.media_type === "string"
  ) {
    return `data:${source.media_type};base64,${source.data}`;
  }
  return undefined;
}

function toolResultMessage(block: AnthropicToolResultBlock): OpenAIMessage {
  let content = "";
  if (typeof block.content === "string") {
    content = block.content;
  } else if (Array.isArray(block.content)) {
    content = block.content
      .map((inner) => {
        if (inner.type === "text") return String((inner as { text?: unknown }).text ?? "");
        // An image inside a tool result can't ride along in a `tool` message.
        if (inner.type === "image") return "[image]";
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  if (block.is_error && content) content = `Error: ${content}`;

  return {
    role: "tool",
    tool_call_id: block.tool_use_id,
    content: content || "(bos sonuc)",
  };
}

/** A leading system message plus a system-like first user turn stays readable. */
function mergeAdjacentSystem(messages: OpenAIMessage[]): OpenAIMessage[] {
  const out: OpenAIMessage[] = [];
  for (const message of messages) {
    const previous = out[out.length - 1];
    if (
      previous &&
      previous.role === "system" &&
      message.role === "system" &&
      typeof previous.content === "string" &&
      typeof message.content === "string"
    ) {
      previous.content = `${previous.content}\n\n${message.content}`;
      continue;
    }
    out.push(message);
  }
  return out;
}
