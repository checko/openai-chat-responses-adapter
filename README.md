# openai-chat-responses-adapter

A small Node.js daemon that exposes OpenAI-compatible
`POST /v1/chat/completions` and translates each request into a
`POST /v1/responses` call against an existing local sidecar
(`openai-passthrough`). It returns valid Chat Completions JSON or SSE
chunks back to the client.

The adapter is a pure protocol translator. It never reads OAuth stores,
never refreshes tokens, and never talks to OpenAI directly — all
authenticated upstream traffic stays inside the existing sidecar.

## Topology

```
client ──HTTP──▶ adapter (18891) ──HTTP──▶ sidecar (18890) ──HTTPS──▶ Codex
                  /v1/chat/completions       /v1/responses
```

## Quick start

```bash
cp .env.example .env       # fill in ADAPTER_TOKEN
./start.sh
```

In another terminal:

```bash
# non-streaming
curl -sS http://127.0.0.1:18891/v1/chat/completions \
  -H "Authorization: Bearer $ADAPTER_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "model":"gpt-5.5",
    "messages":[
      {"role":"system","content":"Reply briefly."},
      {"role":"user","content":"Hello"}
    ],
    "stream":false
  }'

# streaming
curl -N http://127.0.0.1:18891/v1/chat/completions \
  -H "Authorization: Bearer $ADAPTER_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "model":"gpt-5.5",
    "messages":[{"role":"user","content":"Hello"}],
    "stream":true,
    "stream_options":{"include_usage":true}
  }'
```

## Configuration

All configuration is via environment variables. See `.env.example`.

