import type { GeminiTransport } from "./index.d.ts";

export interface GeminiTransportOptions {
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}
export function createGeminiTransport(options?: GeminiTransportOptions): GeminiTransport;
