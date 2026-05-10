// Live smoke test against a real /v1/responses sidecar.
//
// This test is INTENTIONALLY not run from `npm test`. Run it manually:
//
//   ADAPTER_LIVE_SMOKE=1 \
//   ADAPTER_TOKEN=<your-adapter-token> \
//   RESPONSES_UPSTREAM_URL=http://127.0.0.1:18890/v1/responses \
//   RESPONSES_UPSTREAM_TOKEN=<sidecar-token> \
//   node test/smoke-live.mjs
//
// It boots the adapter on an ephemeral port and exercises spec §19.3.

import { strict as assert } from "node:assert";

import { buildServer } from "../server.mjs";
import { createLogger } from "../lib/log.mjs";

if (process.env.ADAPTER_LIVE_SMOKE !== "1") {
  console.log("ADAPTER_LIVE_SMOKE != 1 — skipping live smoke test.");
  process.exit(0);
}

const log = createLogger({ level: "info" });

const cfg = {
  bind: "127.0.0.1",
  port: 0,
  token: process.env.ADAPTER_TOKEN || "smoke-token",
  upstreamUrl: process.env.RESPONSES_UPSTREAM_URL || "http://127.0.0.1:18890/v1/responses",
  upstreamToken: process.env.RESPONSES_UPSTREAM_TOKEN || "change-me-upstream-token",
  maxBodyBytes: 10 * 1024 * 1024,
  requestTimeoutMs: 60_000,
  logLevel: "info",
  enableHealth: true,
  strictCompat: false,
};

const server = buildServer(cfg, log);
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const url = `http://127.0.0.1:${port}/v1/chat/completions`;

async function main() {
  console.log("=== non-stream test ===");
  {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + cfg.token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.LIVE_MODEL || "gpt-5.5",
        messages: [
          { role: "system", content: "Reply exactly ADAPTER_NONSTREAM_OK." },
          { role: "user", content: "test" },
        ],
        stream: false,
      }),
    });
    assert.equal(res.status, 200, "non-stream status");
    const json = await res.json();
    assert.equal(json.object, "chat.completion");
    console.log("non-stream content:", JSON.stringify(json.choices[0].message.content));
  }

  console.log("=== stream test ===");
  {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + cfg.token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.LIVE_MODEL || "gpt-5.5",
        messages: [
          { role: "system", content: "Reply exactly ADAPTER_STREAM_OK." },
          { role: "user", content: "test" },
        ],
        stream: true,
        stream_options: { include_usage: true },
      }),
    });
    assert.equal(res.status, 200, "stream status");
    const text = await res.text();
    assert.ok(/data: \[DONE\]/.test(text), "[DONE] terminator present");
    assert.ok(!/event:\s*response\.created/.test(text), "raw response.created leaked");
    assert.ok(!/event:\s*response\.output_text\.delta/.test(text), "raw delta leaked");
    console.log("stream first 200 chars:", text.slice(0, 200));
  }

  console.log("OK");
}

try { await main(); }
finally { server.close(); }
