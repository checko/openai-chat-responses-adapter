import { createServer } from "node:http";
import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";

import { loadConfig, redactToken } from "./lib/config.mjs";
import { createLogger } from "./lib/log.mjs";
import { newChatCompletionId, newRequestId } from "./lib/ids.mjs";
import { sendJsonError, toOpenAIError } from "./lib/errors.mjs";
import { translateChatToResponses, TranslationError } from "./lib/translate-request.mjs";
import { createSseParser } from "./lib/sse-parser.mjs";
import { StreamTranslator } from "./lib/translate-stream.mjs";

function compareTokens(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function checkAuth(req, expected) {
  const auth = req.headers["authorization"] || "";
  const m = auth.match(/^Bearer\s+(.+)$/);
  if (!m) return false;
  return compareTokens(m[1], expected);
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let total = 0;
    let rejected = false;
    const chunks = [];
    req.on("data", (c) => {
      if (rejected) return; // discard further data; let the upload finish so
                            // the 413 response can be flushed cleanly.
      total += c.length;
      if (total > maxBytes) {
        rejected = true;
        const err = new Error("body too large");
        err.code = "EBODY_TOO_LARGE";
        reject(err);
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => { if (!rejected) resolve(Buffer.concat(chunks)); });
    req.on("error", (e) => { if (!rejected) reject(e); });
  });
}

function writeSseLine(res, obj) {
  res.write("data: " + JSON.stringify(obj) + "\n\n");
}

function writeSseDone(res) {
  res.write("data: [DONE]\n\n");
}

async function handleChatCompletions(req, res, ctx) {
  const { config, log, reqId } = ctx;
  const t0 = Date.now();
  if (!checkAuth(req, config.token)) {
    sendJsonError(res, 401, "bad adapter token", "auth_error");
    log.warn({ reqId, route: req.url, status: 401, reason: "bad token" });
    return;
  }
  let bodyBuf;
  try {
    bodyBuf = await readBody(req, config.maxBodyBytes);
  } catch (err) {
    if (err.code === "EBODY_TOO_LARGE") {
      sendJsonError(res, 413, "request body too large", "invalid_request_error");
    } else if (!res.headersSent) {
      sendJsonError(res, 400, "could not read request body", "invalid_request_error");
    }
    return;
  }
  let chatBody;
  try {
    chatBody = JSON.parse(bodyBuf.toString("utf8"));
  } catch (err) {
    sendJsonError(res, 400, "invalid JSON: " + err.message, "invalid_request_error");
    return;
  }

  let translation;
  try {
    translation = translateChatToResponses(chatBody, { strict: config.strictCompat });
  } catch (err) {
    if (err instanceof TranslationError) {
      sendJsonError(res, 400, err.message, "invalid_request_error");
      return;
    }
    throw err;
  }
  if (translation.dropped.length > 0) {
    log.debug({ reqId, dropped: translation.dropped });
  }

  const isClientStreaming = chatBody.stream === true;
  const includeUsage =
    isClientStreaming
    && chatBody.stream_options
    && typeof chatBody.stream_options === "object"
    && chatBody.stream_options.include_usage === true;

  const ctrl = new AbortController();
  const timeoutId = setTimeout(() => ctrl.abort("timeout"), config.requestTimeoutMs);
  const onClientClose = () => ctrl.abort("client closed");
  req.on("close", onClientClose);
  const cleanup = () => {
    clearTimeout(timeoutId);
    req.off("close", onClientClose);
  };

  let upstream;
  try {
    upstream = await fetch(config.upstreamUrl, {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + config.upstreamToken,
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
      },
      body: JSON.stringify(translation.request),
      signal: ctrl.signal,
    });
  } catch (err) {
    cleanup();
    if (err.name === "AbortError") {
      const reason = ctrl.signal.reason;
      if (reason === "timeout") {
        sendJsonError(res, 504, "upstream timeout", "timeout");
      } else if (!res.headersSent) {
        // Client closed before we got headers — best-effort 499-ish.
        try { res.destroy(); } catch {}
      }
    } else {
      sendJsonError(res, 502, "upstream request failed: " + err.message, "bad_gateway");
    }
    log.error({ reqId, err: String(err), route: req.url });
    return;
  }

  if (!upstream.ok) {
    cleanup();
    let payload;
    try {
      const text = await upstream.text();
      try { payload = JSON.parse(text); }
      catch { payload = toOpenAIError({ message: text || "upstream error", type: "upstream_error" }); }
    } catch {
      payload = toOpenAIError({ message: "upstream error", type: "upstream_error" });
    }
    res.writeHead(upstream.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
    log.warn({ reqId, route: req.url, upstreamStatus: upstream.status, latencyMs: Date.now() - t0 });
    return;
  }

  const id = newChatCompletionId();
  const translator = new StreamTranslator({
    id,
    model: chatBody.model || "unknown",
    includeUsage,
  });
  const parser = createSseParser();

  let headersFlushed = false;
  if (isClientStreaming) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
    headersFlushed = true;
  }

  const handleBlock = (blk) => {
    if (!blk || !blk.data) return;
    if (blk.data === "[DONE]") return;
    let parsed;
    try { parsed = JSON.parse(blk.data); }
    catch { return; }
    const chunks = translator.onEvent(blk.event, parsed);
    if (isClientStreaming) {
      for (const c of chunks) writeSseLine(res, c);
    }
  };

  const body = upstream.body;
  if (!body) {
    cleanup();
    if (!headersFlushed) {
      sendJsonError(res, 502, "upstream returned no body", "bad_gateway");
    } else {
      writeSseLine(res, toOpenAIError({ message: "upstream returned no body", type: "bad_gateway" }));
      writeSseDone(res);
      res.end();
    }
    return;
  }

  const reader = body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const blocks = parser.push(value);
      for (const blk of blocks) handleBlock(blk);
    }
    for (const blk of parser.flush()) handleBlock(blk);
  } catch (err) {
    cleanup();
    if (!headersFlushed) {
      sendJsonError(res, 502, "upstream stream error: " + err.message, "bad_gateway");
    } else {
      writeSseLine(res, toOpenAIError({ message: err.message, type: "upstream_error" }));
      writeSseDone(res);
      res.end();
    }
    log.error({ reqId, err: String(err), route: req.url });
    return;
  }

  cleanup();

  const final = translator.end();
  if (isClientStreaming) {
    if (final.errorEvent) {
      writeSseLine(res, toOpenAIError(final.errorEvent));
      writeSseDone(res);
    } else {
      for (const c of final.chunks) writeSseLine(res, c);
      writeSseDone(res);
    }
    res.end();
  } else {
    if (final.errorEvent) {
      sendJsonError(res, 502, final.errorEvent.message, final.errorEvent.type, final.errorEvent.code);
    } else {
      const json = translator.toFinalCompletion();
      const out = JSON.stringify(json);
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(out),
      });
      res.end(out);
    }
  }

  log.info({
    reqId,
    route: "/v1/chat/completions",
    model: chatBody.model,
    clientStream: isClientStreaming,
    upstreamStatus: upstream.status,
    latencyMs: Date.now() - t0,
  });
}

