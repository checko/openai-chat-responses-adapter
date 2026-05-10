# OpenAI Chat Completions ↔ Responses Adapter Daemon Software Spec

Date: 2026-05-09  
Owner context: OpenClaw / openai-passthrough sidecar deployment  
Target language: Node.js preferred, but implementation language is flexible  
Status: implementation spec for programmer

---

## 1. Background

The existing `openai-passthrough` sidecar already works well for:

```text
POST /v1/responses
```

It handles the sensitive parts:

```text
OpenAI OAuth profile selection
access token usage
refresh-token lock coordination
dry-run refresh safety
auth-profiles.json handling
chatgpt-account-id validation
Codex Responses upstream forwarding
```

That sidecar should remain focused and stable.

This new adapter daemon must provide an OpenAI-compatible Chat Completions interface without touching OAuth or refresh-token logic.

The adapter should sit in front of the existing sidecar:

```text
OpenAI-compatible client
  → adapter daemon /v1/chat/completions
  → existing openai-passthrough /v1/responses
  → Codex Responses backend
```

The adapter is a pure protocol translator:

```text
/v1/chat/completions request → /v1/responses request
/v1/responses JSON/SSE response → /v1/chat/completions JSON/SSE response
```

---

## 2. Non-goals

This daemon must **not**:

1. Read or write OpenClaw auth stores.
2. Handle OpenAI OAuth login.
3. Refresh OpenAI tokens.
4. Touch `auth-profiles.json`.
5. Implement a full API gateway, billing system, dashboard, user database, or multi-provider router.
6. Replace the existing `/v1/responses` sidecar.
7. Change the existing sidecar behavior.

The existing sidecar remains the only component that talks to OpenAI/Codex using OAuth credentials.

---

## 3. Recommended project name

```text
openai-chat-responses-adapter
```

Suggested location:

```text
~/openai-chat-responses-adapter
```

---

## 4. Runtime architecture

### 4.1 Default ports

Existing sidecar:

```text
http://127.0.0.1:18890/v1/responses
```

New adapter:

```text
http://127.0.0.1:18891/v1/chat/completions
```

### 4.2 Request path

```text
Client
  POST /v1/chat/completions
    ↓
Adapter daemon
  translate Chat Completions request to Responses request
    ↓
Existing sidecar
  POST /v1/responses
    ↓
Adapter daemon
  translate Responses output to Chat Completions output
    ↓
Client
```

---

## 5. Environment variables

The daemon must be configured only through environment variables and/or a simple `.env` file.

Required / recommended:

```text
ADAPTER_BIND=127.0.0.1
ADAPTER_PORT=18891
ADAPTER_TOKEN=<client-facing-token>
RESPONSES_UPSTREAM_URL=http://127.0.0.1:18890/v1/responses
RESPONSES_UPSTREAM_TOKEN=<sidecar-token>
```

Optional:

```text
ADAPTER_MAX_BODY_BYTES=10485760
ADAPTER_REQUEST_TIMEOUT_MS=300000
ADAPTER_LOG_LEVEL=info
ADAPTER_ENABLE_HEALTH=1
ADAPTER_STRICT_OPENAI_COMPAT=0
```

Security rule:

```text
ADAPTER_TOKEN and RESPONSES_UPSTREAM_TOKEN should be different if the adapter is exposed beyond localhost.
```

---

## 6. HTTP endpoints

### 6.1 Required endpoint

```text
POST /v1/chat/completions
```

This is the official OpenAI-compatible Chat Completions endpoint.

### 6.2 Optional alias

```text
POST /v1/chat/complete
```

This is **not** an OpenAI standard endpoint. Implement only as an optional alias if explicitly desired.

Recommended behavior for first version:

```text
/v1/chat/complete → 404 Not Found
```

### 6.3 Health endpoint

Recommended:

```text
GET /healthz
```

Response:

```json
{
  "ok": true,
  "service": "openai-chat-responses-adapter",
  "upstream": "http://127.0.0.1:18890/v1/responses"
}
```

Optional deeper health:

```text
GET /healthz/upstream
```

This may perform a lightweight upstream check, but must avoid expensive model calls unless explicitly configured.

---

## 7. Authentication

### 7.1 Client → adapter

Require:

```text
Authorization: Bearer <ADAPTER_TOKEN>
```

Invalid/missing token response:

```http
HTTP/1.1 401 Unauthorized
Content-Type: application/json
```

```json
{
  "error": {
    "message": "bad adapter token",
    "type": "auth_error"
  }
}
```

