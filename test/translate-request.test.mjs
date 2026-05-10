import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  translateChatToResponses,
  TranslationError,
} from "../lib/translate-request.mjs";

const baseModel = "gpt-5.5";

test("system + developer messages join into instructions with double-newline", () => {
  const { request } = translateChatToResponses({
    model: baseModel,
    messages: [
      { role: "system", content: "be brief" },
      { role: "developer", content: "use markdown" },
      { role: "system", content: "no profanity" },
      { role: "user", content: "hi" },
    ],
  });
  assert.equal(request.instructions, "be brief\n\nuse markdown\n\nno profanity");
  assert.deepEqual(request.input, [
    { role: "user", content: [{ type: "input_text", text: "hi" }] },
  ]);
});

test("user string content -> input_text", () => {
  const { request } = translateChatToResponses({
    model: baseModel,
    messages: [{ role: "user", content: "hello" }],
  });
  assert.deepEqual(request.input, [
    { role: "user", content: [{ type: "input_text", text: "hello" }] },
  ]);
});

test("user image_url -> input_image", () => {
  const { request } = translateChatToResponses({
    model: baseModel,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "describe" },
          { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
        ],
      },
    ],
  });
  assert.deepEqual(request.input[0].content, [
    { type: "input_text", text: "describe" },
    { type: "input_image", image_url: "data:image/png;base64,abc" },
  ]);
});

test("assistant text -> output_text input item", () => {
  const { request } = translateChatToResponses({
    model: baseModel,
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "previous answer" },
    ],
  });
  assert.deepEqual(request.input[1], {
    role: "assistant",
    content: [{ type: "output_text", text: "previous answer" }],
  });
});

test("assistant tool_calls -> function_call items", () => {
  const { request } = translateChatToResponses({
    model: baseModel,
    messages: [
      { role: "user", content: "weather?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_123",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"Taipei"}' },
          },
        ],
      },
    ],
  });
  // user, function_call (no assistant text item because content is null)
  assert.equal(request.input.length, 2);
  assert.deepEqual(request.input[1], {
    type: "function_call",
    call_id: "call_123",
    name: "get_weather",
    arguments: '{"city":"Taipei"}',
  });
});

test("tool message -> function_call_output", () => {
  const { request } = translateChatToResponses({
    model: baseModel,
    messages: [
      { role: "user", content: "weather?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_123", type: "function", function: { name: "get_weather", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "call_123", content: "Sunny." },
    ],
  });
  assert.deepEqual(request.input[2], {
    type: "function_call_output",
    call_id: "call_123",
    output: "Sunny.",
  });
});

test("tools[] is flattened (function.* hoisted to top level)", () => {
  const { request } = translateChatToResponses({
    model: baseModel,
    messages: [{ role: "user", content: "x" }],
    tools: [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "wx",
          parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
          strict: true,
        },
      },
    ],
  });
  assert.deepEqual(request.tools, [
    {
      type: "function",
      name: "get_weather",
      description: "wx",
      parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
      strict: true,
    },
  ]);
});

test("tool_choice forced function -> { type: function, name }", () => {
  const { request } = translateChatToResponses({
    model: baseModel,
    messages: [{ role: "user", content: "x" }],
    tool_choice: { type: "function", function: { name: "get_weather" } },
  });
  assert.deepEqual(request.tool_choice, { type: "function", name: "get_weather" });
});

test("tool_choice string values pass through", () => {
  for (const v of ["auto", "none", "required"]) {
    const { request } = translateChatToResponses({
      model: baseModel,
      messages: [{ role: "user", content: "x" }],
      tool_choice: v,
    });
    assert.equal(request.tool_choice, v);
  }
});

test("client stream:false still produces upstream stream:true", () => {
  const { request } = translateChatToResponses({
    model: baseModel,
    messages: [{ role: "user", content: "x" }],
    stream: false,
  });
  assert.equal(request.stream, true);
});

test("upstream store is always false, even if client sends store:true", () => {
  const { request } = translateChatToResponses({
    model: baseModel,
    messages: [{ role: "user", content: "x" }],
    store: true,
  });
  assert.equal(request.store, false);
});

test("response_format json_schema -> text.format", () => {
  const { request } = translateChatToResponses({
    model: baseModel,
    messages: [{ role: "user", content: "x" }],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "Out",
        schema: { type: "object", properties: { ok: { type: "boolean" } } },
        strict: true,
      },
    },
  });
  assert.deepEqual(request.text, {
    format: {
      type: "json_schema",
      name: "Out",
      schema: { type: "object", properties: { ok: { type: "boolean" } } },
      strict: true,
    },
  });
});

test("max_completion_tokens overrides max_tokens for max_output_tokens", () => {
  const { request } = translateChatToResponses({
    model: baseModel,
    messages: [{ role: "user", content: "x" }],
    max_tokens: 100,
    max_completion_tokens: 200,
  });
  assert.equal(request.max_output_tokens, 200);
});

test("reasoning_effort wraps into reasoning.effort", () => {
  const { request } = translateChatToResponses({
    model: baseModel,
    messages: [{ role: "user", content: "x" }],
    reasoning_effort: "high",
  });
  assert.deepEqual(request.reasoning, { effort: "high" });
});

test("strict mode rejects 'n'", () => {
  assert.throws(
    () => translateChatToResponses(
      { model: baseModel, messages: [{ role: "user", content: "x" }], n: 2 },
      { strict: true },
    ),
    TranslationError,
  );
});

test("strict mode rejects 'frequency_penalty'", () => {
  assert.throws(
    () => translateChatToResponses(
      { model: baseModel, messages: [{ role: "user", content: "x" }], frequency_penalty: 0.1 },
      { strict: true },
    ),
    TranslationError,
  );
});

test("non-strict mode silently drops unsupported fields", () => {
  const { request, dropped } = translateChatToResponses({
    model: baseModel,
    messages: [{ role: "user", content: "x" }],
    n: 2,
    seed: 7,
    logit_bias: {},
  });
  assert.equal(request.input.length, 1);
  for (const k of ["n", "seed", "logit_bias"]) assert.ok(dropped.includes(k), `missing dropped: ${k}`);
});

test("missing model rejected", () => {
  assert.throws(
    () => translateChatToResponses({ messages: [{ role: "user", content: "x" }] }),
    TranslationError,
  );
});

test("empty messages rejected", () => {
  assert.throws(
    () => translateChatToResponses({ model: baseModel, messages: [] }),
    TranslationError,
  );
});

test("tool message without tool_call_id rejected", () => {
  assert.throws(
    () => translateChatToResponses({
      model: baseModel,
      messages: [{ role: "tool", content: "x" }],
    }),
    TranslationError,
  );
});

test("temperature/top_p/user/metadata pass through when valid", () => {
  const { request } = translateChatToResponses({
    model: baseModel,
    messages: [{ role: "user", content: "x" }],
    temperature: 0.5,
    top_p: 0.9,
    user: "u-1",
    metadata: { project: "p" },
    parallel_tool_calls: true,
  });
  assert.equal(request.temperature, 0.5);
  assert.equal(request.top_p, 0.9);
  assert.equal(request.user, "u-1");
  assert.deepEqual(request.metadata, { project: "p" });
  assert.equal(request.parallel_tool_calls, true);
});
