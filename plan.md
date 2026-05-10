# Implementation Plan — openai-chat-responses-adapter

Date: 2026-05-10
Author: implementation planning
Spec: `OPENAI_CHAT_RESPONSES_ADAPTER_SPEC_20260509.md`
Working dir: `~/openai-chat-responses-adapter`

---

## 0. Clarifications log

- **2026-05-10 (round 2)** — three follow-up edits requested by owner:
  1. Removed the stale "Phase 2 adds tool calls" wording from the TL;DR
     and replaced it with "Phase 1 ships text + basic (single) tool-call
     translation; Phase 2 hardens parallel tool-call edge cases."
  2. Tightened §8.3 finish_reason logic to recognize `output_item.done`
     (item.type === "function_call") as a valid finalization signal,
     not just `function_call_arguments.done`.
  3. Made Phase 1 / Phase 2 scope explicit: Phase 1 = basic / single
     tool-call path only; Phase 2 = parallel `function_call` items in one
     response. README must not claim full parallel-tool-call compatibility
     until Phase 2 is green.

- **2026-05-10** — owner approved plan with five required clarifications, all
  folded into the relevant sections below:
  1. `response.output_item.done` for `function_call` is treated as a
     reconciliation/fallback source — it backfills `call_id`/`name`/
     `arguments` and emits the missing prefix-diff suffix where useful.
     See §8.2.
  2. `response.output_text.done` is a fallback — if `done.text` is a strict
     superset of what the deltas already produced, the missing suffix is
     emitted. See §8.2.
  3. `response.failed` / `response.error` handling is now split: pre-headers
     → OpenAI-shaped HTTP error JSON; post-headers → `data: {"error":{...}}`
     then `data: [DONE]`. **No fake empty chat chunk** is emitted in either
     case. See §8.5.
  4. Streaming chunks **explicitly omit** `system_fingerprint`; the key is
     not written at all. Non-streaming JSON keeps `"fp_passthrough"`.
  5. Phase 1 scope expanded to include basic tool-call support (translation
     + streaming + non-streaming) so Chat Completions compatibility is
     useful from the first delivery. See §13.

---

## 0.1 TL;DR

A small, dependency-free Node.js daemon on `127.0.0.1:18891` that translates
between OpenAI Chat Completions (`/v1/chat/completions`) and OpenAI Responses
(`/v1/responses`). It calls the already-working sidecar at
`http://127.0.0.1:18890/v1/responses` for the actual model traffic, and never
touches OAuth, refresh tokens, or `auth-profiles.json`. Because the upstream
Codex Responses backend rejects `stream:false`, the adapter **always** asks
upstream with `stream:true` and either streams the translated chunks back to
the client or buffers + collapses them into a single `chat.completion` JSON.

Phase 1 ships text + basic (single) tool-call translation and tests.
Phase 2 hardens parallel tool-call edge cases and robustness. Phase 3
adds multimodal end-to-end. Phase 4 evaluates `previous_response_id`
follow-up state.

---

## 1. Goals and non-goals (re-affirmed)

Goals:

1. OpenAI-compatible `POST /v1/chat/completions` (streaming + non-streaming).
2. Pure protocol translator. Stateless in Phase 1.
3. No OAuth code paths. Talks to the sidecar with a static bearer token.
4. Robust SSE parser that does **not** trust upstream `Content-Type`.
5. Mock-upstream tests reproducing the real-world bug where Codex returned
   SSE-framed bytes with `application/octet-stream`.
6. Live smoke test through the real sidecar at `127.0.0.1:18890`.

Non-goals (per spec §2):

- No reading/writing of OAuth stores, `auth-profiles.json`, or refresh tokens.
- No replacement of the existing sidecar's Chat Completions endpoint
  (which currently exists inline in `openai-passthrough/server.mjs` —
  this adapter supersedes that path operationally, but the sidecar code is
  not modified by this project).
- No multi-provider routing, billing, dashboard, or persistence.

---

## 2. Architecture and file layout

### 2.1 Runtime topology

```
client ──HTTP──▶ adapter (18891) ──HTTP──▶ sidecar (18890) ──HTTPS──▶ Codex
```

Adapter is a single Node.js process, listening on `ADAPTER_BIND:ADAPTER_PORT`,
talking to the sidecar via plain HTTP using `RESPONSES_UPSTREAM_TOKEN`.

### 2.2 Language and dependencies

- Node.js, ESM (`.mjs`), Node 20+ (uses built-in `fetch`, `AbortController`,
  `Response.body` as a `ReadableStream`).
- **No npm dependencies.** Built-ins only: `node:http`, `node:crypto`,
  `node:url`, `node:fs/promises`, `node:test`, `node:assert/strict`. This
  matches the existing sidecar's style and keeps the audit surface tiny.
