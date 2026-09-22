export type Protocol = "responses" | "chat";
export type ToolSource = "codex" | "mcp" | "bridge";
export type BridgeErrorCode = "configuration" | "protocol" | "tool_collision" | "unknown_tool" | "invalid_arguments" | "invalid_tool_call" | "permission_denied" | "internal_error" | "upstream" | "upstream_invalid_response" | "upstream_empty_response" | "upstream_stream_incomplete" | "timeout" | "cancelled" | "invalid_request" | "request_too_large" | "tool_limit" | "tool_output_limit" | "continuation" | "turn_limit" | "handshake";

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
export interface StreamFrame { raw: string; event?: string; data?: string; value?: Record<string, any>; numbers?: Map<string, string>; }
export interface BridgeTransport { complete(input: { protocol: Protocol; request: unknown; sessionId?: string; tools?: ToolDefinition[] }, signal?: AbortSignal): Promise<any>; stream?(input: { protocol: Protocol; request: unknown; sessionId?: string }, signal?: AbortSignal): AsyncIterable<StreamFrame | { buffered: Record<string, any> }>; }
export interface BridgeExecutor { execute(tool: ToolDefinition, argumentsValue: unknown, context?: unknown): Promise<unknown>; }
export interface BridgePolicy { allowTool?(tool: ToolDefinition, argumentsValue: unknown, context?: unknown): boolean | Promise<boolean>; }
export interface BridgeOptions { transport: BridgeTransport; executor: BridgeExecutor; tools?: ToolDefinition[]; nativeTools?: ReadonlyArray<Record<string, unknown>>; policy?: BridgePolicy; capabilities?: { enabled: boolean; [key: string]: unknown }; maxAdvertisedTools?: number; maxToolCalls?: number; maxToolOutputBytes?: number; maxTurns?: number; onStateChange?(event: { bridgeCallId: string; vendorCallId: string; state: string; [key: string]: unknown }): void; }
export interface RunTurnOptions { protocol?: Protocol; request: unknown; sessionId?: string; context?: unknown; signal?: AbortSignal; }
export class BridgeError extends Error { constructor(code: BridgeErrorCode, message: string, details?: Record<string, unknown>); code: BridgeErrorCode; details: Record<string, unknown>; }
export function createBridge(options: BridgeOptions): { getToolDefinitions(): ToolDefinition[]; getProviderTools(protocol?: Protocol): unknown[]; prepareRequest(protocol: Protocol, request: unknown): any; executeCalls(calls: ToolCall[], context?: unknown): Promise<ToolResult[]>; setTools(definitions: ToolDefinition[]): unknown; runTurn(options: RunTurnOptions): Promise<any>; };
export function encodeWireName(namespace: string | undefined, name: string): string;
export function providerToolsToDefinitions(protocol: Protocol, tools: unknown[], options?: { source?: ToolSource; namespace?: string }): ToolDefinition[];
export interface OpenAITransportOptions { baseUrl: string; apiKey?: string; headers?: Record<string, string>; fetchImpl?: typeof fetch; timeoutMs?: number; responsesPath?: string; chatPath?: string; maxSSEFrameBytes?: number; }
export function createOpenAITransport(options: OpenAITransportOptions): BridgeTransport;
export interface TurnBridge { runTurn(options: RunTurnOptions): Promise<any>; streamTurn?(options: RunTurnOptions): AsyncIterable<StreamFrame>; }
export interface BridgeServerOptions { bridge: TurnBridge; host?: string; port?: number; model?: string; maxBodyBytes?: number; context?: unknown | ((request: unknown, body: unknown) => unknown | Promise<unknown>); bridgeForRequest?: (protocol: Protocol, body: unknown) => TurnBridge | Promise<TurnBridge>; }
export function createBridgeServer(options: BridgeServerOptions): { server: import("node:http").Server; listen(): Promise<{ host: string; port: number }>; close(): Promise<void>; };
export interface CodexExecutorOptions { invoke(input: { tool: ToolDefinition; arguments: unknown; context: unknown; correlation: { callId: string | null; threadId: string | null; turnId: string | null } }): unknown | Promise<unknown>; onResult?(input: { tool: ToolDefinition; arguments: unknown; output: unknown; context: unknown; correlation: { callId: string | null; threadId: string | null; turnId: string | null } }): unknown | Promise<unknown>; }
export function createCodexExecutor(options: CodexExecutorOptions): BridgeExecutor;
export interface CodexCapabilities { appServerProtocol?: string; cliVersion?: string; fingerprint: string; supportsDynamicToolNamespaces?: boolean; supportsInputSchema?: boolean; supportsParallelToolCalls?: boolean; [key: string]: unknown; }
export interface GrokCapabilities { protocol?: Protocol; model?: string; supportsClientFunctionCalls?: boolean; supportsParallelToolCalls?: boolean; imageGeneration?: boolean; [key: string]: unknown; }
export interface BridgeHandshake { bridgeVersion: string; codex: CodexCapabilities; grok: GrokCapabilities; }
export function fingerprint(value: unknown): string;
export function createHandshake(options?: { bridgeVersion?: string; codex: CodexCapabilities; grok?: GrokCapabilities }): BridgeHandshake;
export function negotiateCapabilities(handshake: BridgeHandshake, registry?: Array<{ fingerprint: string; adapter?: string; requiredCapabilities?: Record<string, unknown> }>): { enabled: boolean; mode: "tools" | "text-only"; reason?: string; adapter?: string; fingerprint?: string };
export interface GrokCodexRelayOptions { upstream: OpenAITransportOptions; codex: CodexCapabilities; grok?: GrokCapabilities; bridgeVersion?: string; registry?: Array<{ fingerprint: string; adapter?: string; requiredCapabilities?: Record<string, unknown> }>; tools?: ToolDefinition[]; invoke: CodexExecutorOptions["invoke"]; onResult?: CodexExecutorOptions["onResult"]; policy?: BridgePolicy; imageGeneration?: boolean; server?: Omit<BridgeServerOptions, "bridge">; }
export function createGrokCodexRelay(options: GrokCodexRelayOptions): { handshake: BridgeHandshake; capabilities: { enabled: boolean; mode: "tools" | "text-only"; reason?: string; adapter?: string; fingerprint?: string }; bridge: ReturnType<typeof createBridge>; server: ReturnType<typeof createBridgeServer>; listen(): Promise<{ host: string; port: number }>; close(): Promise<void>; };
export interface JsonRpcSocket { on(event: string, listener: (...args: any[]) => void): unknown; write?(value: string): unknown; send?(value: string): unknown; end?(): unknown; close?(): unknown; }
export function createJsonRpcSocketClient(options: { socket?: JsonRpcSocket; connect?: () => JsonRpcSocket | Promise<JsonRpcSocket>; timeoutMs?: number; onNotification?(message: unknown): void }): { request(method: string, params?: unknown, signal?: AbortSignal): Promise<any>; close(): void; };
export function createSocketExecutor(options: { rpc: { request(method: string, params?: unknown, signal?: AbortSignal): Promise<any> }; method?: string }): BridgeExecutor;
export function createEnhancedDesktopRelay(options: GrokCodexRelayOptions & { enabled?: boolean | ((model?: string) => boolean); onStateChange?(event: { bridgeCallId: string; vendorCallId: string; state: string; [key: string]: unknown }): void }): ReturnType<typeof createGrokCodexRelay> & { enabled: boolean; disabledReason?: "non_grok_model" | "disabled_in_settings" };
export function isGrokModel(model: unknown): boolean;
export interface ClientToolPassthroughOptions { transport: Pick<BridgeTransport, "complete" | "stream">; nativeTools?: ReadonlyArray<Record<string, unknown>>; onResponse?(event: { status?: "failed" | "incomplete"; calls: Array<{ type: string; name: string; namespace?: string; callId: string }> }): void; }
export function createResponsesToolCodec(request: Record<string, any>, options?: Pick<ClientToolPassthroughOptions, "nativeTools">): { request: Record<string, any>; restoreItem(item: Record<string, any>, partial?: boolean): Record<string, any>; restore(response: Record<string, any>): Record<string, any> };
export function createClientToolPassthrough(options: ClientToolPassthroughOptions): TurnBridge;
export { CLAUDE_DEFAULT_MODEL, isClaudeModel, prepareClaudeRequest, createClaudeToolPassthrough } from "../claude2codex/src/index.js";
export type { ClaudeToolPassthroughOptions } from "../claude2codex/src/index.js";
export { createClaudeCodexRelay } from "../claude2codex/src/integration.js";
export type { ClaudeCodexRelayOptions } from "../claude2codex/src/integration.js";
export { GLM_DEFAULT_MODEL, GLM_MODELS, isGLMModel, prepareGLMRequest, createGLMToolCodec, createGLMToolPassthrough, createGLMTransport, resolveGLMEndpoint, GLM_ENDPOINTS, isGLMResponsesUnsupported } from "../glm2codex/src/index.js";
export type { GLMRequestOptions, GLMCodecOptions, GLMCustomInput, GLMToolPassthroughOptions, GLMTransportOptions } from "../glm2codex/src/index.js";
export { createGLMCodexRelay } from "../glm2codex/src/integration.js";
export type { GLMCodexRelayOptions } from "../glm2codex/src/integration.js";
export { DEEPSEEK_DEFAULT_MODEL, DEEPSEEK_MODELS, isDeepSeekModel, prepareDeepSeekRequest, createDeepSeekTransport, createDeepSeekToolPassthrough, createDeepSeekCodexRelay } from "../glm2codex/src/deepseek.js";
export type { DeepSeekRequestOptions, DeepSeekTransportOptions, DeepSeekToolPassthroughOptions, DeepSeekCodexRelayOptions } from "../glm2codex/src/deepseek.js";
