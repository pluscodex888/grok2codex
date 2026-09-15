import { createGeminiCodexBridge } from "./index.mjs";
import { createGeminiTransport } from "./gemini-http.mjs";
import { createCodexExecutor } from "./codex.mjs";
import { createGeminiCodexServer } from "./server.mjs";

export function createGeminiCodexRelay({ upstream, gemini = {}, tools = [], invoke, onResult, policy, server = {}, maxTurns, onStateChange } = {}) {
  const bridge = createGeminiCodexBridge({
    tools,
    transport: createGeminiTransport({ ...upstream, ...gemini }),
    executor: createCodexExecutor({ invoke, onResult }),
    policy,
    maxTurns,
    onStateChange,
  });
  const relay = createGeminiCodexServer({ ...server, bridge });
  return { bridge, server: relay, listen: () => relay.listen(), close: () => relay.close() };
}
