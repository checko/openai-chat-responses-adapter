// Chat Completions request -> Responses request translation.
//
// Always emits stream:true and store:false on the upstream request,
// regardless of what the client sent.  These two are project-wide
// invariants per plan §5 / §15.

const SUPPORTED_TOP = new Set([
  "model", "messages", "stream", "stream_options",
  "temperature", "top_p", "user", "metadata", "parallel_tool_calls",
  "reasoning_effort", "reasoning", "response_format", "tools", "tool_choice",
  "max_tokens", "max_completion_tokens", "store",
]);

export const REJECTED_IN_STRICT = [
  "n", "seed", "stop", "logprobs", "top_logprobs", "logit_bias",
  "frequency_penalty", "presence_penalty",
];
const REJECTED_IN_STRICT_SET = new Set(REJECTED_IN_STRICT);

export class TranslationError extends Error {
  constructor(message, { param = null, code = null } = {}) {
    super(message);
    this.name = "TranslationError";
    this.param = param;
    this.code = code;
  }
}

function joinTextParts(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const out = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if ((part.type === "text" || part.type === "input_text" || part.type === "output_text")
        && typeof part.text === "string") {
      out.push(part.text);
    }
  }
  return out.join("");
}

function userContentToParts(content) {
  if (typeof content === "string") {
    return content.length > 0 ? [{ type: "input_text", text: content }] : [];
  }
  if (!Array.isArray(content)) return [];
  const parts = [];
  for (const p of content) {
    if (!p || typeof p !== "object") continue;
    if (p.type === "text" && typeof p.text === "string") {
      parts.push({ type: "input_text", text: p.text });
    } else if (p.type === "input_text" && typeof p.text === "string") {
      parts.push({ type: "input_text", text: p.text });
    } else if (p.type === "image_url") {
      const url = typeof p.image_url === "string"
        ? p.image_url
        : (p.image_url && typeof p.image_url.url === "string" ? p.image_url.url : null);
      if (url) parts.push({ type: "input_image", image_url: url });
    }
    // Phase 1 deliberately drops input_audio and file content parts.
  }
  return parts;
}

function assistantTextParts(content) {
  if (typeof content === "string") {
    return content.length > 0 ? [{ type: "output_text", text: content }] : [];
  }
  if (!Array.isArray(content)) return [];
  const parts = [];
  for (const p of content) {
    if (!p || typeof p !== "object") continue;
    if ((p.type === "text" || p.type === "output_text") && typeof p.text === "string") {
      parts.push({ type: "output_text", text: p.text });
    }
  }
  return parts;
}

function mapResponseFormat(rf) {
  if (!rf || typeof rf !== "object") return null;
  if (rf.type === "text") return { format: { type: "text" } };
  if (rf.type === "json_object") return { format: { type: "json_object" } };
  if (rf.type === "json_schema") {
    const js = rf.json_schema || {};
    const out = { type: "json_schema" };
    if (typeof js.name === "string") out.name = js.name;
    if (typeof js.description === "string") out.description = js.description;
    if (js.schema !== undefined) out.schema = js.schema;
    if (typeof js.strict === "boolean") out.strict = js.strict;
    return { format: out };
  }
  return { format: rf };
}

function mapTools(tools, strict) {
  if (!Array.isArray(tools)) return null;
  return tools.map((t) => {
    if (t && t.type === "function" && t.function && typeof t.function === "object") {
      const f = t.function;
      const out = { type: "function", name: f.name };
      if (typeof f.description === "string") out.description = f.description;
      if (f.parameters !== undefined) out.parameters = f.parameters;
      if (typeof f.strict === "boolean") out.strict = f.strict;
      return out;
    }
    if (strict) {
      throw new TranslationError(
        `unsupported tool type: ${t && t.type}`,
        { param: "tools" },
      );
    }
    return t;
  });
}

function mapToolChoice(tc) {
  if (typeof tc === "string") return tc;
  if (tc && typeof tc === "object") {
    if (tc.type === "function" && tc.function && typeof tc.function.name === "string") {
      return { type: "function", name: tc.function.name };
    }
  }
  return tc;
}

function ensureString(v) {
  return typeof v === "string" ? v : String(v ?? "");
}