- One `package.json` with `"type": "module"` and `scripts.test` /
  `scripts.start`.

### 2.3 File layout

```
openai-chat-responses-adapter/
├── README.md                  ← usage, env vars, dropped fields, examples
├── plan.md                    ← this file
├── OPENAI_CHAT_RESPONSES_ADAPTER_SPEC_20260509.md
├── package.json
├── .env.example
├── start.sh                   ← exports defaults, execs node server.mjs
├── server.mjs                 ← HTTP entry, routing, auth, lifecycle
├── lib/
│   ├── config.mjs             ← env parsing, startup safety check
│   ├── log.mjs                ← tiny structured logger (json or kv)
│   ├── translate-request.mjs  ← chat → responses request mapper
│   ├── translate-stream.mjs   ← responses SSE → chat SSE state machine
│   ├── translate-buffer.mjs   ← responses SSE → one chat.completion JSON
│   ├── sse-parser.mjs         ← robust SSE block parser (LF/CRLF, multi-data)
│   ├── ids.mjs                ← chatcmpl-<random> id generator
│   └── errors.mjs             ← error shape helpers
└── test/
    ├── mock-upstream.mjs      ← in-process Responses SSE server
    ├── fixtures/              ← canned SSE event sequences
    │   ├── text-simple.sse
    │   ├── text-with-usage.sse
    │   ├── tool-call.sse
    │   └── failure.sse
    ├── translate-request.test.mjs
    ├── translate-stream.test.mjs
    ├── translate-buffer.test.mjs
    ├── sse-parser.test.mjs
    ├── server.test.mjs        ← end-to-end against mock upstream
    └── smoke-live.mjs         ← opt-in live test against real sidecar
```

Rationale for the split: `server.mjs` stays small and routing-only, the three
translator modules each get their own focused unit-test file, and the SSE
parser is isolated so we can hammer it with adversarial framing inputs
without spinning up an HTTP server.

---

## 3. Configuration

Read once at startup in `lib/config.mjs`.

