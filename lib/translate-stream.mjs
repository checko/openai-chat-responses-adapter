// Stateful translator: Responses SSE events -> Chat Completions chunks.
//
// Per plan §8:
//   - Streaming chunks NEVER carry system_fingerprint.
//   - Non-streaming `chat.completion` JSON sets system_fingerprint = "fp_passthrough".
//   - Final streaming chunk is a finish-only chunk: { delta: {}, finish_reason }.
//   - response.output_text.done is treated as a suffix fallback.
//   - response.output_item.done for function_call is reconciliation/fallback:
//     it backfills call_id / name / arguments, emitting prefix-diff suffix
//     deltas where useful.
//   - delta.reasoning_content is emitted only for reasoning events; never
//     mixed into delta.content.
//   - finish_reason = "tool_calls" iff a tool call was finalized via either
//     function_call_arguments.done OR output_item.done(function_call) AND
//     no later assistant text supersedes it.

import { newChatCompletionId } from "./ids.mjs";

export class StreamTranslator {
  constructor({
    id = newChatCompletionId(),
    model = "unknown",
    includeUsage = false,
  } = {}) {
    this.id = id;
    this.model = model;
    this.created = Math.floor(Date.now() / 1000);
    this.includeUsage = includeUsage;

    this.roleEmitted = false;
    this.outputTextBuf = "";

    // Map<output_index, { id, name, argsBuf, indexInChat }>
    this.toolsByIndex = new Map();
    this.nextChatToolIndex = 0;
    this.toolFinalized = new Set();

    this.usage = null;
    this.incompleteReason = null;
    this.errored = null;
    this.completed = false;

    // Logical clock for ordering "did text come after the last tool finalize?"
    this._tick = 0;
    this.lastTextActivityAt = -1;
    this.lastToolFinalizeAt = -1;
  }

  _baseChunk() {
    return {
      id: this.id,
      object: "chat.completion.chunk",
      created: this.created,
      model: this.model,
      // intentionally NO system_fingerprint key on streaming chunks
      choices: [],
    };
  }

  _emitRoleIfNeeded(out) {
    if (this.roleEmitted) return;
    this.roleEmitted = true;
    out.push({
      ...this._baseChunk(),
      choices: [{
        index: 0,
        delta: { role: "assistant", content: "" },
        finish_reason: null,
      }],
    });
  }

  _toolDeltaChunk(indexInChat, { id, name, argumentsDelta, isFirst }) {
    const tc = { index: indexInChat };
    if (id !== undefined) tc.id = id;
    if (isFirst) tc.type = "function";
    const fn = {};
    let hasFn = false;
    if (name !== undefined) { fn.name = name; hasFn = true; }
    if (argumentsDelta !== undefined) { fn.arguments = argumentsDelta; hasFn = true; }
    else if (isFirst) { fn.arguments = ""; hasFn = true; }
    if (hasFn) tc.function = fn;
    return {
      ...this._baseChunk(),
      choices: [{
        index: 0,
        delta: { tool_calls: [tc] },
        finish_reason: null,
      }],
    };
  }

  _markTextActivity() { this.lastTextActivityAt = ++this._tick; }
  _markToolFinalize() { this.lastToolFinalizeAt = ++this._tick; }

