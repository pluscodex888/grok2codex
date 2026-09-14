import test from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { createBridge, createBridgeServer, createGrokCodexRelay, createHandshake, createOpenAITransport, encodeWireName, fingerprint, negotiateCapabilities, providerToolsToDefinitions } from "../src/index.mjs";

const tools = [{
  stableId: "workspace.read",
  namespace: "workspace",
  name: "read_file",
  description: "Read a file",
  inputSchema: { type: "object", required: ["path"], properties: { path: { type: "string" } } },
  source: "codex"
}];

test("wire names are stable and safe", () => {
  assert.equal(encodeWireName("workspace", "read_file"), "workspace__read_file");
  assert.match(encodeWireName("mcp.fs", "read/file"), /^[A-Za-z0-9_-]+$/);
});

test("responses calls execute and continue with the same call id", async () => {
  const requests = [];
  const bridge = createBridge({
    tools,
    transport: { async complete(input) {
      requests.push(input);
      return requests.length === 1
        ? { id: "resp-1", output: [{ type: "function_call", call_id: "call-1", name: "workspace__read_file", arguments: '{"path":"README.md"}' }] }
        : { id: "resp-2", output: [{ type: "message", content: [{ type: "output_text", text: "done" }] }] };
    } },
    executor: { async execute(tool, args) { assert.equal(tool.stableId, "workspace.read"); return { content: `read:${args.path}` }; } }
  });
  const result = await bridge.runTurn({ request: { model: "grok", input: "read it" } });
  assert.equal(result.id, "resp-2");
  assert.equal(requests[1].request.previous_response_id, "resp-1");
  assert.deepEqual(requests[1].request.input[0], { type: "function_call_output", call_id: "call-1", output: '{"content":"read:README.md"}' });
});

test("provider tool declarations are protocol-specific", () => {
  const bridge = createBridge({ tools, transport: { complete() {} }, executor: { execute() {} } });
  assert.deepEqual(bridge.getProviderTools("responses")[0], {
    type: "function",
    name: "workspace__read_file",
    description: "Read a file",
    parameters: tools[0].inputSchema
  });
  assert.deepEqual(bridge.getProviderTools("chat")[0], {
    type: "function",
    function: { name: "workspace__read_file", description: "Read a file", parameters: tools[0].inputSchema }
  });
});

test("chat calls return tool messages and continue", async () => {
  const requests = [];
  const bridge = createBridge({
    tools,
    transport: { async complete(input) {
      requests.push(input);
      return requests.length === 1
        ? { id: "chat-1", choices: [{ message: { role: "assistant", tool_calls: [{ id: "tool-1", type: "function", function: { name: "workspace__read_file", arguments: '{"path":"a.txt"}' } }] } }] }
        : { id: "chat-2", choices: [{ message: { role: "assistant", content: "done" } }] };
    } },
    executor: { async execute() { return "ok"; } }
  });
  const result = await bridge.runTurn({ protocol: "chat", request: { model: "grok", messages: [{ role: "user", content: "read" }] } });
  assert.equal(result.id, "chat-2");
  assert.deepEqual(requests[0].request.tools, bridge.getProviderTools("chat"));
  assert.deepEqual(requests[1].request.messages.at(-1), { role: "tool", tool_call_id: "tool-1", content: "ok" });
});

test("unknown tools fail closed and do not reach executor", async () => {
  let executed = false;
  const bridge = createBridge({ tools, transport: { async complete() { return { output: [{ type: "function_call", call_id: "x", name: "unknown", arguments: "{}" }] }; } }, executor: { async execute() { executed = true; } } });
  const results = await bridge.executeCalls([{ vendorCallId: "x", wireName: "unknown", argumentsJson: "{}" }]);
  assert.equal(executed, false);
  assert.equal(results[0].errorCode, "unknown_tool");
});