| Env var | Default | Notes |
|---|---|---|
| `ADAPTER_BIND` | `127.0.0.1` | |
| `ADAPTER_PORT` | `18891` | |
| `ADAPTER_TOKEN` | (required) | client bearer; refuse to start if `change-me` and bind ≠ localhost |
| `RESPONSES_UPSTREAM_URL` | `http://127.0.0.1:18890/v1/responses` | |
| `RESPONSES_UPSTREAM_TOKEN` | `change-me-upstream-token` | placeholder; override with the real sidecar token via env |
| `ADAPTER_MAX_BODY_BYTES` | `10485760` | reject larger requests with 413 |
| `ADAPTER_REQUEST_TIMEOUT_MS` | `300000` | per-request `AbortController` deadline |
| `ADAPTER_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `ADAPTER_ENABLE_HEALTH` | `1` | `/healthz` on/off |
| `ADAPTER_STRICT_OPENAI_COMPAT` | `0` | reject unsupported fields with 400 |

Startup safety: if `ADAPTER_TOKEN === "change-me"` and `ADAPTER_BIND` resolves
to a non-loopback interface, log an error and exit non-zero.

---

## 4. HTTP surface

`server.mjs` registers exactly:

- `POST /v1/chat/completions` → main handler.
- `GET  /healthz` (when enabled) → `{ ok, service, upstream }`.
- Anything else → `404` with the OpenAI-shaped error body
  (`error.type = "not_found"`).

Auth gate runs before parsing the body. Token compare uses
`crypto.timingSafeEqual` after length check (constant-time).

`OPTIONS` requests to `/v1/chat/completions` return 204 with
`Access-Control-Allow-*` headers only if `ADAPTER_CORS_ORIGIN` is set
(deferred — not in Phase 1 unless requested).

Body parsing: stream the request body, abort with 413 if it exceeds
`ADAPTER_MAX_BODY_BYTES`. Parse JSON; on error return 400 in OpenAI shape.

---

## 5. Request translation: Chat Completions → Responses

Module: `lib/translate-request.mjs`. Pure function:
`translateChatToResponses(chatBody, { strict }) → responsesBody`.

### 5.1 Top-level field mapping

| Chat Completions | Responses | Behavior |
|---|---|---|
| `model` | `model` | pass through; required |
| `messages[]` | `instructions` + `input[]` | see §5.2–§5.5 |
| `stream` | `stream: true` (always) | client value drives **adapter** response mode, not upstream |
| `temperature` | `temperature` | pass through if `typeof === "number"` |
| `top_p` | `top_p` | pass through if number |
| `user` | `user` | pass through if string |
| `metadata` | `metadata` | pass through if plain object |
| `parallel_tool_calls` | `parallel_tool_calls` | pass through if boolean |
| `reasoning_effort` | `reasoning.effort` | wrap into `{ effort }` |
| `reasoning` | `reasoning` | pass through if object (overrides `reasoning_effort` if both set) |
| `response_format` | `text.format` | see §5.6 |
| `tools` | `tools` | flatten function tools (§6) |
| `tool_choice` | `tool_choice` | convert (§6) |
| `max_tokens` / `max_completion_tokens` | `max_output_tokens` | numeric pass-through if present |
| `store` | `store: false` | **always** `false` regardless of client input — adapter is stateless, must not ask upstream to persist |

In strict mode, fields not in the table above (e.g. `n`, `seed`, `stop`,
`logprobs`, `top_logprobs`, `logit_bias`, `frequency_penalty`,
`presence_penalty`) trigger `400 invalid_request_error`. In default mode they
are silently dropped, with a `debug`-level log line listing dropped fields.

`stream_options.include_usage` is **not** sent upstream — it controls the
adapter's own emission of the trailing usage chunk.

### 5.2 `system` and `developer` → `instructions`

Concatenate the string content of every `system` and `developer` message in
the order they appear, joined with `\n\n`. Non-string content (e.g. content
arrays) on system messages: extract the `text` parts and join. If after
extraction the string is empty, omit `instructions` entirely.

### 5.3 `user` → `input[].content[]`

Each user message becomes one `input` item with `role: "user"`.

- String content → `[{ type: "input_text", text: <string> }]`.
- Array content: per part:
  - `{ type: "text", text }` → `{ type: "input_text", text }`.
  - `{ type: "image_url", image_url: { url } }` → `{ type: "input_image", image_url: <url> }`.
  - `{ type: "input_audio", ... }` → Phase 3 (drop with debug log in Phase 1).
  - `{ type: "file", ... }` → Phase 3 (drop with debug log in Phase 1).

### 5.4 `assistant` → `input[]`

Two sub-cases, possibly both in the same message:

- If `content` is non-empty (string or array of `text` parts), emit one item
  with `role: "assistant"` and content of `output_text` parts.
- If `tool_calls` is present, emit one `function_call` item per tool call
  (with `call_id`, `name`, `arguments`). Order: assistant text item first,
  then function_call items, matching the OpenAI Responses convention.

### 5.5 `tool` → `function_call_output`

`{ role: "tool", tool_call_id, content }` becomes
`{ type: "function_call_output", call_id: <tool_call_id>, output: <content> }`.
If `content` is an array of text parts, join them.

### 5.6 `response_format` → `text.format`

- `{ type: "text" }` → `{ format: { type: "text" } }`.
- `{ type: "json_object" }` → `{ format: { type: "json_object" } }`.
- `{ type: "json_schema", json_schema: { name, schema, strict } }` →
  `{ format: { type: "json_schema", name, schema, strict } }`.

Other shapes pass through unchanged in non-strict mode (last-resort).

---

## 6. Tools and tool_choice

### 6.1 Tools

Chat tool:
```json
{ "type": "function",
  "function": { "name": "...", "description": "...", "parameters": { ... }, "strict": true } }
```

Becomes Responses tool (flattened):
```json
{ "type": "function", "name": "...", "description": "...",
  "parameters": { ... }, "strict": true }
