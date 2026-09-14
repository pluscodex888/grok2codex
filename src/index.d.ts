export type Protocol = "responses" | "chat";
export type ToolSource = "codex" | "mcp" | "bridge";
export type BridgeErrorCode = "configuration" | "protocol" | "tool_collision" | "unknown_tool" | "invalid_arguments" | "permission_denied" | "internal_error";

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
export function createBridge(options: BridgeOptions): { getToolDefinitions(): ToolDefinition[]; executeCalls(calls: ToolCall[], context?: unknown): Promise<ToolResult[]>; runTurn(options: RunTurnOptions): Promise<any>; };
export function encodeWireName(namespace: string | undefined, name: string): string;
