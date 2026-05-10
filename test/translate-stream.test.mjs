import { test } from "node:test";
import { strict as assert } from "node:assert";

import { StreamTranslator } from "../lib/translate-stream.mjs";

function drive(events, opts = {}) {
  const t = new StreamTranslator({ id: "chatcmpl-test", model: "gpt-test", ...opts });
  const chunks = [];
  for (const e of events) {
    for (const c of t.onEvent(e.event, e.data)) chunks.push(c);
  }
  const end = t.end();
  for (const c of end.chunks) chunks.push(c);
  return { chunks, end, translator: t };
}

test("text-only happy path: role chunk, deltas, finish chunk", () => {
  const { chunks } = drive([
    { event: "response.created", data: { response: { id: "resp_1", model: "gpt-test", created_at: 1700000000 } } },
    { event: "response.output_item.added", data: { output_index: 0, item: { type: "message", role: "assistant" } } },
    { event: "response.output_text.delta", data: { delta: "Hel" } },
    { event: "response.output_text.delta", data: { delta: "lo" } },
    { event: "response.output_text.done", data: { text: "Hello" } },
    { event: "response.completed", data: { response: { usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 } } } },
  ]);
  // Expected sequence: role, "Hel", "lo", finish
  assert.equal(chunks.length, 4);
  assert.deepEqual(chunks[0].choices[0].delta, { role: "assistant", content: "" });
  assert.equal(chunks[1].choices[0].delta.content, "Hel");
  assert.equal(chunks[2].choices[0].delta.content, "lo");
  assert.deepEqual(chunks[3].choices[0], { index: 0, delta: {}, finish_reason: "stop" });
  // No system_fingerprint on streaming chunks
  for (const c of chunks) assert.ok(!("system_fingerprint" in c), "no system_fingerprint on streaming chunks");
});

test("output_text.done emits suffix when deltas are short", () => {
  const { chunks } = drive([
    { event: "response.output_text.delta", data: { delta: "Hel" } },
    { event: "response.output_text.done", data: { text: "Hello" } },
    { event: "response.completed", data: { response: {} } },
  ]);
  // role, "Hel", "lo" (suffix), finish
  const contents = chunks.filter((c) => c.choices[0] && c.choices[0].delta && "content" in c.choices[0].delta)
    .map((c) => c.choices[0].delta.content);
  assert.deepEqual(contents, ["", "Hel", "lo"]); // role chunk has content:"" then deltas
  assert.equal(chunks.at(-1).choices[0].finish_reason, "stop");
});

test("output_text.done with non-prefix text does NOT emit", () => {
  const { chunks } = drive([
    { event: "response.output_text.delta", data: { delta: "Hello" } },
    { event: "response.output_text.done", data: { text: "Goodbye" } }, // mismatch
    { event: "response.completed", data: { response: {} } },
  ]);
  const contents = chunks.filter((c) => c.choices[0] && c.choices[0].delta && "content" in c.choices[0].delta)
    .map((c) => c.choices[0].delta.content);
  assert.deepEqual(contents, ["", "Hello"]);
});

test("usage chunk emitted before [DONE] when includeUsage=true", () => {
  const { chunks, end } = drive([
    { event: "response.output_text.delta", data: { delta: "x" } },
    { event: "response.completed", data: { response: { usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 } } } },
  ], { includeUsage: true });
  // chunks: role, "x", finish, usage
  assert.equal(chunks.at(-1).usage.prompt_tokens, 10);
  assert.equal(chunks.at(-1).usage.completion_tokens, 20);
  assert.equal(chunks.at(-1).usage.total_tokens, 30);
  assert.deepEqual(chunks.at(-1).choices, []);
  assert.equal(end.errorEvent, null);
});

