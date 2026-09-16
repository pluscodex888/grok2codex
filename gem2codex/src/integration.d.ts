import type { GeminiBridgeOptions, GeminiCodexBridge, GeminiExecutionContext, ToolDefinition } from "./index.d.ts";
import type { GeminiTransportOptions } from "./gemini-http.d.ts";
import type { GeminiServer, GeminiServerOptions } from "./server.d.ts";

export interface GeminiInvokeInput {
  tool: ToolDefinition;
  arguments: unknown;
  context: GeminiExecutionContext;
  correlation: { callId: string | null; threadId: string | null; turnId: string | null };
}
export interface GeminiRelayOptions {
  upstream?: GeminiTransportOptions;
  gemini?: GeminiTransportOptions;
  tools?: ToolDefinition[];
  invoke(input: GeminiInvokeInput): unknown | Promise<unknown>;
  onResult?(input: GeminiInvokeInput & { output: unknown }): unknown | Promise<unknown>;
  policy?: GeminiBridgeOptions["policy"];
  server?: Omit<GeminiServerOptions, "bridge">;
  maxTurns?: number;
  onStateChange?: GeminiBridgeOptions["onStateChange"];
}
export interface GeminiRelay {
  bridge: GeminiCodexBridge;
  server: GeminiServer;
  listen(): Promise<{ host: string; port: number }>;
  close(): Promise<void>;
}
export function createGeminiCodexRelay(options: GeminiRelayOptions): GeminiRelay;