```

Non-function tool types (e.g. `type: "web_search"`) pass through as-is in
non-strict mode; in strict mode they raise 400.

### 6.2 tool_choice

- `"auto"`, `"none"`, `"required"` → pass through as string.
- `{ type: "function", function: { name } }` → `{ type: "function", name }`.

---

## 7. Upstream call

In `server.mjs` after translation:

1. Build URL/headers:
   - `Authorization: Bearer ${RESPONSES_UPSTREAM_TOKEN}`.
   - `Content-Type: application/json`.
   - `Accept: text/event-stream` (hint, but we do not rely on it on the way back).
2. `fetch(RESPONSES_UPSTREAM_URL, { method: "POST", body, signal })` with an
   `AbortController` tied to `ADAPTER_REQUEST_TIMEOUT_MS` and to the client
   `req` `close` event (so client disconnect aborts the upstream call).
3. Branch on status:
   - `2xx`: treat body as Responses SSE regardless of `Content-Type`. The
     existing sidecar review confirmed Codex sometimes returns
     `application/octet-stream` for SSE-framed bodies — so we never gate on
     content type. Stream `response.body` (a `ReadableStream`) into our
     SSE parser.
   - non-`2xx`: read body as text, attempt JSON.parse. If JSON, forward as
     `{ "error": ... }` shape with the upstream status. If not JSON, wrap in
     `{ error: { message, type: "upstream_error" } }` with status 502 if the
     status itself is < 400 (defensive).

For client-streaming mode we set headers and start writing as soon as the
first translated chunk is ready. For client-non-streaming mode we hold the
response, drain the parser into a buffer, and emit one JSON at the end.

---

## 8. Response translation: Responses SSE → Chat Completions

Module: `lib/translate-stream.mjs` exposes a stateful translator class:

```js
class ResponsesToChatTranslator {
  constructor({ id, model, includeUsage, isClientStreaming }) {}
  // called for each parsed SSE block (event name + JSON data)
  onEvent(eventName, data) { /* returns array of chat.completion.chunk objects, or null */ }
  // called when upstream stream ends; returns final chunk(s) and [DONE] sentinel
  end() {}
  // for non-streaming clients: returns the assembled chat.completion JSON
  toFinalCompletion() {}
}
```

### 8.1 State

- `id` = `"chatcmpl-" + 24 hex chars` (generated at request entry, reused for
  all chunks of this request).
- `model` = chosen by upstream `response.created.response.model` if present,
  else the client-supplied model.
- `created` = unix seconds, taken from `response.created.response.created_at`
  if present, else `Date.now()/1000` rounded.
- `roleEmitted` = boolean, ensures we send the initial assistant role chunk
  exactly once before the first content/tool delta.
- `outputTextBuf` = accumulated text (used for the non-streaming buffer path).
- `toolCalls` = `Map<output_index, { id, name, argsBuf, indexInChat }>`
  keyed by Responses `output_index` (which is unique per output item).
- `usage` = captured from `response.completed.response.usage`.
- `finishReason` = `"stop"` by default; set to `"length"` if
  `response.completed.response.incomplete_details.reason === "max_output_tokens"`,
  set to `"tool_calls"` if any function_call was finalized and no
  superseding assistant text follows.
- `errored` = capture the upstream error object on `response.failed` /
  `response.error`.

### 8.2 Event handling

| Responses event | Action |
|---|---|
| `response.created` | capture `id`/`model`/`created_at`. No emit. |
| `response.in_progress` | ignore. |
| `response.output_item.added` (item.type === "function_call") | allocate a `toolCalls` entry; emit one chunk with `delta.tool_calls = [{ index, id, type: "function", function: { name, arguments: "" } }]`. |
| `response.output_item.added` (item.type === "message") | emit the initial role chunk if not yet emitted. |
| `response.content_part.added` | ignore (we react to `output_text.delta` directly). |
| `response.output_text.delta` | emit role chunk if pending; append to `outputTextBuf`; emit chunk with `delta.content = data.delta`. |
| `response.output_text.done` | **fallback**: compare `data.text` against `outputTextBuf`. If `data.text` is a strict superset (i.e. `outputTextBuf` is a prefix of `data.text` and shorter), emit the missing suffix as one extra `delta.content` chunk and update `outputTextBuf`. Otherwise no-op. |
| `response.function_call_arguments.delta` | append to that tool's `argsBuf`; emit chunk with `delta.tool_calls = [{ index: indexInChat, function: { arguments: data.delta } }]`. |
| `response.function_call_arguments.done` | reconcile: if `data.arguments` extends `argsBuf` (prefix match), emit the missing suffix as one final `arguments` delta and update `argsBuf`. Otherwise no-op. |
| `response.reasoning_text.delta` | emit chunk with `delta.reasoning_content = data.delta` (non-standard, kept for DeepSeek-style clients). **Never** mix into `delta.content`. |
| `response.reasoning_summary_text.delta` | same as above. |
| `response.output_item.done` (item.type === "function_call") | **reconciliation/fallback**. Use the finalized item to backfill `call_id`, `name`, and `arguments` for that `output_index` if any of them were missing or incomplete from the delta stream. In stream mode: if the item's `id` or `name` differ from what was emitted, emit one corrective tool-call chunk; if `arguments` is longer than `argsBuf`, emit the missing suffix as a final `arguments` delta. In non-stream mode: overwrite `tool_calls[i].id`/`name` with the canonical values and replace `arguments` with the longer of (`argsBuf`, `item.arguments`). |
| `response.output_item.done` (item.type === "message") | no emit; `output_text.done` already handled the suffix fallback. |
| `response.completed` | capture `usage`; compute `finishReason`; emit final chunk with empty `delta` and `finish_reason`; if `includeUsage`, emit the usage-only chunk; emit `data: [DONE]`. |
| `response.failed` / `response.error` | see §8.5. |

All streaming chunks **explicitly omit** `system_fingerprint`. The field
appears only on the non-streaming `chat.completion` JSON.

The "initial assistant role chunk" is the first chunk we emit per request:

```json
{ "id":"chatcmpl-...", "object":"chat.completion.chunk", "created":...,
  "model":"...", "choices":[ { "index":0,
    "delta":{ "role":"assistant", "content":"" }, "finish_reason":null } ] }
