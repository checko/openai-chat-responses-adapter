import { test } from "node:test";
import { strict as assert } from "node:assert";

import { runBuffered } from "../lib/translate-buffer.mjs";

test("text response -> chat.completion JSON with content + usage + fingerprint", () => {
  const events = [
    { event: "response.created", data: { response: { model: "gpt-test", created_at: 1700000000 } } },
    { event: "response.output_text.delta", data: { delta: "Hello, " } },
    { event: "response.output_text.delta", data: { delta: "world." } },
    { event: "response.output_text.done", data: { text: "Hello, world." } },
    { event: "response.completed", data: { response: { usage: { input_tokens: 4, output_tokens: 5, total_tokens: 9 } } } },
  ];
  const json = runBuffered(events, { id: "chatcmpl-x", model: "gpt-test" });
  assert.equal(json.object, "chat.completion");
  assert.equal(json.id, "chatcmpl-x");
  assert.equal(json.choices[0].message.role, "assistant");
  assert.equal(json.choices[0].message.content, "Hello, world.");
  assert.equal(json.choices[0].finish_reason, "stop");
  assert.deepEqual(json.usage, { prompt_tokens: 4, completion_tokens: 5, total_tokens: 9 });
  assert.equal(json.system_fingerprint, "fp_passthrough");
});

test("tool call response -> message.tool_calls, content null, finish_reason tool_calls", () => {
  const events = [
    { event: "response.output_item.added", data: { output_index: 0, item: { type: "function_call", call_id: "call_1", name: "get_weather" } } },
    { event: "response.function_call_arguments.delta", data: { output_index: 0, delta: '{"city":"Taipei"}' } },
    { event: "response.function_call_arguments.done", data: { output_index: 0, arguments: '{"city":"Taipei"}' } },
    { event: "response.output_item.done", data: { output_index: 0, item: { type: "function_call", call_id: "call_1", name: "get_weather", arguments: '{"city":"Taipei"}' } } },
    { event: "response.completed", data: { response: { usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } } } },
  ];
  const json = runBuffered(events, { id: "chatcmpl-tc", model: "gpt-test" });
  assert.equal(json.choices[0].message.content, null);
  assert.equal(json.choices[0].finish_reason, "tool_calls");
  assert.deepEqual(json.choices[0].message.tool_calls, [
    {
      id: "call_1",
      type: "function",
      function: { name: "get_weather", arguments: '{"city":"Taipei"}' },
    },
  ]);
});

test("tool call delivered only at output_item.done still buffers correctly", () => {
  const events = [
    { event: "response.output_item.done", data: { output_index: 0, item: { type: "function_call", call_id: "call_only", name: "f", arguments: '{"a":1}' } } },
    { event: "response.completed", data: { response: {} } },
  ];
  const json = runBuffered(events);
  assert.equal(json.choices[0].finish_reason, "tool_calls");
  assert.deepEqual(json.choices[0].message.tool_calls, [
    { id: "call_only", type: "function", function: { name: "f", arguments: '{"a":1}' } },
  ]);
});

test("response.failed propagates as { error } envelope", () => {
  const events = [
    { event: "response.failed", data: { response: { error: { message: "boom", type: "server_error", code: "e1" } } } },
  ];
  const out = runBuffered(events);
  assert.ok(out.error);
  assert.equal(out.error.message, "boom");
  assert.equal(out.error.code, "e1");
});

test("usage mapping handles missing total_tokens", () => {
  const events = [
    { event: "response.output_text.delta", data: { delta: "x" } },
    { event: "response.completed", data: { response: { usage: { input_tokens: 7, output_tokens: 3 } } } },
  ];
  const json = runBuffered(events);
  assert.deepEqual(json.usage, { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 });
});
