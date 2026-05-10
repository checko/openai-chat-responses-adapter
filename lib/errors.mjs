export function toOpenAIError({ message, type = "invalid_request_error", code = null, param = null }) {
  const err = { message: String(message ?? "unknown error"), type };
  if (code !== null && code !== undefined) err.code = code;
  if (param !== null && param !== undefined) err.param = param;
  return { error: err };
}

export function sendJsonError(res, status, message, type, code) {
  if (res.headersSent) return;
  const body = JSON.stringify(toOpenAIError({ message, type, code }));
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}
