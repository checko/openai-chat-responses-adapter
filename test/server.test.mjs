import { test } from "node:test";
import { strict as assert } from "node:assert";
import { Buffer } from "node:buffer";

import { buildServer } from "../server.mjs";
import { startMockUpstream } from "./mock-upstream.mjs";
import { createLogger } from "../lib/log.mjs";

const log = createLogger({ level: "error" }); // quiet during tests

function startAdapter(upstreamUrl, overrides = {}) {
  const config = {
    bind: "127.0.0.1",
    port: 0,
    token: "test-adapter-token",
    upstreamUrl,
    upstreamToken: "test-upstream-token",
    maxBodyBytes: 1024 * 1024,
    requestTimeoutMs: 30000,
    logLevel: "error",
    enableHealth: true,
    strictCompat: false,
    ...overrides,
  };
  const server = buildServer(config, log);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({
        server,
        port: addr.port,
        url: `http://127.0.0.1:${addr.port}`,
        config,
        async close() { return new Promise((rs) => server.close(rs)); },
      });
    });
  });
}

async function postChat(adapter, body, { token = "test-adapter-token", expectStream = false, headers = {} } = {}) {
  const res = await fetch(adapter.url + "/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + token,
      "Content-Type": "application/json",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  if (expectStream) {
    const text = await res.text();
    return { res, text };
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { res, text, json };
}

function textSseScenario() {
  return {
    events: [
      { event: "response.created", data: { type: "response.created", response: { id: "resp_1", model: "gpt-mock", created_at: 1700000000 } } },
      { event: "response.output_item.added", data: { type: "response.output_item.added", output_index: 0, item: { type: "message", role: "assistant" } } },
      { event: "response.output_text.delta", data: { type: "response.output_text.delta", delta: "Hel" } },
      { event: "response.output_text.delta", data: { type: "response.output_text.delta", delta: "lo" } },
      { event: "response.output_text.done", data: { type: "response.output_text.done", text: "Hello" } },
      { event: "response.completed", data: { type: "response.completed", response: { usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 } } } },
    ],
  };
}

function toolSseScenario() {
  return {
    events: [
      { event: "response.created", data: { response: { id: "resp_2", model: "gpt-mock", created_at: 1700000000 } } },
      { event: "response.output_item.added", data: { output_index: 0, item: { type: "function_call", call_id: "call_1", name: "get_weather" } } },
      { event: "response.function_call_arguments.delta", data: { output_index: 0, delta: '{"ci' } },
      { event: "response.function_call_arguments.delta", data: { output_index: 0, delta: 'ty":"Taipei"}' } },
      { event: "response.function_call_arguments.done", data: { output_index: 0, arguments: '{"city":"Taipei"}' } },
      { event: "response.output_item.done", data: { output_index: 0, item: { type: "function_call", call_id: "call_1", name: "get_weather", arguments: '{"city":"Taipei"}' } } },
      { event: "response.completed", data: { response: { usage: { input_tokens: 8, output_tokens: 12, total_tokens: 20 } } } },
    ],
  };
}

test("stream:true text response -> chat.completion.chunk SSE + [DONE], no raw events leak", async () => {
  const upstream = await startMockUpstream(async () => textSseScenario());
  const adapter = await startAdapter(upstream.url);
  try {
    const { res, text } = await postChat(adapter, {
      model: "gpt-test",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    }, { expectStream: true });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /text\/event-stream/);
    // No raw upstream events leak
    assert.ok(!/event:\s*response\.created/.test(text), "raw response.created leaked");
    assert.ok(!/event:\s*response\.output_text\.delta/.test(text), "raw delta leaked");
    assert.ok(!/event:\s*response\.completed/.test(text), "raw completed leaked");
    // Final line is [DONE]
    assert.match(text, /data: \[DONE\]\s*$/);
    // We expect at least one chat.completion.chunk
    assert.match(text, /"object":"chat\.completion\.chunk"/);
    // Content should reconstruct to "Hello"
    const dataLines = text.split(/\n\n/).filter(Boolean);
    let assembled = "";
    for (const blk of dataLines) {
      const m = blk.match(/^data: (.+)$/m);
      if (!m) continue;
      if (m[1] === "[DONE]") continue;
      let obj;
      try { obj = JSON.parse(m[1]); } catch { continue; }
      const c = obj.choices && obj.choices[0] && obj.choices[0].delta;
      if (c && typeof c.content === "string") assembled += c.content;
    }
    assert.equal(assembled, "Hello");
  } finally {
    await adapter.close();
    await upstream.close();
  }
});

