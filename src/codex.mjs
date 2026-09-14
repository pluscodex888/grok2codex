import { BridgeError } from "./index.mjs";

/**
 * Adapt a host's existing Codex/app-server output boundary to the bridge's
 * executor contract. `invoke` is intentionally the only required operation:
 * the host decides how it reaches MCP, approvals, cancellation, and the
 * renderer. The adapter adds stable correlation metadata and never launches
 * a process or interprets tool arguments as commands.
 */
export function createCodexExecutor({ invoke, onResult } = {}) {
  if (typeof invoke !== "function") throw new BridgeError("configuration", "invoke is required");
  if (onResult !== undefined && typeof onResult !== "function") {
    throw new BridgeError("configuration", "onResult must be a function");
  }
  return {
    async execute(tool, argumentsValue, context = {}) {
      const correlation = {
        callId: context?.callId ?? null,
        threadId: context?.threadId ?? null,
        turnId: context?.turnId ?? null,
      };
      const output = await invoke({ tool, arguments: argumentsValue, context, correlation });
      await onResult?.({ tool, arguments: argumentsValue, output, context, correlation });
      return output;
    },
  };
}

