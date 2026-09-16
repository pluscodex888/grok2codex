import { BridgeError } from "../../src/index.mjs";
import { createClientToolPassthrough } from "../../src/passthrough.mjs";

/** This is the Antigravity catalog ID, not an Anthropic Messages API alias. */
export const CLAUDE_DEFAULT_MODEL = "claude-opus-4-6-thinking";

export function isClaudeModel(model) {
  return typeof model === "string" && /^claude(?:[-_:./]|$)/i.test(model.trim());
}

/** Keep the model, opaque reasoning history, and caller-owned tool loop intact. */
export function prepareClaudeRequest(request, { model = CLAUDE_DEFAULT_MODEL } = {}) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new BridgeError("invalid_request", "Claude Responses request must be an object");
  }
  const selectedModel = request.model ?? model;
  if (!isClaudeModel(selectedModel)) {
    throw new BridgeError("invalid_request", "Claude tool bridge requires a Claude model from the upstream catalog");
  }
  if (request.include !== undefined && (!Array.isArray(request.include) || request.include.some(value => typeof value !== "string"))) {
    throw new BridgeError("invalid_request", "Responses include must be an array of strings");
  }
  // Thinking signatures belong to the provider/proxy. Request their opaque
  // representation for continuation, but never inspect, invent or rewrite it.
  const include = [...(request.include ?? [])];
  if (!include.includes("reasoning.encrypted_content")) include.push("reasoning.encrypted_content");
  return { ...request, model: selectedModel, include };
}

/** The client executes its own approved Codex tools; this module never executes. */
export function createClaudeToolPassthrough({ transport, model = CLAUDE_DEFAULT_MODEL, nativeTools = [], onResponse } = {}) {
  if (!isClaudeModel(model)) throw new BridgeError("configuration", "Default Claude model must come from the Claude catalog");
  const shared = createClientToolPassthrough({ transport, nativeTools, onResponse });
  const prepare = options => {
    if (options.protocol !== undefined && options.protocol !== "responses") {
      throw new BridgeError("protocol", "Claude client tool bridge requires Responses");
    }
    return { ...options, protocol: "responses", request: prepareClaudeRequest(options.request, { model }) };
  };
  return {
    async runTurn(options) { return shared.runTurn(prepare(options)); },
    ...(shared.streamTurn ? { streamTurn(options) { return shared.streamTurn(prepare(options)); } } : {}),
  };
}
