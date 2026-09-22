import { createBridgeServer } from "../../src/server.mjs";
import { GLM_DEFAULT_MODEL, createGLMToolPassthrough, prepareGLMRequest } from "./index.mjs";
import { createGLMTransport } from "./http.mjs";

export function createGLMCodexRelay({ upstream, model = GLM_DEFAULT_MODEL, reasoningEffort = "high", nativeTools = [], validateCustomInput, onResponse, server = {} } = {}) {
  const bridge = createGLMToolPassthrough({ transport: createGLMTransport(upstream), model, reasoningEffort, nativeTools, validateCustomInput, onResponse });
  const relay = createBridgeServer({ ...server, model, bridge, bridgeForRequest(_protocol, body) {
    prepareGLMRequest(body, { model, reasoningEffort });
    return bridge;
  } });
  return { bridge, server: relay, model, protocol: "responses", listen: () => relay.listen(), close: () => relay.close() };
}