  onEvent(eventName, data) {
    const out = [];
    const ev = eventName || (data && data.type) || "message";
    switch (ev) {
      case "response.created": {
        const r = data && data.response;
        if (r) {
          if (typeof r.model === "string" && r.model.length > 0) this.model = r.model;
          if (typeof r.created_at === "number") this.created = r.created_at;
        }
        break;
      }
      case "response.in_progress":
      case "response.content_part.added":
      case "response.content_part.done":
        break;

      case "response.output_item.added": {
        const item = data && data.item;
        if (!item) break;
        if (item.type === "function_call") {
          const oi = data.output_index;
          if (!this.toolsByIndex.has(oi)) {
            const indexInChat = this.nextChatToolIndex++;
            this.toolsByIndex.set(oi, {
              id: item.call_id || item.id || null,
              name: item.name || null,
              argsBuf: typeof item.arguments === "string" ? item.arguments : "",
              indexInChat,
              outputIndex: oi,
            });
            this._emitRoleIfNeeded(out);
            const tool = this.toolsByIndex.get(oi);
            out.push(this._toolDeltaChunk(tool.indexInChat, {
              id: tool.id ?? undefined,
              name: tool.name ?? undefined,
              argumentsDelta: tool.argsBuf || undefined,
              isFirst: true,
            }));
          }
        } else if (item.type === "message") {
          this._emitRoleIfNeeded(out);
        }
        break;
      }

      case "response.output_text.delta": {
        const delta = data && typeof data.delta === "string" ? data.delta : "";
        if (delta.length === 0) break;
        this._emitRoleIfNeeded(out);
        this.outputTextBuf += delta;
        this._markTextActivity();
        out.push({
          ...this._baseChunk(),
          choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
        });
        break;
      }

      case "response.output_text.done": {
        const text = data && typeof data.text === "string" ? data.text : "";
        if (text.length > this.outputTextBuf.length && text.startsWith(this.outputTextBuf)) {
          const suffix = text.slice(this.outputTextBuf.length);
          this.outputTextBuf = text;
          this._emitRoleIfNeeded(out);
          this._markTextActivity();
          out.push({
            ...this._baseChunk(),
            choices: [{ index: 0, delta: { content: suffix }, finish_reason: null }],
          });
        }
        break;
      }

      case "response.function_call_arguments.delta": {
        const oi = data && data.output_index;
        let tool = this.toolsByIndex.get(oi);
        if (!tool) {
          // Saw delta before output_item.added — create lazily. Do NOT
          // seed tool.id from data.item_id: that's the upstream Responses
          // item id, not the OpenAI-facing call_id. Leave id null so a
          // later output_item.done can backfill it cleanly.
          const indexInChat = this.nextChatToolIndex++;
          tool = {
            id: null,
            name: null,
            argsBuf: "",
            indexInChat,
            outputIndex: oi,
          };
          this.toolsByIndex.set(oi, tool);
          this._emitRoleIfNeeded(out);
          out.push(this._toolDeltaChunk(tool.indexInChat, {
            isFirst: true,
          }));
        }
        const ad = typeof data.delta === "string" ? data.delta : "";
        if (ad.length === 0) break;
        tool.argsBuf += ad;
        this._emitRoleIfNeeded(out);
        out.push(this._toolDeltaChunk(tool.indexInChat, {
          argumentsDelta: ad,
          isFirst: false,
        }));
        break;
      }

      case "response.function_call_arguments.done": {
        const oi = data && data.output_index;
        const tool = this.toolsByIndex.get(oi);
        if (tool) {
          const finalArgs = data && typeof data.arguments === "string" ? data.arguments : null;
          if (finalArgs !== null) {
            if (finalArgs.length > tool.argsBuf.length && finalArgs.startsWith(tool.argsBuf)) {
              const suffix = finalArgs.slice(tool.argsBuf.length);
              tool.argsBuf = finalArgs;
              this._emitRoleIfNeeded(out);
              out.push(this._toolDeltaChunk(tool.indexInChat, {
                argumentsDelta: suffix,
                isFirst: false,
              }));
            } else if (finalArgs !== tool.argsBuf) {
              // Non-prefix mismatch: silently adopt the canonical value.
              tool.argsBuf = finalArgs;
            }
          }
          this.toolFinalized.add(oi);
          this._markToolFinalize();
        }
        break;
      }

      case "response.output_item.done": {
        const item = data && data.item;
        if (!item) break;
        if (item.type !== "function_call") break;
        const oi = data.output_index;
        let tool = this.toolsByIndex.get(oi);
        if (!tool) {
          // Whole tool delivered only at done.
          const indexInChat = this.nextChatToolIndex++;
          tool = {
            id: item.call_id || item.id || null,
            name: item.name || null,
            argsBuf: "",
            indexInChat,
            outputIndex: oi,
          };
          this.toolsByIndex.set(oi, tool);
          this._emitRoleIfNeeded(out);
          out.push(this._toolDeltaChunk(tool.indexInChat, {
            id: tool.id ?? undefined,
            name: tool.name ?? undefined,
            isFirst: true,
          }));
        } else {
          const corrections = {};
          if (!tool.id && item.call_id) {
            tool.id = item.call_id;
            corrections.id = item.call_id;
          }
          if (!tool.name && item.name) {
            tool.name = item.name;
            corrections.name = item.name;
          }
          if (corrections.id !== undefined || corrections.name !== undefined) {
            this._emitRoleIfNeeded(out);
            out.push(this._toolDeltaChunk(tool.indexInChat, {
              id: corrections.id,
              name: corrections.name,
              isFirst: false,
            }));
          }
        }
        const itemArgs = typeof item.arguments === "string" ? item.arguments : null;
        if (itemArgs !== null) {
          if (itemArgs.length > tool.argsBuf.length && itemArgs.startsWith(tool.argsBuf)) {
            const suffix = itemArgs.slice(tool.argsBuf.length);
            tool.argsBuf = itemArgs;
            this._emitRoleIfNeeded(out);
            out.push(this._toolDeltaChunk(tool.indexInChat, {
              argumentsDelta: suffix,
              isFirst: false,
            }));
          } else if (itemArgs !== tool.argsBuf) {
            tool.argsBuf = itemArgs;
          }
        }
        this.toolFinalized.add(oi);
        this._markToolFinalize();
        break;
      }

      case "response.reasoning_text.delta":
      case "response.reasoning_summary_text.delta": {
        const delta = data && typeof data.delta === "string" ? data.delta : "";
        if (delta.length === 0) break;
        this._emitRoleIfNeeded(out);
        out.push({
          ...this._baseChunk(),
          choices: [{
            index: 0,
            delta: { reasoning_content: delta },
            finish_reason: null,
          }],
        });
        break;
      }

      case "response.completed": {
        this.completed = true;
        const r = data && data.response;
        if (r) {
          if (r.usage) this.usage = r.usage;
          if (r.incomplete_details && typeof r.incomplete_details.reason === "string") {
            this.incompleteReason = r.incomplete_details.reason;
          }
          if (typeof r.model === "string" && r.model.length > 0) this.model = r.model;
        }
        break;
      }

      case "response.failed":
      case "response.error": {
        const err = (data && data.response && data.response.error) || (data && data.error) || (data && typeof data.message === "string" ? data : null);
        this.errored = err || { message: "upstream error" };
        break;
      }

      default:
        // Unknown event: ignore.
        break;
    }
    return out;
  }