```

### 8.3 finish_reason logic

- If any tool call was finalized — via `response.function_call_arguments.done`
  **or** via `response.output_item.done` for an item of type `function_call`
  — and no later assistant text (`response.output_text.delta`) supersedes
  it, then `"tool_calls"`. This deliberately covers the case where upstream
  delivers a complete `function_call` item only at `output_item.done`
  without prior argument deltas.
- Else if `response.completed.response.incomplete_details.reason ===
  "max_output_tokens"`, `"length"`.
- Else `"stop"`.
- `content_filter` is not currently produced by Codex — leave the mapping
  hook present but unused in Phase 1.

For **streaming**, the final chunk is always emitted as a separate
finish-only chunk, regardless of what came before:

```json
{ "id":"chatcmpl-...", "object":"chat.completion.chunk", "created":...,
  "model":"...", "choices":[ { "index":0, "delta":{},
  "finish_reason":"tool_calls" /* or "stop" / "length" */ } ] }
```

We do not require the final chunk to also re-emit assembled `tool_calls` —
the per-event `delta.tool_calls` chunks already carry the assembly. The
final chunk's job is purely to set `finish_reason`.

### 8.5 Error events (`response.failed` / `response.error`)

Two regimes, no fake-content emission in either:

- **Before headers are flushed** (i.e. we have not yet written any chunk to
  the client — typically because upstream errored before/at `response.created`,
  or because we were in non-streaming buffer mode): respond with an
  OpenAI-shaped HTTP error JSON. Status code: 502 if upstream gave us a
  transport-level failure, otherwise the HTTP status that accompanied the
  error event (default 500 if none).
  ```json
  { "error": { "message": "...", "type": "upstream_error", "code": "..." } }
  ```

- **After streaming headers are flushed**: emit
  ```
  data: {"error": {"message":"...","type":"...","code":"..."}}
  data: [DONE]
  ```
  and end the response. **Do not emit a fake empty `chat.completion.chunk`
  with `finish_reason:"stop"` or any synthetic content** — the SSE error
  payload is the only signal the client gets, and it must not be masked
  by a successful-looking final chunk.

The `errored` flag set by these events suppresses the normal
`response.completed` path so we never produce both a `finish_reason` chunk
and an error payload for the same request.

### 8.6 Non-streaming path (`lib/translate-buffer.mjs`)

Wraps the same translator. Instead of writing chunks to the response, it
accumulates `outputTextBuf` and a final `tool_calls` array. On end:

```json
{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "created": <unix>,
  "model": "<model>",
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": <buf or null if pure tool call>,
      "tool_calls": <array if any, else omitted>
    },
    "finish_reason": "<computed>"
  }],
  "usage": { "prompt_tokens", "completion_tokens", "total_tokens" },
  "system_fingerprint": "fp_passthrough"
}
```

If upstream errored, return the upstream error JSON with the upstream status
code (mapped to OpenAI shape if it isn't already).

---

## 9. SSE parser (`lib/sse-parser.mjs`)

Pure stateful parser, no I/O. API:

```js
const parser = createSseParser();
parser.push(chunkBytes); // returns array of { event, data } blocks
parser.flush();          // returns final buffered block if any
```

Implementation notes:

- Convert incoming `Uint8Array` to string with a streaming UTF-8 decoder
  (`TextDecoder` with `stream: true` — built into Node). This avoids
  splitting multi-byte runes across TCP packet boundaries.
- Buffer until we see a blank line (`\n\n` after CRLF normalization).
- Within a block:
  - Lines beginning with `:` are comments — skip.
  - `event: <name>` sets the block's event name (last one wins).
  - `data: <text>` lines are accumulated, joined with `\n`.
  - `id:` and `retry:` are ignored.
- Yield `{ event: name || "message", data }`. If `data === "[DONE]"` we
  surface that as a sentinel — but Codex Responses uses the structured
  `response.completed` event for completion, so `[DONE]` upstream is treated
  defensively the same as `response.completed`.

Adversarial cases the parser tests will cover:

- CRLF line endings.
- A single event split across multiple TCP chunks (mid-line, mid-data).
- Multiple `data:` lines per event.
- Comment-only blocks (heartbeats).
- Trailing data without a final blank line (use `flush()`).
- Content-Type lying (`application/octet-stream`) — handled at the HTTP
  layer, not the parser, but verified in `server.test.mjs`.

---

## 10. Errors (`lib/errors.mjs`)

Two helpers:

```js
sendJsonError(res, status, message, type, code) // sets headers, writes once
toOpenAIError({ message, type, code, param })    // returns { error: { ... } }
```

Mapping rules:

- Bad client token → 401 `auth_error` `bad adapter token`.
- Body too large → 413 `invalid_request_error` `request body too large`.
- JSON parse error → 400 `invalid_request_error`.
- Schema validation error → 400 `invalid_request_error` with the offending
  path included in `message`.
- Upstream returns `dry_run_refresh_required` (sidecar's signal for OAuth
  pre-flight) → forward verbatim with sidecar's status. We do **not** rewrite
  this — operators need the original message.
- `fetch()` throw / DNS / ECONNREFUSED → 502 `bad_gateway`.
- `AbortError` from request timeout → 504 `timeout`.
- Upstream non-2xx → forward status + JSON body; if body wasn't JSON, wrap.

In streaming responses where headers are already flushed, errors degrade to
a `data: {"error":{...}}` line followed by `data: [DONE]`. Document this in
the README as "best-effort mid-stream error semantics."

---

## 11. Logging (`lib/log.mjs`)

Tiny key=value or JSON logger — pick JSON for machine-readability. One log
line per request, emitted on response end:

```
{"ts":"...","level":"info","reqId":"...","route":"/v1/chat/completions",
 "model":"gpt-5.5","clientStream":true,"upstreamStatus":200,"latencyMs":2837}
