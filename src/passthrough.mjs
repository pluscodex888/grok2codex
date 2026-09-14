import { BridgeError, encodeWireName } from "./index.mjs";

/** A request-scoped codec. Tool execution and continuation stay with the client. */
export function createResponsesToolCodec(request) {
  const byWire = new Map();
  const byOriginal = new Map();
  const originalKey = (name, namespace) => JSON.stringify([namespace ?? null, name]);
  const register = (tool, namespace) => {
    const key = originalKey(tool.name, namespace);
    if (byOriginal.has(key)) return byOriginal.get(key);
    const wireName = encodeWireName(namespace ?? "client", tool.name);
    if (byWire.has(wireName)) throw new BridgeError("invalid_request", "tool wire name collision");
    const record = { name: tool.name, namespace, kind: tool.type, wireName };
    byWire.set(wireName, record);
    byOriginal.set(key, record);
    return record;
  };
  const tools = [];
  const visit = (tool, namespace) => {
    if (tool.type === "namespace") {
      for (const child of tool.tools ?? []) visit(child, tool.name);
    } else if (tool.type === "function" || tool.type === "custom") {
      const record = register(tool, namespace);
      if (tool.type === "function") {
        const { defer_loading, ...rest } = tool;
        tools.push({ ...rest, name: record.wireName });
      } else {
        tools.push({
          type: "function", name: record.wireName,
          description: [tool.description ?? tool.name,
            "Pass the complete raw tool input in the input string. The client executes it using its original tool runtime.",
            tool.format?.definition ? `Input grammar (${tool.format.syntax}):\n${tool.format.definition}` : "",
          ].filter(Boolean).join("\n\n"),
          parameters: { type: "object", properties: { input: { type: "string" } }, required: ["input"], additionalProperties: false },
        });
      }
    } else {
      // Built-in provider tools retain their own protocol; never pretend they are shell functions.
      tools.push(structuredClone(tool));
    }
  };
  for (const tool of request.tools ?? []) visit(tool);
  const mapHistory = item => {
    if (item.type === "custom_tool_call" || item.type === "function_call") {
      const record = byOriginal.get(originalKey(item.name, item.namespace));
      if (!record) return structuredClone(item);
      const { namespace, input, ...rest } = item;
      return { ...rest, type: "function_call", name: record.wireName,
        arguments: item.type === "custom_tool_call" ? JSON.stringify({ input }) : item.arguments };
    }
    if (item.type === "custom_tool_call_output") return { ...item, type: "function_call_output" };
    return structuredClone(item);
  };
  const outgoing = { ...request, tools,
    input: Array.isArray(request.input) ? request.input.map(mapHistory) : request.input };
  if (request.tool_choice?.name) {
    const record = byOriginal.get(originalKey(request.tool_choice.name, request.tool_choice.namespace));
    if (record) outgoing.tool_choice = { type: "function", name: record.wireName };
  }
  return {
    request: outgoing,
    restore(response) {
      return { ...response, output: (response.output ?? []).map(item => {
        if (item.type !== "function_call") return item;
        const record = byWire.get(item.name);
        if (!record) throw new BridgeError("invalid_tool_call", `unadvertised tool: ${item.name}`);
        const { arguments: raw, ...rest } = item;
        const restored = { ...rest, name: record.name };
        if (record.namespace !== undefined) restored.namespace = record.namespace;
        if (record.kind === "custom") {
          let args;
          try { args = JSON.parse(raw); } catch { throw new BridgeError("invalid_tool_call", "custom input is not valid JSON"); }
          if (typeof args?.input !== "string") throw new BridgeError("invalid_tool_call", "custom tool requires a string input");
          return { ...restored, type: "custom_tool_call", input: args.input };
        }
        return { ...restored, arguments: raw };
      }) };
    },
  };
}

/** Exactly one upstream round trip. No executor, private credentials, or session cache. */
export function createClientToolPassthrough({ transport, onResponse } = {}) {
  if (typeof transport?.complete !== "function") throw new BridgeError("configuration", "transport.complete is required");
  return {
    async runTurn({ protocol = "responses", request, signal }) {
      if (protocol !== "responses") throw new BridgeError("protocol", "client tool passthrough requires Responses");
      const codec = createResponsesToolCodec(request);
      const upstream = await transport.complete({ protocol, request: codec.request }, signal);
      const result = codec.restore(upstream);
      onResponse?.({ calls: (result.output ?? []).filter(item => /^(custom_tool_call|function_call)$/.test(item.type))
        .map(item => ({ type: item.type, name: item.name, namespace: item.namespace, callId: item.call_id })) });
      return result;
    },
  };
}
