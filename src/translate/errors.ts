export interface AnthropicErrorBody {
  type: "error";
  error: { type: string; message: string };
}

export function anthropicError(status: number, message: string): AnthropicErrorBody {
  return { type: "error", error: { type: errorTypeForStatus(status), message } };
}

export function errorTypeForStatus(status: number): string {
  switch (status) {
    case 400:
      return "invalid_request_error";
    case 401:
      return "authentication_error";
    case 403:
      return "permission_error";
    case 404:
      return "not_found_error";
    case 413:
      return "request_too_large";
    case 429:
      return "rate_limit_error";
    case 529:
      return "overloaded_error";
    default:
      return status >= 500 ? "api_error" : "invalid_request_error";
  }
}

/** Turns whatever OpenRouter returned into the error shape Claude Code parses. */
export function openRouterErrorToAnthropic(status: number, body: string): AnthropicErrorBody {
  let message = body.trim();
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } | string };
    if (typeof parsed.error === "string") message = parsed.error;
    else if (parsed.error?.message) message = parsed.error.message;
  } catch {
    // Non-JSON body: keep it as-is, it is still the most useful text we have.
  }
  if (!message) message = `OpenRouter ${status} dondu.`;
  return anthropicError(status, `OpenRouter: ${message}`);
}
