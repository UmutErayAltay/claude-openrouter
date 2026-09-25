/** The subset of the Anthropic Messages API that Claude Code actually sends. */

export interface AnthropicTextBlock {
  type: "text";
  text: string;
  cache_control?: unknown;
}

export interface AnthropicImageBlock {
  type: "image";
  source:
    | { type: "base64"; media_type: string; data: string }
    | { type: "url"; url: string };
}

export interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content?: string | AnthropicContentBlock[];
  is_error?: boolean;
}

export interface AnthropicThinkingBlock {
  type: "thinking" | "redacted_thinking";
  thinking?: string;
  signature?: string;
}

export interface AnthropicDocumentBlock {
  type: "document";
  source: { type: string; media_type?: string; data?: string; url?: string };
}

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock
  | AnthropicThinkingBlock
  | AnthropicDocumentBlock
  | { type: string; [key: string]: unknown };

export interface AnthropicMessage {
  /** Claude Code also emits "system" turns for mid-conversation reminders. */
  role: "user" | "assistant" | "system";
  content: string | AnthropicContentBlock[];
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
  type?: string;
}

export type AnthropicToolChoice =
  | { type: "auto" | "any" | "none" }
  | { type: "tool"; name: string };

export interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string | AnthropicContentBlock[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  stream?: boolean;
  tools?: AnthropicTool[];
  tool_choice?: AnthropicToolChoice;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export type AnthropicStopReason =
  | "end_turn"
  | "max_tokens"
  | "stop_sequence"
  | "tool_use";

export interface AnthropicResponse {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: AnthropicContentBlock[];
  stop_reason: AnthropicStopReason | null;
  stop_sequence: string | null;
  usage: AnthropicUsage;
}

/** The subset of the OpenAI chat-completions shape OpenRouter expects. */

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | OpenAIContentPart[] | null;
  name?: string;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

export type OpenAIContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface OpenAIRequest {
  model: string;
  messages: OpenAIMessage[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string[];
  stream?: boolean;
  stream_options?: { include_usage: boolean };
  tools?: {
    type: "function";
    function: { name: string; description?: string; parameters: Record<string, unknown> };
  }[];
  tool_choice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
  reasoning?: { effort: string };
  provider?: {
    sort?: string;
    max_price?: { prompt?: number; completion?: number };
    quantizations?: string[];
  };
}

export interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  /** Dollar cost of this request. OpenRouter includes it automatically. */
  cost?: number;
  completion_tokens_details?: { reasoning_tokens?: number };
  /** Prompt tokens served from a provider's cache, when it supports one. */
  prompt_tokens_details?: { cached_tokens?: number };
}

export interface OpenAIResponse {
  id?: string;
  model?: string;
  choices?: {
    index?: number;
    message?: {
      role?: string;
      content?: string | null;
      reasoning?: string | null;
      tool_calls?: OpenAIToolCall[];
    };
    finish_reason?: string | null;
  }[];
  usage?: OpenAIUsage;
  error?: { message?: string; code?: string | number; type?: string };
}

export interface OpenAIStreamChunk {
  id?: string;
  model?: string;
  choices?: {
    index?: number;
    delta?: {
      role?: string;
      content?: string | null;
      reasoning?: string | null;
      tool_calls?: {
        index?: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
    finish_reason?: string | null;
  }[];
  usage?: OpenAIUsage;
  error?: { message?: string; code?: string | number; type?: string };
}
