// In-process mock of the existing /v1/responses sidecar.
// Tests pass a `handler(req, body) -> { status, headers, events?, body? }`.
// When a handler returns events, the response is written as SSE-framed
// bytes with Content-Type: application/octet-stream by default, to
// reproduce the real-world bug where Codex returned SSE without the
// expected text/event-stream content type.

import { createServer } from "node:http";
import { Buffer } from "node:buffer";

export function startMockUpstream(handler) {
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      let body = {};
      const raw = Buffer.concat(chunks).toString("utf8");
      try { body = JSON.parse(raw); } catch {}
      let r;
      try { r = await handler(req, body); }
      catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: String(err && err.message || err) } }));
        return;
      }
      if (!r) { res.writeHead(500); res.end(); return; }
      const status = r.status || 200;
      const headers = r.headers || {
        "Content-Type": status === 200 ? "application/octet-stream" : "application/json",
      };
      res.writeHead(status, headers);
      if (status !== 200) {
        res.end(typeof r.body === "string" ? r.body : JSON.stringify(r.body || {}));
        return;
      }
      const events = r.events || [];
      for (const e of events) {
        const lines = [];
        if (e.event) lines.push("event: " + e.event);
        const data = typeof e.data === "string" ? e.data : JSON.stringify(e.data);
        for (const line of String(data).split("\n")) lines.push("data: " + line);
        res.write(lines.join("\n") + "\n\n");
        if (e.delay) await new Promise((rs) => setTimeout(rs, e.delay));
      }
      res.end();
    });
    req.on("error", () => {});
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({
        server,
        port: addr.port,
        url: `http://127.0.0.1:${addr.port}/v1/responses`,
        async close() { return new Promise((rs) => server.close(rs)); },
      });
    });
  });
}
