# claude-openrouter (`cor`)

*[Türkçe](README.tr.md)*

Adds any model on OpenRouter to Claude Code's `/model` menu — **without touching Claude Code itself**.

The UI, commands, permission system, tools, accessibility — all stay exactly the same. The only difference is that `/model` now also lists the models you've added.

```
/model
  Default (Opus 5)
  Sonnet
  Haiku
  ...
  DeepSeek V4 Flash        ← you added this
  Qwen3 Max                ← you added this
```

## How it works

It uses Claude Code's own **LLM gateway** support. `ANTHROPIC_BASE_URL` points Claude Code at a small local proxy. The proxy speaks the Anthropic Messages API and splits requests by model:

```
Claude Code ──► cor proxy (127.0.0.1)
                    │
   claude-* / sonnet / opus / haiku ──► api.anthropic.com   (passed through unchanged)
   your added OpenRouter model      ──► openrouter.ai       (translated)
```

**Hybrid.** Pick a Claude model and the request goes straight to Anthropic — your existing login/subscription works exactly as before. Pick an OpenRouter model and the request is translated for it.

Claude Code's Anthropic credentials (OAuth token or API key) are **never** sent to OpenRouter. The proxy only listens on `127.0.0.1`.

---

## Install

Requires **Node.js 20+** and **Claude Code 2.1.242+** (for the `modelPicker` setting).

```bash
git clone https://github.com/UmutErayAltay/claude-openrouter.git
cd claude-openrouter
npm install
npm run build
npm link          # puts 'cor' on your PATH
```

If `npm link` fails on permissions, use `sudo npm link`, or run it unlinked via `node dist/cli/index.js <command>`.

Or install the published package directly:

```bash
npm install -g claude-openrouter
```

## Quick start

```bash
cor key sk-or-v1-...                    # save your OpenRouter key

cor add deepseek/deepseek-v4-flash-0731 \
  --reasoning high \
  --cheapest --quantizations fp8,bf16,fp16 \
  --behaves-as claude-sonnet-5

cor sync                                # reflect it into the /model menu
cor claude                              # start Claude Code through the proxy
```

Open Claude Code, `/model` → your added model is in the list. Pick it, use it.

Each flag is explained in detail below. Short version: `--reasoning high` turns on the model's thinking (the effect is large), `--cheapest` routes to the cheapest of the ~27 providers, `--quantizations` filters out heavily-compressed cheap providers, `--behaves-as` silences Claude Code's "unrecognized model" warning.

Every argument you pass to `cor claude` is forwarded to `claude` as-is:

```bash
cor claude --permission-mode acceptEdits
cor claude -p "run the tests"
```

If you'd rather manage the proxy yourself:

```bash
cor start
ANTHROPIC_BASE_URL=http://127.0.0.1:8787 claude
```

If something goes wrong: `cor doctor` checks every step one by one, and `~/.claude-openrouter/proxy.log` records what happened.

---

## Commands

| Command | What it does |
|---|---|
| `cor key <key>` | Save your OpenRouter key (file permission `0600`) |
| `cor add <model-id>` | Add a model. Label, description and context window are pulled from the catalog automatically |
| `cor remove <model-id>` | Remove a model |
| `cor list` | Show added models and their settings |
| `cor search <keyword>` | Search the OpenRouter catalog |
| `cor providers <model-id>` | List the providers serving a model, their price and quantization |
| `cor sync` | Write the models into `~/.claude/settings.json`'s `modelPicker` |
| `cor sync --revert` | Revert to the state before the last `sync` |
| `cor agent [model-id]` | Generate a single-file subagent |
| `cor dashboard` | Open the usage/credit and model management UI in a browser |
| `cor start` / `stop` / `status` | Manage the proxy |
| `cor claude [...]` | Start the proxy and run `claude` |
| `cor doctor` | Check the whole setup end to end |

### `cor add` options

| Option | What it does |
|---|---|
| `--label <name>` | Name shown in the `/model` menu |
| `--description <text>` | Second line in the menu |
| `--context <n>` | Real context window (tokens) |
| `--max-tokens <n>` | Output token ceiling |
| `--reasoning <level>` | `none`, `low`, `medium`, `high`, `max` |
| `--cheapest` | Route to the cheapest provider on every request |
| `--sort <metric>` | `price` (= `--cheapest`), `throughput`, `latency` |
| `--max-price-in <usd>` | Hard ceiling on $/million input tokens |
| `--max-price-out <usd>` | Hard ceiling on $/million output tokens |
| `--quantizations <list>` | Accepted quantizations, comma-separated: `fp8,bf16,fp16` |
| `--behaves-as <claude-id>` | Silences Claude Code's "unrecognized model" warning |
| `--no-stream` / `--stream` | Query OpenRouter without streaming / keep streaming on |