test("includeUsage=false omits usage chunk", () => {
  const { chunks } = drive([
    { event: "response.output_text.delta", data: { delta: "x" } },
    { event: "response.completed", data: { response: { usage: { input_tokens: 10, output_tokens: 20 } } } },
  ], { includeUsage: false });
  assert.ok(!chunks.some((c) => c.usage), "no usage chunk should appear");
});

test("tool call streaming: id+name chunk, args deltas, finish=tool_calls", () => {
  const events = [
    { event: "response.created", data: { response: { id: "resp_1", model: "gpt-test", created_at: 1700000000 } } },
    { event: "response.output_item.added", data: { output_index: 0, item: { type: "function_call", call_id: "call_1", name: "get_weather" } } },
    { event: "response.function_call_arguments.delta", data: { output_index: 0, delta: '{"ci' } },
    { event: "response.function_call_arguments.delta", data: { output_index: 0, delta: 'ty":"Taipei"}' } },
    { event: "response.function_call_arguments.done", data: { output_index: 0, arguments: '{"city":"Taipei"}' } },
    { event: "response.output_item.done", data: { output_index: 0, item: { type: "function_call", call_id: "call_1", name: "get_weather", arguments: '{"city":"Taipei"}' } } },
    { event: "response.completed", data: { response: { usage: { input_tokens: 5, output_tokens: 10 } } } },
  ];
  const { chunks } = drive(events);
  // Find tool_calls deltas
  const toolDeltas = chunks
    .map((c) => c.choices && c.choices[0] && c.choices[0].delta && c.choices[0].delta.tool_calls)
    .filter(Boolean);
  // First tool delta: index 0, type "function", id, name, arguments=""
  assert.equal(toolDeltas[0][0].index, 0);
  assert.equal(toolDeltas[0][0].id, "call_1");
  assert.equal(toolDeltas[0][0].type, "function");
  assert.equal(toolDeltas[0][0].function.name, "get_weather");
  // Subsequent tool deltas only have arguments
  const argChunks = toolDeltas.slice(1).map((td) => td[0].function && td[0].function.arguments).filter((x) => x !== undefined);
  assert.equal(argChunks.join(""), '{"city":"Taipei"}');
  // Final chunk has finish_reason: tool_calls
  assert.equal(chunks.at(-1).choices[0].finish_reason, "tool_calls");
});

test("tool call delivered ONLY at output_item.done (no prior added/deltas)", () => {
  const events = [
    { event: "response.created", data: { response: { id: "resp_1", model: "gpt-test" } } },
    {
      event: "response.output_item.done",
      data: {
        output_index: 0,
        item: {
          type: "function_call",
          call_id: "call_x",
          name: "do_thing",
          arguments: '{"a":1}',
        },
      },
    },
    { event: "response.completed", data: { response: {} } },
  ];
  const { chunks } = drive(events);
  // Should still get a tool-call chunk and finish_reason: tool_calls
  const toolDeltas = chunks
    .map((c) => c.choices && c.choices[0] && c.choices[0].delta && c.choices[0].delta.tool_calls)
    .filter(Boolean);
  // First tool chunk carries id+name, then a separate args chunk for the arguments suffix
  assert.ok(toolDeltas.length >= 1);
  const flat = toolDeltas.flat();
  const allArgs = flat.map((tc) => (tc.function && tc.function.arguments) || "").join("");
  assert.equal(allArgs, '{"a":1}');
  assert.ok(flat.some((tc) => tc.id === "call_x"), "id should appear");
  assert.ok(flat.some((tc) => tc.function && tc.function.name === "do_thing"), "name should appear");
  assert.equal(chunks.at(-1).choices[0].finish_reason, "tool_calls");
});

