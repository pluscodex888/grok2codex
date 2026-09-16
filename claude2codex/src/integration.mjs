import { createOpenAITransport } from "../../src/http.mjs";
import { createBridgeServer } from "../../src/server.mjs";
import { CLAUDE_DEFAULT_MODEL, createClaudeToolPassthrough, prepareClaudeRequest } from "./index.mjs";

/** Antigravity/other Responses-compatible Claude endpoint supplied by the host. */
export function createClaudeCodexRelay({ upstream, model = CLAUDE_DEFAULT_MODEL, nativeTools = [], onResponse, server = {} } = {}) {
  const bridge = createClaudeToolPassthrough({ transport: createOpenAITransport(upstream), model, nativeTools, onResponse });
  const relay = createBridgeServer({ ...server, model, bridge, bridgeForRequest(_protocol, body) {
    // Validate explicit model values before the generic server's defaulting.
    prepareClaudeRequest(body, { model });
    return bridge;
  } });
  return { bridge, server: relay, model, protocol: "responses", listen: () => relay.listen(), close: () => relay.close() };
}
