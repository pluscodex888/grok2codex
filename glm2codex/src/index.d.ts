import type { BridgeTransport, ClientToolPassthroughOptions, TurnBridge } from "../../src/index.js";
export const GLM_DEFAULT_MODEL: "glm-5.3";
export const GLM_MODELS: readonly ["glm-5.3", "glm-5.3-flash"];
export function isGLMModel(model: unknown): boolean;
export interface GLMRequestOptions { model?: string; reasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max"; }
export interface GLMCustomInput { name: string; namespace?: string; input: string; format?: Record<string, unknown>; }
export interface GLMCodecOptions {
  nativeTools?: ClientToolPassthroughOptions["nativeTools"];
  /** Synchronous original-runtime grammar validation; must return true to accept. */
  validateCustomInput?(input: GLMCustomInput): boolean;
}
export interface GLMToolPassthroughOptions extends GLMRequestOptions, GLMCodecOptions {
  transport: BridgeTransport;
  onResponse?: ClientToolPassthroughOptions["onResponse"];
}
export function prepareGLMRequest(request: Record<string, any>, options?: GLMRequestOptions): Record<string, any>;
export function createGLMToolCodec(request: Record<string, any>, options?: GLMCodecOptions): {
  request: Record<string, any>; restoreItem(item: Record<string, any>, partial?: boolean): Record<string, any>; restore(response: Record<string, any>): Record<string, any>;
};
export function createGLMToolPassthrough(options: GLMToolPassthroughOptions): TurnBridge;
export { createGLMTransport, resolveGLMEndpoint, GLM_ENDPOINTS, isGLMResponsesUnsupported } from "./http.js";
export type { GLMTransportOptions } from "./http.js";