test("function_call_arguments.done suffix is emitted if deltas were short", () => {
  const events = [
    { event: "response.output_item.added", data: { output_index: 0, item: { type: "function_call", call_id: "c1", name: "f" } } },
    { event: "response.function_call_arguments.delta", data: { output_index: 0, delta: '{"a":1' } },
    { event: "response.function_call_arguments.done", data: { output_index: 0, arguments: '{"a":1, "b":2}' } },
    { event: "response.completed", data: { response: {} } },
  ];
  const { chunks } = drive(events);
  const toolDeltas = chunks
    .map((c) => c.choices && c.choices[0] && c.choices[0].delta && c.choices[0].delta.tool_calls)
    .filter(Boolean);
  const allArgs = toolDeltas.flat()
    .map((tc) => (tc.function && tc.function.arguments) || "")
    .join("");
  assert.equal(allArgs, '{"a":1, "b":2}');
});

test("output_item.done backfills missing tool name and id", () => {
  const events = [
    { event: "response.function_call_arguments.delta", data: { output_index: 0, item_id: "fc_1", delta: '{}' } },
    { event: "response.function_call_arguments.done", data: { output_index: 0, arguments: '{}' } },
    { event: "response.output_item.done", data: { output_index: 0, item: { type: "function_call", call_id: "call_late", name: "late_named", arguments: '{}' } } },
    { event: "response.completed", data: { response: {} } },
  ];
  const { chunks, translator } = drive(events);
  // The non-stream final assembly should have correct id and name
  const final = translator.toFinalCompletion();
  assert.equal(final.choices[0].message.tool_calls[0].id, "call_late");
  assert.equal(final.choices[0].message.tool_calls[0].function.name, "late_named");
  assert.equal(final.choices[0].finish_reason, "tool_calls");
  // And the streaming side should have emitted a corrective chunk with id+name
  const toolDeltas = chunks
    .map((c) => c.choices && c.choices[0] && c.choices[0].delta && c.choices[0].delta.tool_calls)
    .filter(Boolean).flat();
  assert.ok(toolDeltas.some((tc) => tc.id === "call_late"));
  assert.ok(toolDeltas.some((tc) => tc.function && tc.function.name === "late_named"));
});

test("response.failed reports an errorEvent and emits no finish chunk", () => {
  const { chunks, end } = drive([
    { event: "response.output_text.delta", data: { delta: "partial" } },
    { event: "response.failed", data: { response: { error: { message: "kaboom", type: "server_error", code: "x1" } } } },
  ]);
  assert.notEqual(end.errorEvent, null);
  assert.equal(end.errorEvent.message, "kaboom");
  assert.equal(end.errorEvent.code, "x1");
  // The final chunk emitted by .end() must NOT be a fake finish chunk:
  // chunks should contain only the role chunk and the partial delta — nothing from end().
  const finishLike = chunks.filter((c) => c.choices[0] && c.choices[0].finish_reason);
  assert.equal(finishLike.length, 0);
});

test("incomplete_details reason=max_output_tokens -> finish_reason=length", () => {
  const { chunks } = drive([
    { event: "response.output_text.delta", data: { delta: "partial" } },
    { event: "response.completed", data: { response: { incomplete_details: { reason: "max_output_tokens" } } } },
  ]);
  assert.equal(chunks.at(-1).choices[0].finish_reason, "length");
});

test("reasoning_text.delta emits delta.reasoning_content, not delta.content", () => {
  const { chunks } = drive([
    { event: "response.reasoning_text.delta", data: { delta: "thinking..." } },
    { event: "response.output_text.delta", data: { delta: "answer" } },
    { event: "response.completed", data: { response: {} } },
  ]);
  const reasoning = chunks
    .map((c) => c.choices[0] && c.choices[0].delta && c.choices[0].delta.reasoning_content)
    .filter((x) => x !== undefined);
  assert.deepEqual(reasoning, ["thinking..."]);
  // Make sure reasoning is never in delta.content:
  for (const c of chunks) {
    const d = c.choices[0] && c.choices[0].delta;
    if (d && d.reasoning_content !== undefined) {
      assert.ok(!("content" in d), "reasoning_content chunk must not also have content");
    }
  }
});