Use constant-time token comparison where practical.

### 7.2 Adapter → existing sidecar

Use:

```text
Authorization: Bearer <RESPONSES_UPSTREAM_TOKEN>
```

Set explicitly per environment:

```text
RESPONSES_UPSTREAM_TOKEN=<sidecar-token>
```

---

## 8. Request translation: Chat Completions → Responses

Input endpoint:

```text
POST /v1/chat/completions
```

Example input:

```json
{
  "model": "gpt-5.5",
  "messages": [
    { "role": "system", "content": "Reply briefly." },
    { "role": "user", "content": "Hello" }
  ],
  "stream": false
}
```

Translated upstream request to `/v1/responses`:

```json
{
  "model": "gpt-5.5",
  "instructions": "Reply briefly.",
  "input": [
    {
      "role": "user",
      "content": [
        { "type": "input_text", "text": "Hello" }
      ]
    }
  ],
  "stream": true,
  "store": false
}
```

Important:

```text
Always send stream:true to the upstream /v1/responses endpoint.
```

Reason:

The current Codex Responses upstream rejects `stream:false` with:

```json
{"detail":"Stream must be set to true"}
```

Therefore:

```text
client stream:false → adapter sends upstream stream:true, buffers SSE, returns one chat.completion JSON
client stream:true  → adapter sends upstream stream:true, streams translated chat.completion.chunk SSE
```

---

## 9. Field mapping: request

### 9.1 Basic fields

| Chat Completions field | Responses field | Notes |
|---|---|---|
| `model` | `model` | Required if strict; default allowed if configured |
| `messages[]` | `instructions` + `input[]` | See role mapping |
| `stream` | always upstream `stream:true` | Client value controls adapter response mode |
| `temperature` | `temperature` | Pass through if number |
| `top_p` | `top_p` | Pass through if number |
| `user` | `user` | Pass through |
| `metadata` | `metadata` | Pass through |
| `parallel_tool_calls` | `parallel_tool_calls` | Pass through if boolean |
| `reasoning_effort` | `reasoning.effort` | Optional |
| `reasoning` | `reasoning` | Optional pass-through if object |
| `response_format` | `text.format` | Convert carefully |
| `tools` | `tools` | Flatten function tools |
| `tool_choice` | `tool_choice` | Convert function choice shape |

### 9.2 Fields to ignore or partially support initially

Initial version may ignore/drop:

```text
n
seed
stop
logprobs
top_logprobs
logit_bias
frequency_penalty
presence_penalty
stream_options, except include_usage
max_tokens / max_completion_tokens, unless mapped to max_output_tokens safely
```

If unsupported fields are dropped, document this in README.

Optional strict mode:

```text
ADAPTER_STRICT_OPENAI_COMPAT=1
```

In strict mode, unsupported fields should return `400 invalid_request_error` rather than being silently ignored.

---

## 10. Role mapping

### 10.1 `system` and `developer`

Chat messages:

```json
{ "role": "system", "content": "..." }
{ "role": "developer", "content": "..." }
```

Map to Responses:

```json
"instructions": "..."
```

If multiple system/developer messages exist, join with double newline:

```text
system1\n\ndeveloper1\n\nsystem2
```

### 10.2 `user`

String content:

```json
{ "role": "user", "content": "Hello" }
```

Map to:

```json
{
  "role": "user",
  "content": [
    { "type": "input_text", "text": "Hello" }
  ]
}
```

Array content:

```json
{
  "role": "user",
  "content": [
    { "type": "text", "text": "What is this?" },
    { "type": "image_url", "image_url": { "url": "data:image/png;base64,..." } }
  ]
}
```

Map to:

```json
{
  "role": "user",
  "content": [
    { "type": "input_text", "text": "What is this?" },
    { "type": "input_image", "image_url": "data:image/png;base64,..." }
  ]
}
```

Recommended initial support:

```text
text → input_text
image_url → input_image
```

Optional later support:

```text
input_audio
file
video_url
```

### 10.3 `assistant`

Assistant text:

```json
{ "role": "assistant", "content": "Previous answer" }
```

Map to:

```json
{
  "role": "assistant",
  "content": [
    { "type": "output_text", "text": "Previous answer" }
  ]
}
```

Assistant tool calls:

```json
{
  "role": "assistant",
  "content": null,
  "tool_calls": [
    {
      "id": "call_123",
      "type": "function",
      "function": {
        "name": "get_weather",
        "arguments": "{\"city\":\"Taipei\"}"
      }
    }
  ]
}
```

