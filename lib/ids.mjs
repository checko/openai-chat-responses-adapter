import { randomBytes } from "node:crypto";

export function newChatCompletionId() {
  return "chatcmpl-" + randomBytes(12).toString("hex");
}

export function newRequestId() {
  return randomBytes(8).toString("hex");
}
