export type JsonSchema = { type?: string; required?: string[]; properties?: Record<string, JsonSchema>; items?: JsonSchema; [key: string]: unknown };
export type ToolDefinition = { stableId?: string; name: string; namespace?: string; wireName?: string; description?: string; inputSchema: JsonSchema; [key: string]: unknown };
export class BridgeError extends Error { code: string; details: Record<string, unknown>; }
export type GeminiTransport = { complete(input: { request: unknown; model?: string; signal?: AbortSignal }): Promise<any> };
export type GeminiExecutor = { execute(tool: ToolDefinition, args: unknown, context?: Record<string, unknown>): Promise<unknown> };
export function createGeminiCodexBridge(options: { transport: GeminiTransport; executor: GeminiExecutor; tools?: ToolDefinition[]; policy?: { allowTool?(tool: ToolDefinition, args: unknown, context: unknown): boolean | Promise<boolean> }; maxTurns?: number; maxToolCalls?: number; maxToolOutputBytes?: number; onStateChange?(event: Record<string, unknown>): void }): GeminiCodexBridge;
export class GeminiCodexBridge { getToolDefinitions(): ToolDefinition[]; getGeminiTools(): unknown[]; prepareRequest(request: unknown): any; setTools(tools: ToolDefinition[]): this; runTurn(options: { request: unknown; context?: unknown; signal?: AbortSignal }): Promise<any>; }
export function extractGeminiFunctionCalls(response: unknown): Array<{ vendorCallId: string; name: string; argumentsValue: unknown }>;
export function createGeminiFunctionResultContent(results: unknown[]): unknown;
export function createGeminiTransport(options?: { baseUrl?: string; apiKey?: string; headers?: Record<string, string>; fetchImpl?: typeof fetch; timeoutMs?: number }): GeminiTransport;
export function createCodexExecutor(options: { invoke(input: unknown): unknown | Promise<unknown>; onResult?(input: unknown): unknown | Promise<unknown> }): GeminiExecutor;
export function createCodexRpcExecutor(options: { rpc: { request(method: string, params?: unknown): Promise<unknown> }; method?: string }): GeminiExecutor;
export function createGeminiCodexServer(options: { bridge: GeminiCodexBridge; host?: string; port?: number; model?: string; maxBodyBytes?: number; authorize?(request: unknown): boolean | Promise<boolean> }): { listen(): Promise<{ host: string; port: number }>; close(): Promise<void> };
export function createGeminiCodexRelay(options: { upstream?: { baseUrl?: string; apiKey?: string }; gemini?: { baseUrl?: string; apiKey?: string }; tools?: ToolDefinition[]; invoke(input: unknown): unknown | Promise<unknown>; server?: Record<string, unknown> }): { bridge: GeminiCodexBridge; listen(): Promise<{ host: string; port: number }>; close(): Promise<void> };