```

Startup line on boot lists all effective config (with the two tokens redacted
to first-3-chars + `***`).

`debug` level adds: dropped Chat Completions fields, translation summary
(message count, tool count), upstream URL, but never the message bodies.

---

## 12. Tests

### 12.1 Unit tests (mocha-style via `node:test`)

`translate-request.test.mjs`:
- system + developer → joined `instructions`.
- user string → `input_text`.
- user `image_url` → `input_image`.
- assistant text → `output_text`.
- assistant `tool_calls` → `function_call` items with correct `call_id`.
- tool message → `function_call_output`.
- tools array flattened correctly.
- tool_choice variants (`auto`, `required`, `{type:"function",...}`).
- `stream:false` still produces upstream `stream: true`.
- `response_format: json_schema` → `text.format`.
- strict mode rejects `n`, `seed`, etc.
- non-strict mode silently drops unsupported fields.

`sse-parser.test.mjs`:
- LF and CRLF.
- multi-data-line events.
- comments.
- chunk boundaries mid-line.
- chunk boundaries mid-multibyte char (string `"héllo"` byte-split).
- trailing block flushed by `flush()`.

`translate-stream.test.mjs` (drives translator with synthetic event arrays):
- text-only happy path → role chunk, deltas, final stop chunk, `[DONE]`.
- text + `include_usage` → usage-only chunk before `[DONE]`.
- tool-call streaming → role chunk (or skipped if no text), tool chunk with
  id+name, arg deltas, final `tool_calls` finish_reason.
- `response.failed` mid-stream → error chunk + `[DONE]`.
- `incomplete_details.reason = "max_output_tokens"` → `finish_reason: "length"`.

`translate-buffer.test.mjs` (same fixtures, non-streaming output):
- text → one `chat.completion` JSON.
- tool call → `tool_calls` array, `content: null`, `finish_reason:"tool_calls"`.
- usage mapping.
- failure → error JSON propagated.

### 12.2 Mock-upstream integration tests (`server.test.mjs`)

Spawn the adapter against `test/mock-upstream.mjs` (an in-process HTTP server
that replays canned SSE fixtures). The mock deliberately responds with
`Content-Type: application/octet-stream` to reproduce the real-world bug.

Required cases (spec §19.2):

1. `stream:true` text response.
2. `stream:false` text response.
3. `stream:true` with `include_usage`.
4. `stream:false` with `include_usage` (the usage lands inside the JSON,
   not as a chunk).
5. Tool call streaming.
6. Tool call non-streaming.
7. Upstream non-2xx error forwarding (e.g. mock returns 401 with sidecar's
   `dry_run_refresh_required`).
8. Invalid adapter token → 401.
9. Invalid JSON request → 400.
10. Body over `ADAPTER_MAX_BODY_BYTES` → 413.

Assertions:
- For streaming cases, the response body never contains
  `event: response.created`, `event: response.output_text.delta`, or
  `event: response.completed` (i.e. raw upstream events do not leak).
- For streaming cases, the final two non-empty SSE lines are
  `data: {... usage ...}` (when requested) and `data: [DONE]`.
- For non-streaming cases, `object === "chat.completion"`.

### 12.3 Live smoke (`test/smoke-live.mjs`, opt-in)

Gated by `ADAPTER_LIVE_SMOKE=1` so it doesn't run in default CI. Targets
`http://127.0.0.1:18890/v1/responses` through the running adapter. Mirrors
spec §19.3 commands and asserts:

- `stream:false` → `chat.completion`, content `ADAPTER_NONSTREAM_OK`.
- `stream:true` → at least one `chat.completion.chunk` followed by
  `data: [DONE]`, no raw Responses events.

### 12.4 `npm test` wires up

```json
"scripts": {
  "start": "./start.sh",
  "test": "node --test test/translate-request.test.mjs test/sse-parser.test.mjs test/translate-stream.test.mjs test/translate-buffer.test.mjs test/server.test.mjs",
  "test:smoke": "node test/smoke-live.mjs"
}
```

---

## 13. Implementation phases (revised)

Tool-call support is central to Chat Completions compatibility, so basic
tool calls are pulled into Phase 1 rather than deferred.

**Phase 1 — text + basic (single) tool-call path (first delivery):**

Scope is intentionally limited to **the basic/single tool-call path** — one
`function_call` item per response. Multiple parallel `function_call` items
in the same response are not validated here; they are Phase 2.

- config, server, error helpers, ID generator, logger.
- request translator covering: system/developer → instructions, user text,
  user `image_url` (translation only — multimodal end-to-end test is in
  Phase 3), assistant text, **assistant `tool_calls`**, **`tool` role**,
  **`tools[]` flattening**, **`tool_choice` conversion**.
- SSE parser.
- streaming translator covering: `response.created`, role emission,
  `output_text.delta/done`, `output_item.added/done` for both message and
  function_call, `function_call_arguments.delta/done`, `reasoning_text.delta`,
  `reasoning_summary_text.delta`, `response.completed`, `response.failed`,
  `response.error`.
- buffering translator (non-streaming) covering all the above.
- mock upstream + integration tests 1–10 from spec §19.2 (so single
  tool-call streaming and non-streaming, cases 5–6, are in this phase).
- live smoke wired but optional.

The final streaming chunk for any tool-call response — single or
parallel — is always `{ delta: {}, finish_reason: "tool_calls" }`. Phase 1
proves this on the single-tool path; Phase 2 proves it survives parallel
emission.

**Phase 2 — parallel tool-call hardening and robustness:**
- **parallel tool calls**: validate and harden the case where one upstream
  response contains multiple `function_call` items (different `output_index`
  values, possibly interleaved argument deltas). Verify the streaming
  translator preserves per-tool `index` mapping in `delta.tool_calls[]`,
  the buffering translator collects all calls into a single
  `message.tool_calls` array, and the final chunk still carries
  `finish_reason:"tool_calls"`.
- `response_format: json_schema` round-trip test against a mock upstream
  that emits `output_text` containing JSON.
- `max_completion_tokens` mapped to `max_output_tokens`, with the
  `incomplete_details.reason === "max_output_tokens"` →
  `finish_reason: "length"` path covered by an integration test.
- structured streaming-error payload covered by an integration test.

Until Phase 2 is green, the README must not claim full parallel-tool-call
compatibility — only "basic / single tool-call" support.

**Phase 3 — multimodal end-to-end:**
- `image_url` → `input_image` end-to-end test (request translation already
  exists in Phase 1; this phase adds a mock upstream that accepts and
  echoes image inputs, plus a fixture-based round-trip test).
- audio/file inputs deferred unless explicitly requested.

**Phase 4 — `previous_response_id` follow-up cache (optional):**
introduce a small in-memory `Map<call_id, response_id>` so a follow-up Chat
Completions request that includes a `tool` message can be turned into a
Responses request with `previous_response_id` instead of replaying the whole
history. Only enable if confirmed against the live sidecar. **Not in scope
for the first delivery.**

---

## 14. Acceptance check (mirrors spec §21)

Before declaring the project done I will manually verify each of the 11
acceptance criteria. The non-obvious ones:

- §21.6 "Raw Responses SSE events are not leaked" — covered by the `server.test.mjs`
  assertion that the response body contains no `event: response.*` lines.
- §21.7 "never reads or writes OAuth credential files" — covered by the fact
  that the codebase contains zero references to `auth-profiles.json`,
  `~/.codex`, `auth.openai.com`, or any OAuth client-id constants. I'll add a
  `grep` assertion to the test script as belt-and-braces.
- §21.8 "never calls OpenAI OAuth token endpoints" — same grep covers the
  hostname `auth.openai.com`.
