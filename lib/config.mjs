function parseInt10(value, fallback, name) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw new Error(`config: ${name} expected non-negative integer, got ${value}`);
  }
  return n;
}

function parseBool(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (value === "1" || value === "true" || value === "yes") return true;
  if (value === "0" || value === "false" || value === "no") return false;
  throw new Error(`config: expected boolean-ish, got ${value}`);
}

export function isLoopback(host) {
  if (!host) return false;
  if (host === "127.0.0.1" || host === "::1" || host === "localhost") return true;
  if (host.startsWith("127.")) return true;
  return false;
}

export function loadConfig(env = process.env) {
  const bind = env.ADAPTER_BIND || "127.0.0.1";
  const port = parseInt10(env.ADAPTER_PORT, 18891, "ADAPTER_PORT");
  const token = env.ADAPTER_TOKEN || "change-me";
  const upstreamUrl = env.RESPONSES_UPSTREAM_URL || "http://127.0.0.1:18890/v1/responses";
  const upstreamToken = env.RESPONSES_UPSTREAM_TOKEN || "change-me-upstream-token";
  const maxBodyBytes = parseInt10(env.ADAPTER_MAX_BODY_BYTES, 10485760, "ADAPTER_MAX_BODY_BYTES");
  const requestTimeoutMs = parseInt10(env.ADAPTER_REQUEST_TIMEOUT_MS, 300000, "ADAPTER_REQUEST_TIMEOUT_MS");
  const logLevel = env.ADAPTER_LOG_LEVEL || "info";
  const enableHealth = parseBool(env.ADAPTER_ENABLE_HEALTH, true);
  const strictCompat = parseBool(env.ADAPTER_STRICT_OPENAI_COMPAT, false);

  if (token === "change-me" && !isLoopback(bind)) {
    throw new Error(
      `refusing to start: ADAPTER_TOKEN is the placeholder "change-me" and ADAPTER_BIND=${bind} is not a loopback address. Set ADAPTER_TOKEN to a strong secret.`,
    );
  }

  return {
    bind,
    port,
    token,
    upstreamUrl,
    upstreamToken,
    maxBodyBytes,
    requestTimeoutMs,
    logLevel,
    enableHealth,
    strictCompat,
  };
}

export function redactToken(t) {
  if (!t) return "<unset>";
  const s = String(t);
  if (s.length <= 4) return "***";
  return s.slice(0, 3) + "***";
}
