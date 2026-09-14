const SAFE_NAME = /^[A-Za-z0-9_-]+$/;
let bridgeCallSequence = 0;

export class BridgeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
    this.details = details;
  }
}

export function createBridge(options) {
  return new ToolBridge(options);
}

/**
 * Convert an OpenAI-compatible provider tool declaration into the bridge's
 * stable catalog shape. This is useful when a desktop client sends its
 * approved Codex catalog with each request. The caller still owns the
 * executor and may reject the catalog through its policy.
 */
export function providerToolsToDefinitions(protocol, providerTools, { source = "codex", namespace = "provider" } = {}) {
  if (protocol !== "responses" && protocol !== "chat") {
    throw new BridgeError("protocol", `unsupported protocol: ${protocol}`);
  }
  const definitions = [];
  const visit = (item, currentNamespace) => {
    if (!item || typeof item !== "object") return;
    if (item.type === "namespace") {
      const nextNamespace = String(item.name || currentNamespace);
      for (const child of item.tools || item.children || []) visit(child, nextNamespace);
      return;
    }
    if (item.type === "custom" && item.name) {
      const name = String(item.name);
      definitions.push({
        stableId: `${currentNamespace}.${name}`,
        namespace: currentNamespace,
        name,
        wireName: encodeWireName(currentNamespace, name),
        description: String(item.description || `Custom tool ${name}`),
        inputSchema: { type: "object", required: ["input"], properties: { input: { type: "string" } } },
        source,
        kind: "custom",
      });
      return;
    }
    if (item.type === "tool_search") {
      definitions.push({
        stableId: `${currentNamespace}.tool_search`,
        namespace: currentNamespace,
        name: "tool_search",
        wireName: encodeWireName(currentNamespace, "tool_search"),
        description: "Search approved tools for the current task.",
        inputSchema: { type: "object", required: ["query"], properties: { query: { type: "string" }, limit: { type: "integer" } } },
        source,
        kind: "tool_search",
      });
      return;
    }
    const raw = item.type === "function" && item.function ? item.function : item;
    if (!raw || !raw.name) return;
    const name = String(raw.name);
    const stableId = `${currentNamespace}.${name}`;
    definitions.push({
      stableId,
      namespace: currentNamespace,
      name,
      wireName: encodeWireName(currentNamespace, name),
      description: raw.description || name,
      inputSchema: clone(raw.parameters || raw.input_schema || { type: "object", properties: {} }),
      source,
    });
  };
  const list = Array.isArray(providerTools)
    ? providerTools
    : [
        ...(Array.isArray(providerTools?.tools) ? providerTools.tools : []),
        ...(Array.isArray(providerTools?.additional_tools) ? providerTools.additional_tools : []),
      ];
  for (const item of list) visit(item, namespace);
  return definitions;
}

