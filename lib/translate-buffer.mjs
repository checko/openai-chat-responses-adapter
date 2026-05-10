// Helper for non-streaming clients: drive a StreamTranslator with an
// in-memory event sequence and return the assembled chat.completion JSON.
// Mostly used by tests; the live server uses StreamTranslator directly.

import { StreamTranslator } from "./translate-stream.mjs";

export function runBuffered(events, translatorOpts = {}) {
  const t = new StreamTranslator(translatorOpts);
  for (const e of events) {
    t.onEvent(e.event, e.data);
  }
  return t.toFinalCompletion();
}