---

## Reasoning effort — the setting you shouldn't skip

`--reasoning` sets the model's thinking level, and **its effect is large**. DeepSeek's own model card shows V4-Flash on LiveCodeBench like this:

| Setting | Score |
|---|---|
| Thinking off | 55.2% |
| `high` | 88.4% |
| `max` | 91.6% |

If you don't set it, the provider's default applies — meaning you could unknowingly be on the top row.

**Use `high`, not `max`.** What we measured:

| Effort | max_tokens | Thinking tokens | Total output | Result |
|---|---|---|---|---|
| high | 4,000 | 1,376 | 1,672 | ✅ |
| high | 16,000 | 1,749 | 2,265 | ✅ |
| max | 4,000 | 3,999 | 4,000 | ❌ **empty response** |
| max | 16,000 | 10,544 | 12,685 | ✅ (same answer) |

`max` burns ~7x the tokens for the same answer, and under Claude Code's normal `max_tokens` budget it can spend the whole budget thinking and return nothing.

---

## Provider selection and cheapest-routing

Several providers serve the same OpenRouter model, and prices vary a lot:

```bash
cor providers deepseek/deepseek-v4-flash-0731
```

```
deepseek/deepseek-v4-flash-0731 - 27 providers (cheapest to priciest)

provider                  in $/M     out $/M    quantization      context
Relace                        0.040      0.120           fp4   1,048,576
StreamLake                    0.044      0.132           fp8   1,024,000
Baidu                         0.048      0.144           fp8   1,048,576
DeepInfra                     0.060      0.180           fp8   1,048,576
...
Cloudflare                    0.440      1.320           fp8   1,310,720

Priciest is 11.0x the cheapest.
```

Use `--cheapest` to always get the cheapest. Fallbacks stay on: if the cheapest provider is down, the next one takes over.

**Watch the quantization column.** In the example above the cheapest provider serves `fp4` — weights compressed to 4 bits, which can hurt code quality. The next one up, `fp8`, is only ~10% pricier:

```bash
cor add <model-id> --cheapest --quantizations fp8,bf16,fp16
```

Verified live: unfiltered `--cheapest` lands on the `fp4` provider; with the filter it lands on the cheapest `fp8` provider instead.

---

## Opus plans, the cheap model codes

If you want the expensive model to think and a cheap one to write: Claude Code's subagents can run their own model. `cor agent` generates a ready-made definition for this.

```bash
cor agent                                          # uses the first added model
cor agent deepseek/deepseek-v4-flash-0731 --name coder
```

Creates `.claude/agents/file-coder.md`:

```yaml
model: deepseek/deepseek-v4-flash-0731
tools: Read, Edit, Write
permissionMode: acceptEdits
maxTurns: 30
```

In use — the main session stays on Opus (or whichever Claude model you prefer):

```
> plan how to fix the auth flow
  ... Opus plans, browses files, decides ...

> apply this plan to src/auth.ts, use the file-coder subagent
  ... the cheap model just opens that file and writes it ...
```

Planning, research and architectural decisions stay with Opus; the subagent only applies the given plan to the given file and summarizes what it changed.

**A short tool list isn't a side benefit — it's the point.** Models that emit tool calls as plain text do so against Claude Code's full set of 38 tools; the same model with `Read, Edit, Write` produced native tool calls start to finish in live testing.

**How tight the single-file boundary really is:** the subagent has no Bash, Glob, or Grep — it can't search for files or run commands. But `Write` could in theory write somewhere else; what stops that is the system-prompt instruction, not a hard sandbox. For a hard boundary, add a [PreToolUse hook](https://code.claude.com/docs/en/hooks) to the subagent that checks the path.

---

## Text-mode tool-call recovery

Some models write tool calls as **plain text** instead of using OpenAI's `tool_calls` channel:

```
<function=Read>
<parameter=file_path>
/etc/hostname
</parameter>
</function>
```

Claude Code treats this as an ordinary reply, no tool runs, and the model looks broken. The proxy fixes this itself:

1. Detects mid-stream that the text is a tool call and stops forwarding the rest to Claude Code.
2. Parses it into a real `tool_use` block — parameters are coerced to the type the tool schema expects (`"50"` → `50`, `"true"` → `true`).
3. Permanently switches that model to non-streaming mode (`stream: false`), because the recovery can only be done on the full response.

No turn is lost, including the first one. What happened is written to `~/.claude-openrouter/proxy.log`. Toggle it manually with `--no-stream` / `--stream`.

Both the Qwen/Hermes XML format and the `<tool_call>{"name":...,"arguments":{...}}</tool_call>` JSON format are recognized.

