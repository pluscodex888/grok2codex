import type { OpenAITransportOptions, BridgeServerOptions, ClientToolPassthroughOptions, TurnBridge, createBridgeServer } from "../../src/index.js";
export interface ClaudeCodexRelayOptions {
  upstream: OpenAITransportOptions;
  model?: string;
  nativeTools?: ClientToolPassthroughOptions["nativeTools"];
  onResponse?: ClientToolPassthroughOptions["onResponse"];
  server?: Omit<BridgeServerOptions, "bridge" | "model" | "bridgeForRequest">;
}
export function createClaudeCodexRelay(options: ClaudeCodexRelayOptions): {
  bridge: TurnBridge; server: ReturnType<typeof createBridgeServer>; model: string; protocol: "responses";
  listen(): Promise<{ host: string; port: number }>; close(): Promise<void>;
};
