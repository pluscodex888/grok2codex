import type { IncomingMessage, Server } from "node:http";
import type { GeminiExecutionContext, GeminiTurnBridge } from "./index.d.ts";

export interface GeminiServerOptions {
  bridge: GeminiTurnBridge;
  host?: string;
  port?: number;
  model?: string;
  maxBodyBytes?: number;
  context?: GeminiExecutionContext | ((request: IncomingMessage, body: unknown) => GeminiExecutionContext | Promise<GeminiExecutionContext>);
  authorize?(request: IncomingMessage): boolean | Promise<boolean>;
}
export interface GeminiServer {
  server: Server;
  listen(): Promise<{ host: string; port: number }>;
  close(): Promise<void>;
}
export function createGeminiCodexServer(options: GeminiServerOptions): GeminiServer;
