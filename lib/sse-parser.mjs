// Robust SSE parser that handles LF, CRLF, and lone-CR line terminators,
// multiple `data:` lines per event, comment lines (starting with `:`), and
// chunk boundaries falling mid-line or mid-multibyte-character.

export function createSseParser() {
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let currentEvent = "message";
  let currentData = [];
  let sawAnyField = false;

  function flushBlock(blocks) {
    const block = sawAnyField
      ? { event: currentEvent, data: currentData.join("\n") }
      : null;
    currentEvent = "message";
    currentData = [];
    sawAnyField = false;
    if (block) blocks.push(block);
  }

  function processLine(line, blocks) {
    if (line === "") {
      flushBlock(blocks);
      return;
    }
    if (line.startsWith(":")) return; // comment
    const colon = line.indexOf(":");
    let field, value;
    if (colon === -1) { field = line; value = ""; }
    else { field = line.slice(0, colon); value = line.slice(colon + 1); }
    if (value.startsWith(" ")) value = value.slice(1);
    sawAnyField = true;
    if (field === "event") currentEvent = value;
    else if (field === "data") currentData.push(value);
    // id, retry: ignored
  }

  // Pull complete lines from `buffer`, leaving any incomplete trailer.
  // Handles \n, \r\n, and bare \r terminators.
  function extractLines(blocks) {
    while (true) {
      const nNL = buffer.indexOf("\n");
      const nCR = buffer.indexOf("\r");
      let cut, after;
      if (nNL === -1 && nCR === -1) return;
      if (nCR !== -1 && (nNL === -1 || nCR < nNL)) {
        if (nCR + 1 >= buffer.length) {
          // bare \r at end; can't tell if next byte is \n yet
          return;
        }
        if (buffer[nCR + 1] === "\n") { cut = nCR; after = nCR + 2; }
        else { cut = nCR; after = nCR + 1; }
      } else {
        cut = nNL;
        after = nNL + 1;
      }
      const line = buffer.slice(0, cut);
      buffer = buffer.slice(after);
      processLine(line, blocks);
    }
  }

  return {
    push(chunk) {
      const blocks = [];
      if (chunk == null) return blocks;
      const text = typeof chunk === "string"
        ? chunk
        : decoder.decode(chunk, { stream: true });
      buffer += text;
      extractLines(blocks);
      return blocks;
    },
    flush() {
      const blocks = [];
      const tail = decoder.decode();
      if (tail) buffer += tail;
      extractLines(blocks);
      // Final partial line without terminator
      if (buffer.length > 0) {
        processLine(buffer, blocks);
        buffer = "";
      }
      // And any block that was being assembled but never got its blank-line terminator
      flushBlock(blocks);
      return blocks;
    },
  };
}