Map to additional Responses input item:

```json
{
  "type": "function_call",
  "call_id": "call_123",
  "name": "get_weather",
  "arguments": "{\"city\":\"Taipei\"}"
}
```

### 10.4 `tool`

Chat tool output:

```json
{
  "role": "tool",
  "tool_call_id": "call_123",
  "content": "Weather is sunny."
}
```

Map to:

```json
{
  "type": "function_call_output",
  "call_id": "call_123",
  "output": "Weather is sunny."
}
```

---

## 11. Tool definitions mapping

Chat Completions tool:

```json
{
  "type": "function",
  "function": {
    "name": "get_weather",
    "description": "Get weather",
    "parameters": {
      "type": "object",
      "properties": {
        "city": { "type": "string" }
      },
      "required": ["city"]
    },
    "strict": true
  }
}
```

Responses tool:

```json
{
  "type": "function",
  "name": "get_weather",
  "description": "Get weather",
  "parameters": {
    "type": "object",
    "properties": {
      "city": { "type": "string" }
    },
    "required": ["city"]
  },
  "strict": true
}
```

Tool choice mapping:

```json
{ "type": "function", "function": { "name": "get_weather" } }
```

should become:

```json
{ "type": "function", "name": "get_weather" }
```

String tool choices like:

```text
auto
none
required
```

may pass through.

---

## 12. Response translation: Responses stream → Chat Completions stream

Upstream `/v1/responses` returns SSE events like:

```text
event: response.output_text.delta
data: {"type":"response.output_text.delta","delta":"Hello"}
```

The adapter must output Chat Completions SSE:

```text
data: {"id":"chatcmpl-...","object":"chat.completion.chunk","created":...,"model":"...","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}
```

End stream with:

```text
data: [DONE]
```

### 12.1 Event mapping

| Responses SSE event / type | Chat Completions output |
|---|---|
| `response.created` | capture `id`, `model`, `created_at`; optionally emit assistant role chunk later |
| `response.output_text.delta` | `choices[0].delta.content` |
| `response.output_text.done` | update accumulated text; no required chunk |
| `response.reasoning_text.delta` | optional `choices[0].delta.reasoning_content` |
| `response.reasoning_summary_text.delta` | optional `choices[0].delta.reasoning_content` |
| `response.output_item.added` function_call | emit `choices[0].delta.tool_calls[]` with id/name |
| `response.function_call_arguments.delta` | emit `choices[0].delta.tool_calls[].function.arguments` |
| `response.output_item.done` function_call | finalize/remember function call |
| `response.completed` | emit final chunk with `finish_reason` |
| `response.failed` / `response.error` | emit error JSON or terminate with mapped error |

### 12.2 Initial assistant role chunk

For streaming Chat Completions, emit role before first content/tool delta:

```json
{
  "choices": [
    {
      "index": 0,
      "delta": {
        "role": "assistant",
        "content": ""
      },
      "finish_reason": null
    }
  ]
}
```

### 12.3 Finish reason

Use:

```text
finish_reason = "tool_calls" if a tool call was emitted and no final assistant text supersedes it
finish_reason = "length" if upstream incomplete reason is max_output_tokens
finish_reason = "stop" otherwise
```

### 12.4 Usage chunk

If client requested:

```json
"stream_options": { "include_usage": true }
```

then emit final usage chunk before `[DONE]`:

```json
{
  "id": "chatcmpl-...",
  "object": "chat.completion.chunk",
  "created": 123,
  "model": "gpt-5.5",
  "choices": [],
  "usage": {
    "prompt_tokens": 10,
    "completion_tokens": 20,
    "total_tokens": 30
  }
}
```

Map usage:

```text
Responses usage.input_tokens  → prompt_tokens
Responses usage.output_tokens → completion_tokens
Responses usage.total_tokens  → total_tokens
```

---

## 13. Response translation: Responses stream → non-stream Chat Completion

Even for client `stream:false`, upstream should be called with `stream:true`.

The adapter must accumulate upstream SSE and return:

```json
{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "created": 1234567890,
  "model": "gpt-5.5",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "Hello"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 10,
    "completion_tokens": 20,
    "total_tokens": 30
  },
  "system_fingerprint": "fp_passthrough"
}
```

If output is a tool call:

```json
{
  "choices": [
    {
      "message": {
        "role": "assistant",
        "content": null,
        "tool_calls": [
          {
            "id": "call_123",
            "type": "function",
            "function": {
              "name": "get_weather",
              "arguments": "{\"city\":\"Taipei\"}"
            }
          }
        ]
      },
      "finish_reason": "tool_calls"
    }
  ]
}
```