test("large catalogs use the dispatcher", () => {
  const many = Array.from({ length: 181 }, (_, i) => ({ ...tools[0], stableId: `tool.${i}`, name: `read_${i}` }));
  const bridge = createBridge({ tools: many, maxAdvertisedTools: 180, transport: { complete() {} }, executor: { execute() {} } });
  assert.deepEqual(bridge.getToolDefinitions().map(tool => tool.wireName), ["bridge__dispatch"]);
});

test("provider declarations can be adopted as a stable Codex catalog", () => {
  const definitions = providerToolsToDefinitions("chat", [{
    type: "function",
    function: { name: "read_file", description: "Read", parameters: { type: "object" } }
  }]);
  assert.equal(definitions[0].stableId, "provider.read_file");
  assert.equal(definitions[0].wireName, "provider__read_file");
  const namespaced = providerToolsToDefinitions("responses", [{ type: "namespace", name: "workspace", tools: [{ type: "function", name: "write_file", parameters: { type: "object" } }] }]);
  assert.equal(namespaced[0].wireName, "workspace__write_file");
  const additional = providerToolsToDefinitions("responses", { tools: [], additional_tools: [{ type: "function", name: "search", parameters: { type: "object" } }] });
  assert.equal(additional[0].name, "search");
  const custom = providerToolsToDefinitions("responses", [{ type: "custom", name: "apply_patch" }]);
  assert.equal(custom[0].inputSchema.required[0], "input");
});

test("OpenAI transport sends the selected protocol without leaking credentials", async () => {
  const calls = [];
  const transport = createOpenAITransport({
    baseUrl: "https://grok.example/v1",
    apiKey: "secret",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: "upstream-1", output: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });
  const result = await transport.complete({ protocol: "responses", request: { model: "grok", input: "hi" } });
  assert.equal(result.id, "upstream-1");
  assert.equal(calls[0].url, "https://grok.example/v1/responses");
  assert.equal(calls[0].init.headers.authorization, "Bearer secret");
  assert.equal(JSON.parse(calls[0].init.body).stream, false);
});

test("relay server exposes a real Responses endpoint and SSE output", async () => {
  const bridge = createBridge({
    tools,
    transport: { async complete() { return { id: "final", model: "grok", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }] }; } },
    executor: { async execute() { return "unused"; } }
  });
  const relay = createBridgeServer({ bridge, port: 0 });
  const address = await relay.listen();
  try {
    const health = await fetch(`http://${address.host}:${address.port}/healthz`);
    assert.equal(health.status, 200);
    const response = await fetch(`http://${address.host}:${address.port}/v1/responses`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "grok", input: "hello", stream: true })
    });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /response\.completed/);
  } finally {
    await relay.close();
  }
});

test("Codex executor adapter forwards correlation to the host output boundary", async () => {
  const seen = [];
  const executor = (await import("../src/codex.mjs")).createCodexExecutor({
    async invoke(input) { seen.push(input); return { text: "done" }; },
  });
  const output = await executor.execute(tools[0], { path: "a.txt" }, { callId: "c1", threadId: "t1", turnId: "u1" });
  assert.deepEqual(output, { text: "done" });
  assert.deepEqual(seen[0].correlation, { callId: "c1", threadId: "t1", turnId: "u1" });
});

