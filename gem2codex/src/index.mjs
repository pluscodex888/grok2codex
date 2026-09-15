const SAFE_NAME = /^[A-Za-z0-9_-]+$/;
let sequence = 0;

export class BridgeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
    this.details = details;
  }
}

const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const clone = value => value === undefined ? undefined : structuredClone(value);

function validate(value, schema, path = "$", errors = []) {
  if (!schema || !isObject(schema)) return errors;
  if (schema.type === "object") {
    if (!isObject(value)) errors.push(`${path} must be an object`);
    else {
      for (const key of schema.required || []) if (!(key in value)) errors.push(`${path}.${key} is required`);
      for (const [key, child] of Object.entries(schema.properties || {})) {
        if (key in value) validate(value[key], child, `${path}.${key}`, errors);
      }
    }
  } else if (schema.type === "array") {
    if (!Array.isArray(value)) errors.push(`${path} must be an array`);
    else if (schema.items) value.forEach((item, i) => validate(item, schema.items, `${path}[${i}]`, errors));
  } else if (schema.type && typeof value !== schema.type) errors.push(`${path} must be ${schema.type}`);
  return errors;
}

function encode(namespace, name) {
  const part = value => String(value || "default").replace(/[^A-Za-z0-9_-]/g, c => `_x${c.codePointAt(0).toString(16)}_`);
  return `${part(namespace)}__${part(name)}`;
}

function declarations(tools) {
  return tools.map(tool => ({
    name: tool.wireName || tool.name,
    description: tool.description || tool.name,
    parameters: clone(tool.inputSchema),
  }));
}

function extractCalls(response) {
  const calls = [];
  for (const candidate of response?.candidates || []) {
    for (const part of candidate?.content?.parts || []) {
      const call = part?.functionCall;
      if (call?.name) calls.push({
        vendorCallId: call.id || `${call.name}-${++sequence}`,
        name: call.name,
        argumentsValue: isObject(call.args) ? call.args : {},
        candidateContent: candidate.content,
      });
    }
  }
  return calls;
}

function responseContents(response) {
  return (response?.candidates || [])
    .map(candidate => candidate?.content)
    .filter(content => isObject(content) && Array.isArray(content.parts));
}

function functionResultContent(results) {
  return {
    role: "user",
    parts: results.map(result => ({
      functionResponse: {
        name: result.name,
        response: result.ok ? { output: result.output } : { error: result.output },
        ...(result.vendorCallId ? { id: result.vendorCallId } : {}),
      },
    })),
  };
}

export class GeminiCodexBridge {
  constructor(options = {}) {
    if (!options.transport || typeof options.transport.complete !== "function") throw new BridgeError("configuration", "transport.complete is required");
    if (!options.executor || typeof options.executor.execute !== "function") throw new BridgeError("configuration", "executor.execute is required");
    this.transport = options.transport;
    this.executor = options.executor;
    this.policy = options.policy || {};
    this.maxTurns = options.maxTurns ?? 8;
    this.maxToolCalls = options.maxToolCalls ?? 32;
    this.maxToolOutputBytes = options.maxToolOutputBytes ?? 2 * 1024 * 1024;
    this.onStateChange = typeof options.onStateChange === "function" ? options.onStateChange : null;
    this.tools = new Map();
    this.setTools(options.tools || []);
  }

  setTools(definitions) {
    this.tools.clear();
    const seen = new Set();
    for (const definition of definitions || []) {
      if (!definition?.name || !definition?.inputSchema) continue;
      const wireName = definition.wireName || encode(definition.namespace, definition.name);
      if (!SAFE_NAME.test(wireName) || seen.has(wireName)) throw new BridgeError("tool_collision", `invalid or duplicate tool name: ${wireName}`);
      seen.add(wireName);
      this.tools.set(wireName, { ...clone(definition), wireName });
    }
    return this;
  }

  getToolDefinitions() { return clone([...this.tools.values()]); }

  getGeminiTools() {
    return this.tools.size ? [{ functionDeclarations: declarations([...this.tools.values()]) }] : [];
  }

  prepareRequest(request) {
    const prepared = clone(request) || {};
    const existing = Array.isArray(prepared.tools) ? prepared.tools : [];
    prepared.tools = [...existing, ...this.getGeminiTools()];
    return prepared;
  }

  async executeCalls(calls, context = {}, signal) {
    if (calls.length > this.maxToolCalls) throw new BridgeError("tool_limit", "too many tool calls in one response");
    return Promise.all(calls.map(async call => {
      const definition = this.tools.get(call.name) || [...this.tools.values()].find(tool => tool.name === call.name);
      if (!definition) throw new BridgeError("unknown_tool", `unknown tool: ${call.name}`);
      const errors = validate(call.argumentsValue, definition.inputSchema);
      if (errors.length) throw new BridgeError("invalid_arguments", errors.join("; "));
      if (this.policy.allowTool && !(await this.policy.allowTool(definition, call.argumentsValue, context))) throw new BridgeError("permission_denied", `tool denied: ${call.name}`);
      const bridgeCallId = `gemini-${++sequence}`;
      this.onStateChange?.({ bridgeCallId, vendorCallId: call.vendorCallId, state: "EXECUTING", tool: definition.stableId || definition.name });
      try {
        const output = await this.executor.execute(definition, call.argumentsValue, { ...context, callId: bridgeCallId, signal });
        const outputJson = typeof output === "string" ? output : JSON.stringify(output ?? null);
        if (Buffer.byteLength(outputJson, "utf8") > this.maxToolOutputBytes) throw new BridgeError("tool_output_limit", `tool output exceeds ${this.maxToolOutputBytes} bytes`);
        this.onStateChange?.({ bridgeCallId, vendorCallId: call.vendorCallId, state: "RESULT_READY" });
        return { vendorCallId: call.vendorCallId, name: call.name, ok: true, output: output ?? null };
      } catch (error) {
        if (error instanceof BridgeError) throw error;
        return { vendorCallId: call.vendorCallId, name: call.name, ok: false, output: String(error) };
      }
    }));
  }

  async runTurn({ request, context = {}, signal } = {}) {
    let nextRequest = this.prepareRequest(request);
    for (let turn = 0; turn < this.maxTurns; turn++) {
      const response = await this.transport.complete({ request: nextRequest, signal });
      const calls = extractCalls(response);
      if (!calls.length) return response;
      const results = await this.executeCalls(calls, context, signal);
      const modelContents = responseContents(response);
      const contents = Array.isArray(nextRequest.contents) ? [...nextRequest.contents, ...modelContents] : [...modelContents];
      contents.push(functionResultContent(results));
      // Preserve caller-provided built-in tools alongside the bridge catalog
      // for every continuation turn.
      nextRequest = { ...nextRequest, contents, tools: nextRequest.tools };
    }
    throw new BridgeError("turn_limit", `Gemini tool loop exceeded ${this.maxTurns} turns`);
  }
}

export function createGeminiCodexBridge(options) { return new GeminiCodexBridge(options); }
export { extractCalls as extractGeminiFunctionCalls, functionResultContent as createGeminiFunctionResultContent };