  computeFinishReason() {
    if (this.toolFinalized.size > 0
        && this.lastToolFinalizeAt >= this.lastTextActivityAt) {
      return "tool_calls";
    }
    if (this.incompleteReason === "max_output_tokens") return "length";
    return "stop";
  }

  _mapUsage(u) {
    if (!u) return null;
    const inp = u.input_tokens ?? 0;
    const outp = u.output_tokens ?? 0;
    return {
      prompt_tokens: inp,
      completion_tokens: outp,
      total_tokens: u.total_tokens ?? (inp + outp),
    };
  }

  _formatErrorEnvelope() {
    const e = this.errored || {};
    return {
      message: e.message || "upstream error",
      type: e.type || "upstream_error",
      code: e.code ?? null,
    };
  }

  // For streaming clients: returns the chunks to emit at end of upstream
  // stream.  Caller handles the [DONE] sentinel and the post-headers error
  // path (per plan §8.5).
  end() {
    if (this.errored) {
      return { errorEvent: this._formatErrorEnvelope(), chunks: [] };
    }
    const chunks = [];
    chunks.push({
      ...this._baseChunk(),
      choices: [{
        index: 0,
        delta: {},
        finish_reason: this.computeFinishReason(),
      }],
    });
    if (this.includeUsage && this.usage) {
      chunks.push({
        ...this._baseChunk(),
        choices: [],
        usage: this._mapUsage(this.usage),
      });
    }
    return { errorEvent: null, chunks };
  }

  // For non-streaming clients: assemble the final chat.completion JSON.
  toFinalCompletion() {
    if (this.errored) return { error: this._formatErrorEnvelope() };
    const message = { role: "assistant", content: this.outputTextBuf || null };
    if (this.toolsByIndex.size > 0) {
      const ordered = [...this.toolsByIndex.values()].sort((a, b) => a.indexInChat - b.indexInChat);
      message.tool_calls = ordered.map((t) => ({
        id: t.id || `call_${t.outputIndex}`,
        type: "function",
        function: {
          name: t.name || "",
          arguments: t.argsBuf || "",
        },
      }));
      if (!this.outputTextBuf) message.content = null;
    }
    const choice = {
      index: 0,
      message,
      finish_reason: this.computeFinishReason(),
    };
    const result = {
      id: this.id,
      object: "chat.completion",
      created: this.created,
      model: this.model,
      choices: [choice],
      system_fingerprint: "fp_passthrough",
    };
    const u = this._mapUsage(this.usage);
    if (u) result.usage = u;
    return result;
  }
}