---

## 14. Upstream response handling

The adapter must not rely only on upstream `Content-Type` to decide whether the upstream response is SSE.

Observed issue:

```text
The upstream body can be SSE-framed even when Content-Type does not include text/event-stream.
```

Required behavior:

```text
If upstream status is 2xx, treat the body as Responses SSE and parse/translate it.
If upstream status is non-2xx, forward the error payload and status code as JSON where possible.
```

---

## 15. Error handling

### 15.1 Invalid request

Return:

```http
HTTP/1.1 400 Bad Request
Content-Type: application/json
```

```json
{
  "error": {
    "message": "invalid chat completions body: ...",
    "type": "invalid_request_error"
  }
}
```

### 15.2 Upstream auth / sidecar errors

If existing sidecar returns:

```json
{
  "error": {
    "message": "...",
    "type": "upstream_auth_error",
    "code": "dry_run_refresh_required"
  }
}
```

Forward it with the same status code.

Do not hide OAuth/refresh errors, because they are operationally important.

### 15.3 Upstream transport error

Return:

```http
HTTP/1.1 502 Bad Gateway
```

```json
{
  "error": {
    "message": "upstream request failed: ...",
    "type": "bad_gateway"
  }
}
```

---

## 16. SSE parser requirements

Implement a robust SSE parser that handles:

```text
LF and CRLF
multiple data: lines per event
optional event: field
comments beginning with :
partial chunks across TCP packets
final pending buffer at stream close
```

For each SSE block:

```text
parse event name
join data lines with \n
ignore empty blocks
parse JSON data unless data == [DONE]
```

---

## 17. Logging

Log at startup:

```text
service name
bind/port
upstream URL
max body bytes
timeout
log level
```

Log per request:

```text
request id
endpoint
model
client stream mode
upstream status
latency
error code if any
```

Do not log full prompts by default.

Optional debug mode may log translated request/response metadata, but must redact authorization headers.

---

## 18. Process management

Provide:

```text
start.sh
package.json
README.md
.env.example
```

Suggested `start.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

export ADAPTER_BIND="${ADAPTER_BIND:-127.0.0.1}"
export ADAPTER_PORT="${ADAPTER_PORT:-18891}"
export ADAPTER_TOKEN="${ADAPTER_TOKEN:-change-me}"
export RESPONSES_UPSTREAM_URL="${RESPONSES_UPSTREAM_URL:-http://127.0.0.1:18890/v1/responses}"
export RESPONSES_UPSTREAM_TOKEN="${RESPONSES_UPSTREAM_TOKEN:-change-me-upstream-token}"

exec node server.mjs
```

Startup safety:

```text
If ADAPTER_TOKEN=change-me and ADAPTER_BIND is not localhost, refuse to start.
```

---

## 19. Tests

### 19.1 Unit tests

Must test request translation:

```text
system/developer → instructions
user text → input_text
user image_url → input_image
assistant text → output_text
assistant tool_calls → function_call
tool messages → function_call_output
tools[] flattening
tool_choice conversion
stream:false still sends upstream stream:true
```

Must test response translation:

```text
response.output_text.delta → chat.completion.chunk delta.content
response.completed → finish_reason stop + [DONE]
usage mapping
tool call deltas → tool_calls[]
response.failed → error handling
```

### 19.2 Integration tests with mock upstream

Create mock `/v1/responses` upstream that returns SSE with deliberately wrong content-type:

```text
Content-Type: application/octet-stream
```

Test adapter still translates correctly.

Required test cases:

1. `stream:true` text response.
2. `stream:false` text response.
3. `stream:true` with usage.
4. `stream:false` with usage.
5. Tool call streaming.
6. Tool call non-streaming.
7. Upstream non-2xx error forwarding.
8. Invalid adapter token.
9. Invalid JSON request.
10. Large body rejection.

### 19.3 Live smoke test

Against existing sidecar:

```text
RESPONSES_UPSTREAM_URL=http://127.0.0.1:18890/v1/responses
RESPONSES_UPSTREAM_TOKEN=<sidecar-token>
```

Test non-stream:

```bash
curl -sS http://127.0.0.1:18891/v1/chat/completions \
  -H 'Authorization: Bearer <ADAPTER_TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '{
    "model":"gpt-5.5",
    "messages":[
      {"role":"system","content":"Reply exactly ADAPTER_NONSTREAM_OK."},
      {"role":"user","content":"test"}
    ],
    "stream":false
  }'
```