test("stream:false text response -> single chat.completion JSON", async () => {
  const upstream = await startMockUpstream(async () => textSseScenario());
  const adapter = await startAdapter(upstream.url);
  try {
    const { res, json } = await postChat(adapter, {
      model: "gpt-test",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
    });
    assert.equal(res.status, 200);
    assert.equal(json.object, "chat.completion");
    assert.equal(json.choices[0].message.content, "Hello");
    assert.equal(json.choices[0].finish_reason, "stop");
    assert.deepEqual(json.usage, { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 });
    assert.equal(json.system_fingerprint, "fp_passthrough");
  } finally {
    await adapter.close();
    await upstream.close();
  }
});

test("stream:true with include_usage emits a usage chunk before [DONE]", async () => {
  const upstream = await startMockUpstream(async () => textSseScenario());
  const adapter = await startAdapter(upstream.url);
  try {
    const { text } = await postChat(adapter, {
      model: "gpt-test",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      stream_options: { include_usage: true },
    }, { expectStream: true });
    // Find the chunk with non-empty usage
    let usageChunk = null;
    for (const blk of text.split(/\n\n/)) {
      const m = blk.match(/^data: (.+)$/m);
      if (!m || m[1] === "[DONE]") continue;
      let obj; try { obj = JSON.parse(m[1]); } catch { continue; }
      if (obj.usage) usageChunk = obj;
    }
    assert.ok(usageChunk, "expected a usage chunk");
    assert.deepEqual(usageChunk.usage, { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 });
    assert.deepEqual(usageChunk.choices, []);
    // The [DONE] sentinel must come AFTER the usage chunk:
    const idxUsage = text.indexOf('"usage":{');
    const idxDone = text.indexOf("[DONE]");
    assert.ok(idxUsage > -1 && idxDone > -1 && idxUsage < idxDone, "usage must precede [DONE]");
  } finally {
    await adapter.close();
    await upstream.close();
  }
});

test("stream:false includes usage inside the JSON object", async () => {
  const upstream = await startMockUpstream(async () => textSseScenario());
  const adapter = await startAdapter(upstream.url);
  try {
    const { json } = await postChat(adapter, {
      model: "gpt-test",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
      stream_options: { include_usage: true }, // ignored for non-stream; usage always present
    });
    assert.deepEqual(json.usage, { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 });
  } finally {
    await adapter.close();
    await upstream.close();
  }
});

test("stream:true tool call -> tool_calls deltas + finish_reason tool_calls", async () => {
  const upstream = await startMockUpstream(async () => toolSseScenario());
  const adapter = await startAdapter(upstream.url);
  try {
    const { text } = await postChat(adapter, {
      model: "gpt-test",
      messages: [{ role: "user", content: "weather?" }],
      stream: true,
    }, { expectStream: true });
    // Reassemble tool args from streamed chunks
    let assembledArgs = "";
    let sawId = false, sawName = false, finalFinish = null;
    for (const blk of text.split(/\n\n/)) {
      const m = blk.match(/^data: (.+)$/m);
      if (!m || m[1] === "[DONE]") continue;
      let obj; try { obj = JSON.parse(m[1]); } catch { continue; }
      const ch = obj.choices && obj.choices[0];
      if (!ch) continue;
      if (ch.finish_reason) finalFinish = ch.finish_reason;
      const tcs = ch.delta && ch.delta.tool_calls;
      if (Array.isArray(tcs)) {
        for (const tc of tcs) {
          if (tc.id === "call_1") sawId = true;
          if (tc.function && tc.function.name === "get_weather") sawName = true;
          if (tc.function && typeof tc.function.arguments === "string") assembledArgs += tc.function.arguments;
        }
      }
    }
    assert.ok(sawId, "tool call id should appear");
    assert.ok(sawName, "tool call name should appear");
    assert.equal(assembledArgs, '{"city":"Taipei"}');
    assert.equal(finalFinish, "tool_calls");
  } finally {
    await adapter.close();
    await upstream.close();
  }
});