export function translateChatToResponses(chatBody, { strict = false } = {}) {
  if (!chatBody || typeof chatBody !== "object" || Array.isArray(chatBody)) {
    throw new TranslationError("request body must be a JSON object");
  }
  if (typeof chatBody.model !== "string" || chatBody.model.length === 0) {
    throw new TranslationError("model must be a non-empty string", { param: "model" });
  }
  if (!Array.isArray(chatBody.messages) || chatBody.messages.length === 0) {
    throw new TranslationError("messages must be a non-empty array", { param: "messages" });
  }

  if (strict) {
    for (const k of Object.keys(chatBody)) {
      if (REJECTED_IN_STRICT_SET.has(k)) {
        throw new TranslationError(`unsupported field in strict mode: ${k}`, { param: k });
      }
    }
  }

  const dropped = [];
  const out = {
    model: chatBody.model,
    stream: true,
    store: false,
  };

  const instructionsParts = [];
  const inputItems = [];

  for (const msg of chatBody.messages) {
    if (!msg || typeof msg !== "object") {
      throw new TranslationError("each message must be an object", { param: "messages" });
    }
    const role = msg.role;
    if (role === "system" || role === "developer") {
      const text = joinTextParts(msg.content);
      if (text.length > 0) instructionsParts.push(text);
    } else if (role === "user") {
      const parts = userContentToParts(msg.content);
      if (parts.length > 0) inputItems.push({ role: "user", content: parts });
    } else if (role === "assistant") {
      const textParts = assistantTextParts(msg.content);
      if (textParts.length > 0) {
        inputItems.push({ role: "assistant", content: textParts });
      }
      if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          if (!tc || tc.type !== "function" || !tc.function) continue;
          const args = typeof tc.function.arguments === "string"
            ? tc.function.arguments
            : JSON.stringify(tc.function.arguments ?? {});
          inputItems.push({
            type: "function_call",
            call_id: tc.id,
            name: tc.function.name,
            arguments: args,
          });
        }
      }
    } else if (role === "tool") {
      const callId = msg.tool_call_id;
      if (typeof callId !== "string" || callId.length === 0) {
        throw new TranslationError("tool message requires tool_call_id", { param: "tool_call_id" });
      }
      const output = typeof msg.content === "string"
        ? msg.content
        : joinTextParts(msg.content);
      inputItems.push({
        type: "function_call_output",
        call_id: callId,
        output: ensureString(output),
      });
    } else if (role === "function") {
      const callId = typeof msg.name === "string" && msg.name ? msg.name : "function";
      const output = typeof msg.content === "string" ? msg.content : joinTextParts(msg.content);
      inputItems.push({ type: "function_call_output", call_id: callId, output: ensureString(output) });
    } else {
      if (strict) throw new TranslationError(`unsupported role: ${role}`, { param: "role" });
      dropped.push(`message.role=${role}`);
    }
  }

  if (instructionsParts.length > 0) out.instructions = instructionsParts.join("\n\n");
  out.input = inputItems;

  if (typeof chatBody.temperature === "number") out.temperature = chatBody.temperature;
  if (typeof chatBody.top_p === "number") out.top_p = chatBody.top_p;
  if (typeof chatBody.user === "string") out.user = chatBody.user;
  if (chatBody.metadata && typeof chatBody.metadata === "object" && !Array.isArray(chatBody.metadata)) {
    out.metadata = chatBody.metadata;
  }
  if (typeof chatBody.parallel_tool_calls === "boolean") {
    out.parallel_tool_calls = chatBody.parallel_tool_calls;
  }
  if (typeof chatBody.reasoning_effort === "string") {
    out.reasoning = { effort: chatBody.reasoning_effort };
  }
  if (chatBody.reasoning && typeof chatBody.reasoning === "object" && !Array.isArray(chatBody.reasoning)) {
    out.reasoning = chatBody.reasoning;
  }
  if (chatBody.response_format) {
    const tf = mapResponseFormat(chatBody.response_format);
    if (tf) out.text = tf;
  }
  const tools = mapTools(chatBody.tools, strict);
  if (tools) out.tools = tools;
  if (chatBody.tool_choice !== undefined) {
    out.tool_choice = mapToolChoice(chatBody.tool_choice);
  }
  const mtok = typeof chatBody.max_completion_tokens === "number"
    ? chatBody.max_completion_tokens
    : (typeof chatBody.max_tokens === "number" ? chatBody.max_tokens : null);
  if (mtok !== null) out.max_output_tokens = mtok;

  for (const k of Object.keys(chatBody)) {
    if (!SUPPORTED_TOP.has(k)) dropped.push(k);
  }

  return { request: out, dropped };
}
