import { BridgeError } from "./index.mjs";

/** Adapt the host's approved Codex tool gateway to the bridge executor. */
export function createCodexExecutor({ invoke, onResult } = {}) {
  if (typeof invoke !== "function") throw new BridgeError("configuration", "invoke is required");
  if (onResult !== undefined && typeof onResult !== "function") throw new BridgeError("configuration", "onResult must be a function");
  return {
    async execute(tool, argumentsValue, context = {}) {
      const correlation = { callId: context.callId ?? null, threadId: context.threadId ?? null, turnId: context.turnId ?? null };
      const output = await invoke({ tool, arguments: argumentsValue, context, correlation });
      await onResult?.({ tool, arguments: argumentsValue, output, context, correlation });
      return output;
    },
  };
}

/**
 * Wrap an already-connected Codex app-server JSON-RPC client. The method is
 * configurable because hosts may expose their approved tool gateway under a
 * product-specific RPC name; this layer never executes shell commands.
 */
export function createCodexRpcExecutor({ rpc, method = "codex/tool/execute" } = {}) {
  if (!rpc || typeof rpc.request !== "function") throw new BridgeError("configuration", "rpc.request is required");
  return createCodexExecutor({
    invoke: ({ tool, arguments: args, context, correlation }) => rpc.request(method, {
      tool: { stableId: tool.stableId || null, name: tool.name, namespace: tool.namespace || null, inputSchema: tool.inputSchema },
      arguments: args,
      context,
      correlation,
    }),
  });
}
