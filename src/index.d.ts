export type Protocol = "responses" | "chat";
export type ToolSource = "codex" | "mcp" | "bridge";
export type BridgeErrorCode = "configuration" | "protocol" | "tool_collision" | "unknown_tool" | "invalid_arguments" | "permission_denied" | "internal_error" | "upstream" | "timeout" | "invalid_request" | "request_too_large";

export interface JsonSchema { type?: string; required?: string[]; properties?: Record<string, JsonSchema>; items?: JsonSchema; [key: string]: unknown; }
export interface ToolDefinition {
  stableId: string;
  name: string;
  wireName?: string;
  namespace?: string;
  description?: string;
  inputSchema: JsonSchema;
  source?: ToolSource;
  [key: string]: unknown;
}
export interface ToolCall { vendorCallId: string; wireName: string; argumentsJson: string; }
export interface ToolResult { vendorCallId: string; ok: boolean; outputJson: string; errorCode?: string; }
export interface BridgeTransport { complete(input: { protocol: Protocol; request: unknown; tools: ToolDefinition[] }, signal?: AbortSignal): Promise<any>; }
export interface BridgeExecutor { execute(tool: ToolDefinition, argumentsValue: unknown, context?: unknown): Promise<unknown>; }
export interface BridgePolicy { allowTool?(tool: ToolDefinition, argumentsValue: unknown, context?: unknown): boolean | Promise<boolean>; }
export interface BridgeOptions { transport: BridgeTransport; executor: BridgeExecutor; tools?: ToolDefinition[]; policy?: BridgePolicy; maxAdvertisedTools?: number; }
export interface RunTurnOptions { protocol?: Protocol; request: unknown; context?: unknown; signal?: AbortSignal; }
export class BridgeError extends Error { code: BridgeErrorCode; details: Record<string, unknown>; }
export function createBridge(options: BridgeOptions): { getToolDefinitions(): ToolDefinition[]; getProviderTools(protocol?: Protocol): unknown[]; prepareRequest(protocol: Protocol, request: unknown): any; executeCalls(calls: ToolCall[], context?: unknown): Promise<ToolResult[]>; setTools(definitions: ToolDefinition[]): unknown; runTurn(options: RunTurnOptions): Promise<any>; };
export function encodeWireName(namespace: string | undefined, name: string): string;
export function providerToolsToDefinitions(protocol: Protocol, tools: unknown[], options?: { source?: ToolSource; namespace?: string }): ToolDefinition[];
export interface OpenAITransportOptions { baseUrl: string; apiKey?: string; headers?: Record<string, string>; fetchImpl?: typeof fetch; timeoutMs?: number; responsesPath?: string; chatPath?: string; }
export function createOpenAITransport(options: OpenAITransportOptions): BridgeTransport;
export interface BridgeServerOptions { bridge: ReturnType<typeof createBridge>; host?: string; port?: number; model?: string; maxBodyBytes?: number; context?: unknown | ((request: unknown, body: unknown) => unknown | Promise<unknown>); bridgeForRequest?: (protocol: Protocol, body: unknown) => ReturnType<typeof createBridge> | Promise<ReturnType<typeof createBridge>>; }
export function createBridgeServer(options: BridgeServerOptions): { server: import("node:http").Server; listen(): Promise<{ host: string; port: number }>; close(): Promise<void>; };
export interface CodexExecutorOptions { invoke(input: { tool: ToolDefinition; arguments: unknown; context: unknown; correlation: { callId: string | null; threadId: string | null; turnId: string | null } }): unknown | Promise<unknown>; onResult?(input: { tool: ToolDefinition; arguments: unknown; output: unknown; context: unknown; correlation: { callId: string | null; threadId: string | null; turnId: string | null } }): unknown | Promise<unknown>; }
export function createCodexExecutor(options: CodexExecutorOptions): BridgeExecutor;