- §21.11 "Live smoke test" — manual, gated by env var.

---

## 15. Resolved design decisions

All eight open questions were resolved by the project owner on 2026-05-10:

1. **Node 20+.** Built-in `fetch`, Web Streams, `AbortController` are all
   stable. No Node 18 fallback.

2. **`finish_reason` for tool calls.** Streaming emits a separate finish-only
   chunk after all tool deltas: `{ delta: {}, finish_reason: "tool_calls" }`.
   The final chunk does not need to re-emit the assembled `tool_calls`
   array — the per-delta chunks already carry it. Non-streaming response
   sets `message.content = null`, `message.tool_calls = [...]`, and
   `finish_reason = "tool_calls"`.

3. **`delta.reasoning_content` is emitted** whenever upstream sends
   `response.reasoning_text.delta` or `response.reasoning_summary_text.delta`.
   It is **never** mixed into `delta.content`. Kept for DeepSeek-style
   third-party clients even though it isn't in the official OpenAI schema.

4. **Strict mode defaults to off** (`ADAPTER_STRICT_OPENAI_COMPAT=0`).
   Unsupported fields are silently dropped. The README **must** list every
   dropped/partially-supported field by name so callers know:

   ```
   n
   seed
   stop
   logprobs
   top_logprobs
   logit_bias
   frequency_penalty
   presence_penalty
   max_tokens / max_completion_tokens (mapped to max_output_tokens iff safe)
   stream_options.* (only include_usage is honored)
   ```

   With `ADAPTER_STRICT_OPENAI_COMPAT=1`, those fields produce
   `400 invalid_request_error`.

5. **`system_fingerprint`:** non-streaming response sets
   `"fp_passthrough"`; streaming chunks **explicitly omit** the field
   (do not write the key at all, do not set it to `null`). Re-evaluate
   only if a client turns out to require it on chunks.

6. **Always send `store: false` upstream.** The adapter is a stateless
   protocol translator and must never ask Codex/OpenAI to persist responses.

7. **Streaming errors after headers flushed:** structured SSE error then
   `[DONE]`:
   ```
   data: {"error": {"message": "...", "type": "...", "code": "..."}}
   data: [DONE]
   ```
   No abrupt socket close. README will note that the HTTP status code is
   already committed at this point — the error is delivered as an SSE
   payload, not an HTTP error.

8. **Do not modify the existing sidecar in this project.** The sidecar's
   inline `/v1/chat/completions` is left in place for now. A separate
   future PR may remove it once: (a) the adapter is stable in production,
   (b) stream/non-stream/tool-call adapter tests are all green, (c) every
   downstream caller (OpenClaw, Hermes, etc.) only depends on the sidecar's
   `/v1/responses`, and (d) the sidecar's `/v1/responses` regression tests
   still pass after the inline removal.

---

## 16. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Upstream changes its event names | Stream translator switches on event name; unknown events are logged at debug and ignored. Tests anchor the names we depend on. |
| Upstream returns SSE without `text/event-stream` header (already observed) | Parser is invoked on any 2xx body. No content-type gate. |
| Client disconnects mid-stream | `req.on("close")` aborts the upstream `fetch` via `AbortController`. |
| Slow upstream | `ADAPTER_REQUEST_TIMEOUT_MS` aborts after 5 min. |
| Adapter accidentally exposed beyond localhost | Startup refuses to bind non-loopback when `ADAPTER_TOKEN` is the placeholder; README warns to set a strong token. |
| Tool-call streaming produces no text | Role chunk is still emitted before the tool chunk so OpenAI clients see a valid sequence. |
| Multi-byte character split across SSE chunks | `TextDecoder({ stream: true })`. |

---

## 17. Out of scope (will not implement unless asked)

- Persistence/state across requests (Phase 4 only on demand).
- `previous_response_id` chaining.
- WebSocket transport.
- Audio output, audio input, file inputs, video.
- `n > 1` (multiple choices). The Responses API doesn't naturally produce
  it; we'd need to issue N parallel upstream calls, which complicates auth
  budgeting. Out of scope until requested.
- Rate limiting, quotas, request queuing.
- TLS termination. Run behind a reverse proxy if exposing externally.

---

## 18. Done definition

Phase 1 is done when:

- `npm test` is green on a clean clone (only Node 20+ required).
- `ADAPTER_LIVE_SMOKE=1 npm run test:smoke` is green against the running
  sidecar at `127.0.0.1:18890`.
- README documents env vars, dropped fields, and one curl example each for
  streaming and non-streaming.
- A `grep` over the source confirms zero references to OAuth identifiers
  (the §14 belt-and-braces check).
- Each item in spec §21 is checked off in the PR description.