function handleHealth(req, res, cfg) {
  const body = JSON.stringify({
    ok: true,
    service: "openai-chat-responses-adapter",
    upstream: cfg.upstreamUrl,
  });
  res.writeHead(200, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function handle404(req, res) {
  sendJsonError(res, 404, `route not found: ${req.method} ${req.url}`, "not_found");
}

export function buildServer(config, log) {
  return createServer((req, res) => {
    const reqId = newRequestId();
    res.setHeader("X-Request-Id", reqId);
    const ctx = { config, log, reqId };
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      handleChatCompletions(req, res, ctx).catch((err) => {
        log.error({ reqId, err: String(err) });
        if (!res.headersSent) sendJsonError(res, 500, "internal error", "internal_error");
        else { try { res.end(); } catch {} }
      });
    } else if (req.method === "GET" && req.url === "/healthz" && config.enableHealth) {
      handleHealth(req, res, config);
    } else {
      handle404(req, res);
    }
  });
}

export function startServer(opts = {}) {
  const config = opts.config || loadConfig();
  const log = opts.log || createLogger({ level: config.logLevel });
  const server = buildServer(config, log);
  return new Promise((resolve) => {
    server.listen(config.port, config.bind, () => {
      log.info({
        msg: "started",
        bind: config.bind,
        port: config.port,
        upstream: config.upstreamUrl,
        token: redactToken(config.token),
        upstreamToken: redactToken(config.upstreamToken),
        maxBodyBytes: config.maxBodyBytes,
        timeoutMs: config.requestTimeoutMs,
        strict: config.strictCompat,
      });
      resolve({ server, config, log });
    });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startServer().catch((err) => {
    process.stderr.write("startup failed: " + (err && err.message ? err.message : err) + "\n");
    process.exit(1);
  });
}
