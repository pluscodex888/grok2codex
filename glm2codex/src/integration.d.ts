import type { BridgeServerOptions, TurnBridge, createBridgeServer } from "../../src/index.js";
import type { GLMToolPassthroughOptions } from "./index.js";
import type { GLMTransportOptions } from "./http.js";
export interface GLMCodexRelayOptions extends Omit<GLMToolPassthroughOptions, "transport"> {
  upstream?: GLMTransportOptions;
  server?: Omit<BridgeServerOptions, "bridge" | "model" | "bridgeForRequest">;
}
export function createGLMCodexRelay(options?: GLMCodexRelayOptions): {
  bridge: TurnBridge; server: ReturnType<typeof createBridgeServer>; model: string; protocol: "responses";
  listen(): Promise<{ host: string; port: number }>; close(): Promise<void>;
};