| Var | Default | Purpose |
|---|---|---|
| `ADAPTER_BIND` | `127.0.0.1` | Bind address |
| `ADAPTER_PORT` | `18891` | Listen port |
| `ADAPTER_TOKEN` | (required) | Client-facing bearer token |
| `RESPONSES_UPSTREAM_URL` | `http://127.0.0.1:18890/v1/responses` | Upstream sidecar |
| `RESPONSES_UPSTREAM_TOKEN` | `change-me-upstream-token` | Bearer for the sidecar (override with the real value from your environment) |
| `ADAPTER_MAX_BODY_BYTES` | `10485760` | Reject requests above this with 413 |
| `ADAPTER_REQUEST_TIMEOUT_MS` | `300000` | Per-request abort deadline |
| `ADAPTER_LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |
| `ADAPTER_ENABLE_HEALTH` | `1` | `GET /healthz` on/off |
| `ADAPTER_STRICT_OPENAI_COMPAT` | `0` | If `1`, reject unsupported request fields with 400 |

The adapter refuses to start when `ADAPTER_TOKEN` is the placeholder
`change-me` and `ADAPTER_BIND` is anything other than a loopback address.

## Endpoints

- `POST /v1/chat/completions` — main endpoint.
- `GET /healthz` — `{ ok, service, upstream }`.

`POST /v1/chat/complete` (singular) is **not** an OpenAI endpoint and
returns 404.

## Behavior invariants

These are wired into the implementation regardless of what the client
sends:

- **Upstream is always called with `stream:true`.** The Codex Responses
  upstream rejects `stream:false` with `Stream must be set to true`. For
  non-streaming clients the adapter buffers the SSE upstream and emits
  one `chat.completion` JSON.
- **Upstream is always called with `store:false`.** The adapter is
  stateless and must never ask the upstream to persist responses.
- **Streaming chunks never carry `system_fingerprint`.** The field is
  set to `"fp_passthrough"` only on the non-streaming `chat.completion`
  JSON.
- **Final streaming chunk is finish-only**: `{ delta: {}, finish_reason }`.
  Per-event tool-call deltas already carry `tool_calls[]`; the final
  chunk's only job is to set `finish_reason`.
- **`finish_reason: "tool_calls"`** is set when a function call was
  finalized via either `response.function_call_arguments.done` or
  `response.output_item.done` (item.type === `"function_call"`) and no
  later assistant text superseded it.
- **`delta.reasoning_content`** is emitted for upstream
  `response.reasoning_text.delta` and
  `response.reasoning_summary_text.delta`. It is non-standard but kept
  for DeepSeek-style clients. Reasoning content is **never** mixed into
  `delta.content`.
- **Mid-stream errors are structured.** If `response.failed` /
  `response.error` arrives:
  - before headers are flushed: the adapter responds with an
    OpenAI-shaped HTTP error JSON.
  - after streaming headers are flushed: the adapter emits
    `data: {"error": {...}}` then `data: [DONE]`. No fake
    `chat.completion.chunk` with `finish_reason: "stop"` is synthesized.
- **Upstream Content-Type is not trusted.** Any 2xx upstream response is
  parsed as Responses SSE regardless of the `Content-Type` header. (The
  Codex upstream has been observed returning SSE-framed bodies with
  `application/octet-stream`.)

## Supported request fields

| Chat Completions | Mapping |
|---|---|
| `model` | required |
| `messages[]` | system/developer → `instructions` (joined `\n\n`); user/assistant/tool → `input[]` |
| `stream` | controls adapter response mode; upstream always streams |
| `stream_options.include_usage` | when `true` and streaming, emits a usage chunk before `[DONE]` |
| `temperature`, `top_p`, `user`, `metadata`, `parallel_tool_calls` | pass-through |
| `reasoning_effort` | wrapped into `reasoning.effort` |
| `reasoning` | pass-through (overrides `reasoning_effort` if both given) |
| `response_format` | mapped to `text.format` |
| `tools` | function tools flattened (`function.name` etc. hoisted) |
| `tool_choice` | string forms pass through; `{type:"function",function:{name}}` flattened |
| `max_completion_tokens` / `max_tokens` | mapped to `max_output_tokens` (the former wins if both set) |

## Dropped / partially supported request fields

By default (`ADAPTER_STRICT_OPENAI_COMPAT=0`), the following Chat
Completions fields are silently dropped:

- `n` — Responses doesn't natively produce multiple choices in one call.
- `seed`
- `stop`
- `logprobs`
- `top_logprobs`
- `logit_bias`
- `frequency_penalty`
- `presence_penalty`
- `stream_options.*` other than `include_usage`

The following multimodal user content parts are dropped in Phase 1 (the
text and `image_url` paths work):

- `input_audio`
- `file`

With `ADAPTER_STRICT_OPENAI_COMPAT=1`, requests that include any of the
above fields receive `400 invalid_request_error`.

## Tool-call support

Phase 1 supports the **basic / single tool-call** path — exactly one
`function_call` item per upstream response. The streaming output emits
per-event `delta.tool_calls[]` chunks and ends with a finish-only chunk
carrying `finish_reason: "tool_calls"`. The non-streaming output puts the
single tool call into `message.tool_calls[0]` with `content: null`.

**Parallel tool calls** (multiple `function_call` items in one response)
are not yet validated. They will be hardened in Phase 2.

## Testing

```bash
npm test            # unit + mock-upstream integration tests
ADAPTER_LIVE_SMOKE=1 \
  ADAPTER_TOKEN=<your-adapter-token> \
  RESPONSES_UPSTREAM_URL=http://127.0.0.1:18890/v1/responses \
  RESPONSES_UPSTREAM_TOKEN=<sidecar-token> \
  npm run test:smoke   # against a real running sidecar
```

The mock upstream in `test/mock-upstream.mjs` deliberately returns SSE
bytes with `Content-Type: application/octet-stream` to reproduce the
real-world bug the spec calls out.

## What this project does NOT do

- It does not handle OpenAI OAuth or refresh-token rotation.
- It does not read or write `auth-profiles.json` or any credential file.
- It does not call OpenAI's OAuth endpoints (`auth.openai.com/...`).
- It does not modify the existing `openai-passthrough` sidecar.
- It does not implement multi-provider routing, billing, or persistence.

The existing sidecar at `127.0.0.1:18890` remains the only component
that holds OAuth credentials and talks to OpenAI / Codex.
