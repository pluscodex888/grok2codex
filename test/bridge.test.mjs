import test from "node:test";
import assert from "node:assert/strict";
import { createBridge, encodeWireName } from "../src/index.mjs";

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