test("stream:false tool call -> message.tool_calls + finish_reason tool_calls", async () => {
  const upstream = await startMockUpstream(async () => toolSseScenario());
  const adapter = await startAdapter(upstream.url);
  try {
    const { json } = await postChat(adapter, {
      model: "gpt-test",
      messages: [{ role: "user", content: "weather?" }],
      stream: false,
    });
    assert.equal(json.choices[0].message.content, null);
    assert.equal(json.choices[0].finish_reason, "tool_calls");
    assert.deepEqual(json.choices[0].message.tool_calls, [
      { id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Taipei"}' } },
    ]);
  } finally {
    await adapter.close();
    await upstream.close();
  }
});

test("upstream non-2xx error is forwarded with status and JSON body", async () => {
  const upstream = await startMockUpstream(async () => ({
    status: 503,
    headers: { "Content-Type": "application/json" },
    body: { error: { message: "dry-run-required", type: "upstream_auth_error", code: "dry_run_refresh_required" } },
  }));
  const adapter = await startAdapter(upstream.url);
  try {
    const { res, json } = await postChat(adapter, {
      model: "gpt-test",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
    });
    assert.equal(res.status, 503);
    assert.equal(json.error.code, "dry_run_refresh_required");
  } finally {
    await adapter.close();
    await upstream.close();
  }
});

test("invalid adapter token -> 401 auth_error", async () => {
  const upstream = await startMockUpstream(async () => textSseScenario());
  const adapter = await startAdapter(upstream.url);
  try {
    const { res, json } = await postChat(adapter, {
      model: "gpt-test",
      messages: [{ role: "user", content: "hi" }],
    }, { token: "WRONG" });
    assert.equal(res.status, 401);
    assert.equal(json.error.type, "auth_error");
  } finally {
    await adapter.close();
    await upstream.close();
  }
});

test("invalid JSON body -> 400 invalid_request_error", async () => {
  const upstream = await startMockUpstream(async () => textSseScenario());
  const adapter = await startAdapter(upstream.url);
  try {
    const res = await fetch(adapter.url + "/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": "Bearer test-adapter-token",
        "Content-Type": "application/json",
      },
      body: "{not json",
    });
    const json = await res.json();
    assert.equal(res.status, 400);
    assert.equal(json.error.type, "invalid_request_error");
  } finally {
    await adapter.close();
    await upstream.close();
  }
});

test("body over max -> 413", async () => {
  const upstream = await startMockUpstream(async () => textSseScenario());
  const adapter = await startAdapter(upstream.url, { maxBodyBytes: 256 });
  try {
    const big = "x".repeat(2000);
    const res = await fetch(adapter.url + "/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": "Bearer test-adapter-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "gpt-test", messages: [{ role: "user", content: big }] }),
    });
    assert.equal(res.status, 413);
  } finally {
    await adapter.close();
    await upstream.close();
  }
});

test("upstream Content-Type lying as application/octet-stream still parses", async () => {
  // Default content-type in mock is already application/octet-stream, so the
  // text scenario already covers this. Make it explicit by re-asserting that
  // the upstream's response really does say application/octet-stream and the
  // adapter still translates correctly.
  const upstream = await startMockUpstream(async () => textSseScenario());
  // Sanity: probe upstream directly
  const probe = await fetch(upstream.url, {
    method: "POST",
    headers: { "Authorization": "Bearer test-upstream-token", "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-test", input: [], stream: true }),
  });
  assert.match(probe.headers.get("content-type") || "", /application\/octet-stream/);
  await probe.body.cancel();
  // Adapter must still produce a clean chat.completion.
  const adapter = await startAdapter(upstream.url);
  try {
    const { json } = await postChat(adapter, {
      model: "gpt-test",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
    });
    assert.equal(json.choices[0].message.content, "Hello");
  } finally {
    await adapter.close();
    await upstream.close();
  }
});

test("response.failed mid-stream emits SSE error payload + [DONE], no fake completion chunk", async () => {
  const upstream = await startMockUpstream(async () => ({
    events: [
      { event: "response.created", data: { response: { id: "r", model: "gpt-mock" } } },
      { event: "response.output_text.delta", data: { delta: "partial" } },
      { event: "response.failed", data: { response: { error: { message: "boom", type: "server_error", code: "e1" } } } },
    ],
  }));
  const adapter = await startAdapter(upstream.url);
  try {
    const { text, res } = await postChat(adapter, {
      model: "gpt-test",
      messages: [{ role: "user", content: "x" }],
      stream: true,
    }, { expectStream: true });
    assert.equal(res.status, 200);
    assert.match(text, /"error":\s*\{[^}]*"message":"boom"/);
    assert.match(text, /\[DONE\]/);
    // No fake finish chunk
    assert.ok(!/"finish_reason":"stop"/.test(text), "should not synthesize a stop finish_reason after failure");
  } finally {
    await adapter.close();
    await upstream.close();
  }
});

test("healthz returns 200 JSON", async () => {
  const upstream = await startMockUpstream(async () => textSseScenario());
  const adapter = await startAdapter(upstream.url);
  try {
    const res = await fetch(adapter.url + "/healthz");
    const json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.service, "openai-chat-responses-adapter");
  } finally {
    await adapter.close();
    await upstream.close();
  }
});

test("unknown route returns 404 OpenAI-shaped error", async () => {
  const upstream = await startMockUpstream(async () => textSseScenario());
  const adapter = await startAdapter(upstream.url);
  try {
    const res = await fetch(adapter.url + "/v1/chat/complete");
    const json = await res.json();
    assert.equal(res.status, 404);
    assert.equal(json.error.type, "not_found");
  } finally {
    await adapter.close();
    await upstream.close();
  }
});
