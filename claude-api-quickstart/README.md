# Claude API quickstart

One request to the Claude Messages API (`POST /v1/messages`) using the official
TypeScript SDK, `@anthropic-ai/sdk`. Node 24 runs the `.ts` file directly.

## 1. Get an API key

1. Sign in at <https://platform.claude.com> (the Claude Platform console).
2. Add billing under **Settings → Billing**. API use is billed per token,
   separately from a Claude.ai subscription.
3. Create a key under **Settings → API keys**. It starts with `sk-ant-` and is
   shown once.

Keep the key out of code, git, and chat. Put it in an environment variable:

```bash
export ANTHROPIC_API_KEY=...   # or add it to your shell profile / a secrets manager
```

## 2. Run it

```bash
npm install
node quickstart.ts "Explain prompt caching in one paragraph."
```

Expected output: Claude's answer, then a line with the model, the token counts,
and the stop reason.

## What the script does

- **Model:** `claude-opus-5-5`, with `output_config.effort: "medium"`.
  Thinking is always on for this model, and effort controls how hard it
  thinks.
- **Refusal fallback:** `fallbacks: "default"` (beta
  `server-side-fallback-2026-07-01`). If a safety classifier declines the
  request, the API re-runs it on the model Anthropic recommends for that
  refusal category, inside the same call.
- **Stop reason first:** checks `stop_reason` before reading `content`.
  `"refusal"` means the request was declined; `"max_tokens"` means the answer
  was cut off.
- **Typed errors:** 401 (bad key), 403, 429, 400, and other API errors are
  caught with the SDK's typed error classes. The SDK retries 429s, 5xx errors,
  and connection errors twice on its own.

Pricing for Claude Opus 5.5: $4 per million input tokens, $20 per million
output tokens. A question like the one above costs a fraction of a cent.

Next steps: streaming (`client.messages.stream(...)`), tool use, and prompt
caching. See <https://platform.claude.com/docs>.