---

## What the translation covers

The proxy translates between the Anthropic Messages API and OpenAI-compatible chat completions:

- System prompt, text, images (base64 → data URL)
- `tool_use` ↔ `tool_calls`, `tool_result` ↔ `tool` message, failed results get an `Error:` prefix
- Tool schemas (`input_schema` → `parameters`) and `tool_choice`
- Streaming (SSE): OpenAI chunks → `message_start` / `content_block_*` / `message_delta` / `message_stop`
- Tool arguments arriving in pieces are buffered; truncated JSON is repaired so Claude Code never sees a broken block
- A `ping` is written every 15 seconds during silent stretches while the model thinks (Claude Code cancels a stream after 300 seconds of silence)
- `stop_reason`, token counts and errors are mapped to the Anthropic shape
- Mid-conversation `system` messages are converted to `user` (many providers reject a `system` message after the first one)
- Text-mode tool calls are recovered

Stripped out: `cache_control`, `thinking` / adaptive reasoning, `effort`, `context_management`. These have to be stripped because Claude Code sends the full set of Anthropic-only fields to whatever model ID you give it; OpenRouter's own `reasoning` parameter is used for thinking instead.

---

## Dashboard

```bash
cor dashboard
```

Starts the proxy and opens `http://127.0.0.1:<port>/dashboard` (it tries to open your browser, and prints the URL either way if that fails — the expected behavior in headless/container setups). A single page, no external dependencies, no CDN:

- **Remaining credit**: live from OpenRouter's `/key` endpoint — limit, remaining, daily/weekly/monthly usage. When the key is invalid, missing, or unreachable it shows that state on its own, without breaking the rest of the dashboard.
- **Spend**: a 14-day chart, a per-model breakdown, and a recent-requests table — all read from `~/.claude-openrouter/usage.jsonl`.
- **Model management**: add, edit (reasoning, provider sort, quantizations, `behaves-as`, streaming), remove; search-to-add from the catalog; `cor sync`/`--revert` buttons.
- **Subagents**: lists the agents under `.claude/agents/` (project and user scope), flags which ones use a model you've configured, and a form to create a new one.

The mutating endpoints (add/remove a model, write an agent) only accept requests from `127.0.0.1`/`localhost` and the dashboard's own origin — so another tab you have open can't silently write to it.

---

## Files

| File | Contents |
|---|---|
| `~/.claude-openrouter/config.json` | Key, port, model list (permission `0600`) |
| `~/.claude-openrouter/proxy.log` | Proxy log |
| `~/.claude-openrouter/usage.jsonl` | Usage log the dashboard reads (auto-trimmed past 2MB) |
| `~/.claude/settings.json` | `cor sync` only writes the `modelPicker` key |
| `~/.claude/settings.json.cor-bak` | Backup from before the last `sync` |

`cor sync` never touches the rest of the file, and writes nothing if the JSON is malformed. Override the directories with `CLAUDE_OPENROUTER_DIR` and `CLAUDE_CONFIG_DIR`. The `OPENROUTER_API_KEY` environment variable takes precedence over the saved key, for when you don't want the key written to disk at all.

---

## Known limits

- **Anthropic-only features don't work on OpenRouter models:** prompt caching, extended/adaptive thinking, effort levels, `/fast` mode. The proxy strips these; use `--reasoning` for thinking instead.
- **The context window is fixed for the session.** `cor claude` sets `CLAUDE_CODE_MAX_CONTEXT_TOKENS` to the smallest context window among your added models. Claude Code reads this value at startup; it isn't updated if you switch models mid-session.
- **Reasoning output isn't shown.** OpenRouter's `reasoning` field doesn't carry an Anthropic signature, so it can't be sent back on the next turn — the model thinks, but that output isn't passed through.
- **Tool quality depends on the model.** Claude Code makes heavy use of tools. Text-mode calls are recovered, but there's no fix for a model that never calls a tool at all.
- **Auto-discovery via `/v1/models` doesn't work for most OpenRouter models.** Claude Code only pulls models from that endpoint whose ID contains `claude` or `anthropic`. The real path is the `modelPicker` list that `cor sync` writes.
- Claude Code updates can introduce new request fields. `cor doctor` and the test suite exist to catch this early.

---

## Development

```bash
npm test          # 172 unit + end-to-end tests
npm run typecheck
npm run build
```

The tests cover the translation layer (tool round-trips, images, `cache_control` stripping, `stop_reason` mapping, reasoning and provider parameters), SSE streaming (chunked tool arguments, truncated-JSON repair, two concurrent tool calls), text-mode tool-call recovery, routing, settings-file integration, and every proxy endpoint against fake upstreams.

## License

MIT
