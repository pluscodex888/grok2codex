import { createBridge, createCodexExecutor, createOpenAITransport, createBridgeServer } from "./index.mjs";
import { createHandshake, negotiateCapabilities } from "./capabilities.mjs";

/**
 * Assemble the public adapters used by the enhanced desktop client. The
 * `invoke` callback is the host's existing Codex/app-server output boundary;
 * this factory never starts or discovers a local process.
 */
export function createGrokCodexRelay({
  upstream,
  codex,
  grok = {},
  bridgeVersion = "0.4.0",
  registry = [],
  tools = [],
  invoke,
  onResult,
  policy,
  server = {},
  imageGeneration = true,
} = {}) {
  const handshake = createHandshake({ bridgeVersion, codex, grok });
  const capabilities = negotiateCapabilities(handshake, registry);
  const bridge = createBridge({
    capabilities,
    tools,
    transport: createOpenAITransport(upstream),
    executor: createCodexExecutor({ invoke, onResult }),
    policy,
    nativeTools: imageGeneration && grok.imageGeneration !== false ? [{ type: "image_generation" }] : [],
  });
  const relay = createBridgeServer({ ...server, bridge });
  return {
    handshake,
    capabilities,
    bridge,
    server: relay,
    listen: () => relay.listen(),
    close: () => relay.close(),
  };
}
