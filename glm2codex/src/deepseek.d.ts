import type { BridgeTransport, BridgeServerOptions, OpenAITransportOptions, ClientToolPassthroughOptions, TurnBridge, createBridgeServer } from "../../src/index.js";
import type { GLMCustomInput } from "./index.js";
export const DEEPSEEK_DEFAULT_MODEL: "deepseek-flash";
export const DEEPSEEK_MODELS: readonly ["deepseek-flash", "deepseek-v4-pro"];
export const DEEPSEEK_API_ORIGIN: "https://api.deepseek.com";
export function isDeepSeekModel(model: unknown): boolean;
export interface DeepSeekRequestOptions {
  model?: "deepseek-flash" | "deepseek-v4-pro";
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
}
export interface DeepSeekTransportOptions extends Omit<OpenAITransportOptions, "baseUrl"> {
  baseUrl?: string;
  /** Native Responses first; one Chat attempt only after an explicit unsupported endpoint. */
  upstreamProtocol?: "auto" | "responses" | "chat";
  allowImages?: boolean;
  onProtocol?(event: { protocol: "responses" | "chat"; reason: "preferred" | "responses_unsupported" | "explicit" }): void;
}
export interface DeepSeekToolPassthroughOptions extends DeepSeekRequestOptions {
  transport: BridgeTransport;
  /** Built-in tools are unsupported; expose them as client-owned function tools. */
  nativeTools?: ReadonlyArray<Record<string, unknown>>;
  validateCustomInput?(input: GLMCustomInput): boolean;
  onResponse?: ClientToolPassthroughOptions["onResponse"];
}
/** Requires full explicit stateless history. Text developer messages become system messages. */
export function prepareDeepSeekRequest(request: Record<string, any>, options?: DeepSeekRequestOptions): Record<string, any>;
export function createDeepSeekTransport(options?: DeepSeekTransportOptions): BridgeTransport;
export function createDeepSeekToolPassthrough(options: DeepSeekToolPassthroughOptions): TurnBridge;
export interface DeepSeekCodexRelayOptions extends Omit<DeepSeekToolPassthroughOptions, "transport"> {
  upstream?: DeepSeekTransportOptions;
  server?: Omit<BridgeServerOptions, "bridge" | "model" | "bridgeForRequest">;
}
export function createDeepSeekCodexRelay(options?: DeepSeekCodexRelayOptions): {
  bridge: TurnBridge; server: ReturnType<typeof createBridgeServer>; model: string; protocol: "responses";
  listen(): Promise<{ host: string; port: number }>; close(): Promise<void>;
};