export function encodeWireName(namespace, name) {
  const encode = value => String(value).replace(/[^A-Za-z0-9_-]/g, char => `_x${char.codePointAt(0).toString(16)}_`);
  const left = encode(namespace || "default");
  const right = encode(name);
  return `${left}__${right}`;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function json(value, label) {
  try {
    return JSON.stringify(value);
  } catch (error) {
    throw new BridgeError("invalid_arguments", `${label} is not JSON serializable`, { cause: String(error) });
  }
}

function validateSchema(value, schema, path = "$", errors = []) {
  if (!schema || !isObject(schema)) return errors;
  if (schema.type === "object") {
    if (!isObject(value)) errors.push(`${path} must be an object`);
    else {
      for (const key of schema.required || []) if (!(key in value)) errors.push(`${path}.${key} is required`);
      for (const [key, child] of Object.entries(schema.properties || {})) {
        if (key in value) validateSchema(value[key], child, `${path}.${key}`, errors);
      }
    }
  } else if (schema.type === "array") {
    if (!Array.isArray(value)) errors.push(`${path} must be an array`);
    else if (schema.items) value.forEach((item, index) => validateSchema(item, schema.items, `${path}[${index}]`, errors));
  } else if (schema.type && typeof value !== schema.type) {
    errors.push(`${path} must be ${schema.type}`);
  }
  return errors;
}

function extractCalls(protocol, response) {
  if (protocol === "responses") {
    return (response?.output || []).filter(item => item?.type === "function_call").map(item => ({
      vendorCallId: item.call_id,
      wireName: item.name,
      argumentsJson: item.arguments || "{}"
    }));
  }
  const message = response?.choices?.[0]?.message;
  return (message?.tool_calls || []).filter(item => item?.type === "function").map(item => ({
    vendorCallId: item.id,
    wireName: item.function?.name,
    argumentsJson: item.function?.arguments || "{}"
  }));
}

function hasCalls(protocol, response) {
  return extractCalls(protocol, response).length > 0;
}

function continuation(protocol, response, results) {
  if (protocol === "responses") {
    return {
      previous_response_id: response.id,
      input: results.map(result => ({
        type: "function_call_output",
        call_id: result.vendorCallId,
        output: result.outputJson
      }))
    };
  }
  return {
    messages: [
      ...(response.choices?.[0]?.message ? [response.choices[0].message] : []),
      ...results.map(result => ({ role: "tool", tool_call_id: result.vendorCallId, content: result.outputJson }))
    ]
  };
}

class ToolBridge {
  constructor(options = {}) {
    if (!options.transport || typeof options.transport.complete !== "function") {
      throw new BridgeError("configuration", "transport.complete is required");
    }
    if (!options.executor || typeof options.executor.execute !== "function") {
      throw new BridgeError("configuration", "executor.execute is required");
    }
    this.transport = options.transport;
    this.executor = options.executor;
    this.policy = options.policy || {};
    this.maxAdvertisedTools = options.maxAdvertisedTools ?? 180;
    this.maxToolCalls = options.maxToolCalls ?? 32;
    this.maxToolOutputBytes = options.maxToolOutputBytes ?? 2 * 1024 * 1024;
    this.maxTurns = options.maxTurns ?? 8;
    this.onStateChange = typeof options.onStateChange === "function" ? options.onStateChange : null;
    this.capabilities = options.capabilities || { enabled: true };
    this.tools = new Map();
    this._setTools(options.tools || []);
  }

  _setTools(definitions) {
    this.tools.clear();
    const seen = new Set();
    for (const definition of definitions) {
      if (!definition?.stableId || !definition?.name || !definition?.inputSchema) continue;
      const wireName = definition.wireName || encodeWireName(definition.namespace, definition.name);
      if (!SAFE_NAME.test(wireName) || seen.has(wireName)) {
        throw new BridgeError("tool_collision", `tool wire name is invalid or duplicated: ${wireName}`);
      }
      seen.add(wireName);
      this.tools.set(wireName, { ...clone(definition), wireName });
    }
  }

  setTools(definitions) {
    this._setTools(definitions || []);
    return this;
  }

  getToolDefinitions() {
    if (this.capabilities.enabled === false) return [];
    const definitions = [...this.tools.values()];
    if (definitions.length <= this.maxAdvertisedTools) return clone(definitions);
    return [{
      stableId: "bridge.dispatch",
      wireName: "bridge__dispatch",
      name: "dispatch",
      namespace: "bridge",
      description: "Select and invoke an approved tool from a namespace.",
      inputSchema: {
        type: "object",
        required: ["tool", "arguments"],
        properties: {
          tool: { type: "string" },
          arguments: { type: "object" }
        }
      },
      source: "bridge"
    }];
  }

  getProviderTools(protocol = "responses") {
    const definitions = this.getToolDefinitions();
    if (protocol === "responses") {
      return definitions.map(tool => ({
        type: "function",
        name: tool.wireName,
        description: tool.description || tool.name,
        parameters: clone(tool.inputSchema)
      }));
    }
    if (protocol === "chat") {
      return definitions.map(tool => ({
        type: "function",
        function: {
          name: tool.wireName,
          description: tool.description || tool.name,
          parameters: clone(tool.inputSchema)
        }
      }));
    }
    throw new BridgeError("protocol", `unsupported protocol: ${protocol}`);
  }

  prepareRequest(protocol, request) {
    const prepared = clone(request) || {};
    prepared.tools = this.getProviderTools(protocol);
    if (protocol === "responses") prepared.parallel_tool_calls = true;
    return prepared;
  }

  _resolve(call) {
    if (call.wireName === "bridge__dispatch") {
      let payload;
      try { payload = JSON.parse(call.argumentsJson); } catch { throw new BridgeError("invalid_arguments", "dispatcher arguments are not JSON"); }
      const target = [...this.tools.values()].find(tool => tool.stableId === payload.tool || tool.wireName === payload.tool);
      if (!target) throw new BridgeError("unknown_tool", `unknown dispatched tool: ${payload.tool}`);
      return { definition: target, argumentsValue: payload.arguments ?? {} };
    }
    const definition = this.tools.get(call.wireName);
    if (!definition) throw new BridgeError("unknown_tool", `unknown tool: ${call.wireName}`);
    let argumentsValue;
    try { argumentsValue = JSON.parse(call.argumentsJson || "{}"); } catch { throw new BridgeError("invalid_arguments", `arguments for ${call.wireName} are not JSON`); }
    return { definition, argumentsValue };
  }

  async executeCalls(calls, context = {}) {
    if (calls.length > this.maxToolCalls) {
      throw new BridgeError("tool_limit", `tool call count exceeds ${this.maxToolCalls}`);
    }
    const executeOne = async (call, index) => {
      const bridgeCallId = `bridge_${Date.now().toString(36)}_${(++bridgeCallSequence).toString(36)}_${index.toString(36)}`;
      const state = (name, details = {}) => {
        try { this.onStateChange?.({ bridgeCallId, vendorCallId: call.vendorCallId, state: name, ...details }); } catch { /* diagnostics cannot break a turn */ }
      };
      state("DISCOVERED", { wireName: call.wireName });
      try {
        const executionContext = { ...(context || {}), callId: call.vendorCallId, bridgeCallId };
        const { definition, argumentsValue } = this._resolve(call);
        const errors = validateSchema(argumentsValue, definition.inputSchema);
        if (errors.length) throw new BridgeError("invalid_arguments", errors.join("; "));
        state("VALIDATED", { stableId: definition.stableId });
        if (this.policy.allowTool) {
          state("APPROVAL_PENDING", { stableId: definition.stableId });
          if (!await this.policy.allowTool(definition, argumentsValue, executionContext)) {
            throw new BridgeError("permission_denied", `tool denied: ${definition.stableId}`);
          }
        }
        state("EXECUTING", { stableId: definition.stableId });
        const output = await this.executor.execute(definition, argumentsValue, executionContext);
        const outputJson = typeof output === "string" ? output : json(output, "tool output");
        if (Buffer.byteLength(outputJson, "utf8") > this.maxToolOutputBytes) {
          throw new BridgeError("tool_output_limit", `tool output exceeds ${this.maxToolOutputBytes} bytes`);
        }
        state("RESULT_READY", { stableId: definition.stableId, outputBytes: Buffer.byteLength(outputJson, "utf8") });
        return { vendorCallId: call.vendorCallId, ok: true, outputJson };
      } catch (error) {
        const bridgeError = error instanceof BridgeError ? error : new BridgeError("internal_error", String(error));
        state("REJECTED", { errorCode: bridgeError.code });
        return { vendorCallId: call.vendorCallId, ok: false, outputJson: JSON.stringify({ error: bridgeError.code, message: bridgeError.message }), errorCode: bridgeError.code };
      }
    };
    return Promise.all(calls.map(executeOne));
  }

  async runTurn({ protocol = "responses", request, context, signal }) {
    if (protocol !== "responses" && protocol !== "chat") throw new BridgeError("protocol", `unsupported protocol: ${protocol}`);
    let current = this.prepareRequest(protocol, request);
    let totalToolCalls = 0;
    for (let turn = 0; turn < this.maxTurns; turn += 1) {
      const response = await this.transport.complete({ protocol, request: current, tools: this.getToolDefinitions() }, signal);
      const calls = extractCalls(protocol, response);
      if (!calls.length) return response;
      if (!response?.id && protocol === "responses") throw new BridgeError("continuation", "Responses tool call is missing response id");
      totalToolCalls += calls.length;
      if (totalToolCalls > this.maxToolCalls) throw new BridgeError("tool_limit", `tool call count exceeds ${this.maxToolCalls}`);
      const results = await this.executeCalls(calls, { ...(context || {}), signal });
      current = { ...current, ...continuation(protocol, response, results) };
    }
    throw new BridgeError("turn_limit", `tool continuation exceeds ${this.maxTurns} turns`);
  }
}

export { createOpenAITransport } from "./http.mjs";
export { createBridgeServer } from "./server.mjs";
export { createCodexExecutor } from "./codex.mjs";
export { createHandshake, fingerprint, negotiateCapabilities } from "./capabilities.mjs";
export { createGrokCodexRelay } from "./integration.mjs";
export { createJsonRpcSocketClient, createSocketExecutor } from "./socket.mjs";
