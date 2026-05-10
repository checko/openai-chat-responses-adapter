import { test } from "node:test";
import { strict as assert } from "node:assert";
import { Buffer } from "node:buffer";

import { createSseParser } from "../lib/sse-parser.mjs";

test("parses a single LF-terminated event", () => {
  const p = createSseParser();
  const blocks = p.push("event: foo\ndata: hello\n\n");
  assert.deepEqual(blocks, [{ event: "foo", data: "hello" }]);
});

test("parses CRLF-terminated event", () => {
  const p = createSseParser();
  const blocks = p.push("event: foo\r\ndata: hello\r\n\r\n");
  assert.deepEqual(blocks, [{ event: "foo", data: "hello" }]);
});

test("multiple data lines are joined with LF", () => {
  const p = createSseParser();
  const blocks = p.push("data: line1\ndata: line2\n\n");
  assert.deepEqual(blocks, [{ event: "message", data: "line1\nline2" }]);
});

test("comment-only blocks are ignored", () => {
  const p = createSseParser();
  const blocks = p.push(": heartbeat\n\n");
  assert.deepEqual(blocks, []);
});

test("event split across two pushes", () => {
  const p = createSseParser();
  let b = p.push("event: foo\ndata: hel");
  assert.deepEqual(b, []);
  b = p.push("lo\n\n");
  assert.deepEqual(b, [{ event: "foo", data: "hello" }]);
});

test("two events in a single push", () => {
  const p = createSseParser();
  const blocks = p.push("event: a\ndata: 1\n\nevent: b\ndata: 2\n\n");
  assert.deepEqual(blocks, [
    { event: "a", data: "1" },
    { event: "b", data: "2" },
  ]);
});

test("multibyte character split across pushes", () => {
  const p = createSseParser();
  const text = "data: héllo\n\n";
  const buf = Buffer.from(text, "utf8");
  // The é is two bytes 0xc3 0xa9 starting at index 7 ("data: h" is 7 bytes).
  const cut = 8; // splits between 0xc3 and 0xa9
  let blocks = p.push(buf.subarray(0, cut));
  assert.deepEqual(blocks, []);
  blocks = p.push(buf.subarray(cut));
  assert.deepEqual(blocks, [{ event: "message", data: "héllo" }]);
});

test("CRLF split across pushes does not prematurely terminate", () => {
  const p = createSseParser();
  let b = p.push("data: x\r");
  assert.deepEqual(b, []);
  b = p.push("\ndata: y\r\n\r\n");
  assert.deepEqual(b, [{ event: "message", data: "x\ny" }]);
});

test("flush returns trailing partial block without final blank line", () => {
  const p = createSseParser();
  let b = p.push("event: foo\ndata: hello");
  assert.deepEqual(b, []);
  const tail = p.flush();
  assert.deepEqual(tail, [{ event: "foo", data: "hello" }]);
});

test("optional space after colon is stripped exactly once", () => {
  const p = createSseParser();
  const blocks = p.push("data:  two-spaces\n\n");
  assert.deepEqual(blocks, [{ event: "message", data: " two-spaces" }]);
});

test("event field without leading space is accepted", () => {
  const p = createSseParser();
  const blocks = p.push("event:foo\ndata:bar\n\n");
  assert.deepEqual(blocks, [{ event: "foo", data: "bar" }]);
});

test("id and retry fields are ignored without breaking parse", () => {
  const p = createSseParser();
  const blocks = p.push("id: 7\nretry: 1000\nevent: foo\ndata: ok\n\n");
  assert.deepEqual(blocks, [{ event: "foo", data: "ok" }]);
});
