export interface JsonSchema {
  type?: string;
  required?: string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  [key: string]: unknown;
}
export interface ToolDefinition {
  stableId?: string;
  name: string;
  namespace?: string;
  wireName?: string;
  description?: string;
  inputSchema: JsonSchema;
  [key: string]: unknown;
}
export class BridgeError extends Error {
  constructor(code: string, message: string, details?: Record<string, unknown>);
  code: string;
  details: Record<string, unknown>;
}
export interface GeminiExecutionContext extends Record<string, unknown> {
  callId?: string;
  threadId?: string;
  turnId?: string;
  signal?: AbortSignal;
}
export interface GeminiTransport {
  complete(input: { request: unknown; model?: string; signal?: AbortSignal }): Promise<any>;
}
export interface GeminiExecutor {
  execute(tool: ToolDefinition, args: unknown, context?: GeminiExecutionContext): Promise<unknown>;
}
export interface GeminiPolicy {
  allowTool?(tool: ToolDefinition, args: unknown, context: GeminiExecutionContext): boolean | Promise<boolean>;
}
export interface GeminiFunctionCall {
  vendorCallId: string;
  name: string;
  argumentsValue: Record<string, unknown>;
  candidateContent: unknown;
}
export interface GeminiFunctionResult {
  vendorCallId: string;
  name: string;
  ok: boolean;
  output: unknown;
}
export interface GeminiBridgeOptions {
  transport: GeminiTransport;
  executor: GeminiExecutor;
  tools?: ToolDefinition[];
  policy?: GeminiPolicy;
  maxTurns?: number;
  maxToolCalls?: number;
  maxToolOutputBytes?: number;
  onStateChange?(event: Record<string, unknown>): void;
}
export interface GeminiRunTurnOptions {
  request: unknown;
  context?: GeminiExecutionContext;
  signal?: AbortSignal;
}
export interface GeminiTurnBridge {
  runTurn(options: GeminiRunTurnOptions): Promise<any>;
}
export class GeminiCodexBridge implements GeminiTurnBridge {
  constructor(options: GeminiBridgeOptions);
  getToolDefinitions(): ToolDefinition[];
  getGeminiTools(): Array<{ functionDeclarations: Array<{ name: string; description: string; parameters: JsonSchema }> }>;
  prepareRequest(request: unknown): any;
  setTools(tools: ToolDefinition[]): this;
  executeCalls(calls: GeminiFunctionCall[], context?: GeminiExecutionContext, signal?: AbortSignal): Promise<GeminiFunctionResult[]>;
  runTurn(options: GeminiRunTurnOptions): Promise<any>;
}
export function createGeminiCodexBridge(options: GeminiBridgeOptions): GeminiCodexBridge;
export function extractGeminiFunctionCalls(response: unknown): GeminiFunctionCall[];
export function createGeminiFunctionResultContent(results: GeminiFunctionResult[]): {
  role: "user";
  parts: Array<{ functionResponse: { name: string; id?: string; response: { output: unknown } | { error: unknown } } }>;
};
