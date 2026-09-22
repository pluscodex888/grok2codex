import type { BridgeTransport, OpenAITransportOptions } from "../../src/index.js";
export interface GLMTransportOptions extends Omit<OpenAITransportOptions, "baseUrl"> {
  region?: "domestic" | "overseas" | "gateway";
  baseUrl?: string;
  /** auto: native Responses first, one Chat retry only for an unsupported endpoint. */
  upstreamProtocol?: "auto" | "responses" | "chat";
  allowImages?: boolean;
  supportsToolChoice?: boolean;
  onProtocol?(event: { protocol: "responses" | "chat"; reason: "preferred" | "responses_unsupported" | "explicit" }): void;
}
export const GLM_ENDPOINTS: Readonly<{ domestic: string; overseas: string }>;
export function resolveGLMEndpoint(options?: Pick<GLMTransportOptions, "region" | "baseUrl" | "responsesPath" | "chatPath">): { baseUrl: string; responsesPath: string; chatPath: string; url: string };
export function isGLMResponsesUnsupported(error: unknown): boolean;
export function createGLMTransport(options?: GLMTransportOptions): BridgeTransport;