test("end-to-end relay sends Grok tool call to the Codex executor and resumes", async () => {
  const upstreamRequests = [];
  const upstream = createHttpServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text || "{}");
    upstreamRequests.push(body);
    const response = upstreamRequests.length === 1
      ? { id: "grok-call", model: "grok", output: [{ type: "function_call", call_id: "call-1", name: "workspace__read_file", arguments: '{"path":"README.md"}' }] }
      : { id: "grok-final", model: "grok", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Codex result accepted" }] }] };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(response));
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = upstream.address().port;
  let executions = 0;
  let executionCallId = null;
  const bridge = createBridge({
    tools,
    transport: createOpenAITransport({ baseUrl: `http://127.0.0.1:${upstreamPort}` }),
    executor: { async execute(tool, args, context) { executions += 1; executionCallId = context.callId; return { tool: tool.stableId, path: args.path, ok: true }; } },
  });
  const relay = createBridgeServer({ bridge, port: 0 });
  const address = await relay.listen();
  try {
    const response = await fetch(`http://${address.host}:${address.port}/v1/responses`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "grok", input: "read README" })
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).id, "grok-final");
    assert.equal(executions, 1);
    assert.equal(executionCallId, "call-1");
    assert.equal(upstreamRequests.length, 2);
    assert.equal(upstreamRequests[1].previous_response_id, "grok-call");
    assert.equal(upstreamRequests[1].input[0].call_id, "call-1");
  } finally {
    await relay.close();
    await new Promise(resolve => upstream.close(resolve));
  }
});

test("multiple calls run concurrently, preserve response order, and publish state transitions", async () => {
  const states = [];
  let active = 0;
  let peak = 0;
  const bridge = createBridge({
    tools: [tools[0], { ...tools[0], stableId: "workspace.stat", name: "stat_file", wireName: "workspace__stat_file" }],
    onStateChange(event) { states.push(event); },
    transport: { async complete(input) {
      return input.request.previous_response_id
        ? { id: "done", output: [{ type: "message", content: [{ type: "output_text", text: "done" }] }] }
        : { id: "calls", output: [
          { type: "function_call", call_id: "a", name: "workspace__read_file", arguments: '{"path":"a"}' },
          { type: "function_call", call_id: "b", name: "workspace__stat_file", arguments: '{"path":"b"}' },
        ] };
    } },
    executor: { async execute(_tool, args) { active += 1; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 10)); active -= 1; return args.path; } },
  });
  await bridge.runTurn({ request: { model: "grok", input: "two" } });
  assert.equal(peak, 2);
  assert.deepEqual(states.filter(item => item.state === "RESULT_READY").map(item => item.vendorCallId), ["a", "b"]);
  assert.ok(states.some(item => item.state === "DISCOVERED"));
});

test("unknown fingerprint disables tools while known handshake enables them", () => {
  const fp = fingerprint({ appServer: "fixture-v1", tools: ["read_file"] });
  const handshake = createHandshake({ codex: { fingerprint: fp, supportsInputSchema: true }, grok: { supportsClientFunctionCalls: true } });
  assert.equal(negotiateCapabilities(handshake, []).mode, "text-only");
  const accepted = negotiateCapabilities(handshake, [{ fingerprint: fp, adapter: "fixture-v1", requiredCapabilities: { supportsInputSchema: true } }]);
  assert.deepEqual(accepted, { enabled: true, mode: "tools", adapter: "fixture-v1", fingerprint: fp });
});

test("a text-only capability decision never advertises the Codex catalog", () => {
  const bridge = createBridge({ capabilities: { enabled: false, mode: "text-only" }, tools, transport: { complete() {} }, executor: { execute() {} } });
  assert.deepEqual(bridge.getToolDefinitions(), []);
  assert.deepEqual(bridge.getProviderTools("responses"), []);
});

test("integration factory wires handshake, transport, executor, and relay together", () => {
  const fp = fingerprint({ appServer: "fixture", registry: 1 });
  const relay = createGrokCodexRelay({
    upstream: { baseUrl: "http://127.0.0.1:1", fetchImpl: async () => new Response("{}") },
    codex: { fingerprint: fp, supportsInputSchema: true },
    grok: { protocol: "responses", supportsClientFunctionCalls: true },
    registry: [{ fingerprint: fp, adapter: "fixture", requiredCapabilities: { supportsInputSchema: true } }],
    tools,
    invoke: async () => "ok",
  });
  assert.equal(relay.capabilities.enabled, true);
  assert.equal(relay.handshake.codex.fingerprint, fp);
  assert.equal(relay.bridge.getToolDefinitions().length, 1);
});
