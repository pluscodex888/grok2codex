import { BridgeError } from "../../src/index.mjs";
import { createResponsesToolCodec } from "../../src/passthrough.mjs";
import { streamClientResponses } from "../../src/responses-stream.mjs";
import { prepareGLMRequest, GLM_DEFAULT_MODEL, isGLMModel } from "./request.mjs";
export { prepareGLMRequest, GLM_DEFAULT_MODEL, GLM_MODELS, isGLMModel } from "./request.mjs";
export { createGLMTransport, resolveGLMEndpoint, GLM_ENDPOINTS, isGLMResponsesUnsupported } from "./http.mjs";

/** Codec for a prepared Responses request (any model); no executor or history cache. */
export function createGLMToolCodec(request, { nativeTools = [], validateCustomInput } = {}) {
  const shared = createResponsesToolCodec(request, { nativeTools });
  const custom = new Map();
  const key = (name, namespace) => JSON.stringify([namespace ?? null, name]);
  const visit = (tool, namespace) => {
    if (tool.type === "namespace") for (const child of tool.tools ?? []) visit(child, tool.name);
    else if (tool.type === "custom") custom.set(key(tool.name, namespace), tool);
  };
  for (const tool of request.tools ?? []) visit(tool);
  const restoreItem = (item, partial = false) => {
    // Every advertised custom tool was encoded as a function. A native custom
    // result would bypass the wrapper, identity and original grammar checks.
    if (item.type === "custom_tool_call") throw new BridgeError("invalid_tool_call", "Unexpected native custom call; the advertised tool uses a function envelope");
    const { namespace: _upstreamNamespace, ...wireItem } = item;
    const result = shared.restoreItem(item.type === "function_call" ? wireItem : item, partial);
    if (partial || item.type !== "function_call") return result;
    if (typeof item.call_id !== "string" || !item.call_id) throw new BridgeError("invalid_tool_call", "GLM tool call requires a nonempty string call ID");
    let args;
    try { args = JSON.parse(item.arguments); } catch { throw new BridgeError("invalid_tool_call", "GLM function arguments are not complete JSON"); }
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new BridgeError("invalid_tool_call", "GLM tool arguments must be an object");
    if (result.type === "custom_tool_call") {
      if (Object.keys(args).length !== 1 || typeof args.input !== "string") throw new BridgeError("invalid_tool_call", "Custom wrapper must contain exactly one input string");
      if (validateCustomInput) {
        const valid = validateCustomInput({ name: result.name, namespace: result.namespace, input: result.input,
          format: structuredClone(custom.get(key(result.name, result.namespace))?.format) });
        if (valid !== true) throw new BridgeError("invalid_tool_call", "Custom input failed the host's original grammar validator");
      }
    }
    return result;
  };
  return { request: shared.request, restoreItem,
    restore(response) {
      if (response.error || ["failed", "incomplete"].includes(response.status) || response.incomplete_details) return structuredClone(response);
      const result = { ...response, output: (response.output ?? []).map(item => restoreItem(item)) };
      const calls = result.output.filter(item => ["function_call", "custom_tool_call"].includes(item.type));
      if (request.tool_choice === "none" && calls.length) throw new BridgeError("invalid_tool_call", "Tool calls were disabled by the client");
      if (request.tool_choice === "required" && !calls.length) throw new BridgeError("invalid_tool_call", "A required tool call is missing");
      if (["function", "custom"].includes(request.tool_choice?.type)) {
        const choice = request.tool_choice;
        if (!calls.length || calls.some(call => call.name !== choice.name || (call.namespace ?? null) !== (choice.namespace ?? null))) {
          throw new BridgeError("invalid_tool_call", "Upstream did not honor the selected tool identity");
        }
      }
      if (request.parallel_tool_calls === false && calls.length > 1) throw new BridgeError("invalid_tool_call", "GLM returned parallel calls when disabled");
      if (new Set(calls.map(item => item.call_id)).size !== calls.length) throw new BridgeError("invalid_tool_call", "GLM returned duplicate call IDs");
      return result;
    },
  };
}

export function createGLMToolPassthrough({ transport, model = GLM_DEFAULT_MODEL, reasoningEffort = "high", nativeTools = [], validateCustomInput, onResponse } = {}) {
  if (typeof transport?.complete !== "function" || !isGLMModel(model)) throw new BridgeError("configuration", "GLM transport.complete and a GLM default model are required");
  const prepare = options => {
    if (options.protocol !== undefined && options.protocol !== "responses") throw new BridgeError("protocol", "GLM client tool bridge only supports Responses", { status: 400 });
    return createGLMToolCodec(prepareGLMRequest(options.request, { model, reasoningEffort }), { nativeTools, validateCustomInput });
  };
  const notify = response => {
    try { onResponse?.({ ...(["failed", "incomplete"].includes(response.status) ? { status: response.status } : {}), calls: response.error || response.incomplete_details || response.status === "failed" || response.status === "incomplete" ? []
      : (response.output ?? []).filter(item => ["function_call", "custom_tool_call"].includes(item.type))
        .map(item => ({ type: item.type, name: item.name, namespace: item.namespace, callId: item.call_id })) }); } catch { /* observer only */ }
  };
  return {
    async runTurn(options) {
      const codec = prepare(options);
      const result = codec.restore(await transport.complete({ protocol: "responses", request: codec.request, sessionId: options.sessionId }, options.signal));
      notify(result);
      return result;
    },
    ...(typeof transport.stream === "function" ? { streamTurn(options) {
      const codec = prepare(options);
      return streamClientResponses(transport.stream({ protocol: "responses", request: codec.request, sessionId: options.sessionId }, options.signal), codec, onResponse);
    } } : {}),
  };
}
