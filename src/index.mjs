const SAFE_NAME = /^[A-Za-z0-9_-]+$/;

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
    this.tools = new Map();
    this._setTools(options.tools || []);
  }

  _setTools(definitions) {
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

  getToolDefinitions() {
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
    const results = [];
    for (const call of calls) {
      try {
        const { definition, argumentsValue } = this._resolve(call);
        const errors = validateSchema(argumentsValue, definition.inputSchema);
        if (errors.length) throw new BridgeError("invalid_arguments", errors.join("; "));
        if (this.policy.allowTool && !await this.policy.allowTool(definition, argumentsValue, context)) {
          throw new BridgeError("permission_denied", `tool denied: ${definition.stableId}`);
        }
        const output = await this.executor.execute(definition, argumentsValue, context);
        results.push({ vendorCallId: call.vendorCallId, ok: true, outputJson: typeof output === "string" ? output : json(output, "tool output") });
      } catch (error) {
        const bridgeError = error instanceof BridgeError ? error : new BridgeError("internal_error", String(error));
        results.push({ vendorCallId: call.vendorCallId, ok: false, outputJson: JSON.stringify({ error: bridgeError.code, message: bridgeError.message }), errorCode: bridgeError.code });
      }
    }
    return results;
  }

  async runTurn({ protocol = "responses", request, context, signal }) {
    if (protocol !== "responses" && protocol !== "chat") throw new BridgeError("protocol", `unsupported protocol: ${protocol}`);
    let current = clone(request);
    for (;;) {
      const response = await this.transport.complete({ protocol, request: current, tools: this.getToolDefinitions() }, signal);
      const calls = extractCalls(protocol, response);
      if (!calls.length) return response;
      const results = await this.executeCalls(calls, context);
      current = { ...current, ...continuation(protocol, response, results) };
    }
  }
}
