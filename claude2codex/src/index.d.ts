import type { ClientToolPassthroughOptions, TurnBridge } from "../../src/index.js";
export const CLAUDE_DEFAULT_MODEL: "claude-opus-4-6-thinking";
export function isClaudeModel(model: unknown): boolean;
export interface ClaudeToolPassthroughOptions extends ClientToolPassthroughOptions { model?: string; }
export function prepareClaudeRequest(request: Record<string, any>, options?: { model?: string }): Record<string, any>;
export function createClaudeToolPassthrough(options: ClaudeToolPassthroughOptions): TurnBridge;