Expected:

```text
HTTP 200
object = chat.completion
choices[0].message.content = ADAPTER_NONSTREAM_OK
```

Test stream:

```bash
curl -N http://127.0.0.1:18891/v1/chat/completions \
  -H 'Authorization: Bearer <ADAPTER_TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '{
    "model":"gpt-5.5",
    "messages":[
      {"role":"system","content":"Reply exactly ADAPTER_STREAM_OK."},
      {"role":"user","content":"test"}
    ],
    "stream":true,
    "stream_options":{"include_usage":true}
  }'
```

Expected:

```text
data: {"object":"chat.completion.chunk", ...}
data: [DONE]
```

Must not leak raw Responses SSE:

```text
event: response.created
event: response.output_text.delta
event: response.completed
```

---

## 20. Reference implementations

Use these only as references; do not import large unrelated subsystems.

### 20.1 QuantumNous/new-api

Repo:

```text
https://github.com/QuantumNous/new-api
```

Relevant files:

```text
service/openaicompat/chat_to_responses.go
service/openaicompat/responses_to_chat.go
relay/channel/openai/chat_via_responses.go
```

Useful ideas:

```text
Chat request → Responses request mapping
Responses response → Chat response mapping
Responses SSE → chat.completion.chunk state machine
tool call delta handling
usage mapping
reasoning_content handling
```

### 20.2 TauriTavern-v1.6.5

Repo:

```text
https://github.com/1048632280/TauriTavern-v1.6.5
```

Relevant files:

```text
docs/CurrentState/NativeApiFormats.md
src-tauri/src/infrastructure/apis/http_chat_completion_repository/openai_responses.rs
```

Useful ideas:

```text
ResponsesStreamState
response.output_text.delta → delta.content
response.function_call_arguments.delta → tool_calls[].function.arguments
call_id → previous_response_id cache for tool follow-up
```

### 20.3 OpenAI migration toolkit

Repo:

```text
https://github.com/openai/completions-responses-migration-pack
```

Use for:

```text
Official migration semantics
Field naming guidance
Responses API best practices
```

Not a runtime proxy.

---

## 21. Acceptance criteria

The implementation is accepted when all are true:

1. Existing `openai-passthrough` `/v1/responses` sidecar remains unchanged and working.
2. Adapter starts independently on configured port.
3. `POST /v1/chat/completions` with `stream:false` returns valid OpenAI-compatible `chat.completion` JSON.
4. `POST /v1/chat/completions` with `stream:true` returns valid OpenAI-compatible `chat.completion.chunk` SSE.
5. Streaming output ends with:
   ```text
   data: [DONE]
   ```
6. Raw Responses SSE events are not leaked to Chat Completions clients.
7. Adapter never reads or writes OAuth credential files.
8. Adapter never calls OpenAI OAuth token endpoints.
9. Adapter uses only `RESPONSES_UPSTREAM_URL` and `RESPONSES_UPSTREAM_TOKEN` to reach the existing sidecar.
10. Unit tests and mock-upstream integration tests pass.
11. Live smoke test through `http://127.0.0.1:18890/v1/responses` passes.

---

## 22. Suggested implementation phases

### Phase 1: Text-only compatibility

Implement:

```text
/v1/chat/completions
stream:false
stream:true
system/user/assistant text
usage mapping
error forwarding
mock upstream tests
live smoke test
```

### Phase 2: Tool calls

Implement:

```text
tools[]
tool_choice
assistant tool_calls
tool messages
Responses function_call streaming
finish_reason=tool_calls
```

### Phase 3: Multimodal

Implement:

```text
image_url → input_image
optional audio/file support
```

### Phase 4: Tool follow-up state

Evaluate and implement if needed:

```text
call_id → previous_response_id cache
function_call_output follow-up using previous_response_id
```

This must be tested against the actual existing sidecar/Codex upstream before enabling by default.

---

## 23. Recommended first implementation strategy

Do not begin by copying a full external project.

Recommended approach:

1. Start with a small Node.js HTTP server.
2. Implement request translation and SSE parsing locally.
3. Use `new-api` and `TauriTavern` only as reference logic.
4. Add mock-upstream tests before live tests.
5. Keep adapter stateless in Phase 1.
6. Add state only when implementing tool follow-up.

This keeps the daemon small, auditable, and safe to run beside the stable OAuth sidecar.
