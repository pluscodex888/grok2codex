import test from "node:test";
import assert from "node:assert/strict";
import { createClientToolPassthrough, createResponsesToolCodec, createBridgeServer } from "../src/index.mjs";

const tools = [
  { type: "custom", name: "exec", description: "JavaScript orchestration", format: { type: "grammar", syntax: "lark", definition: "start: SOURCE" } },
  { type: "namespace", name: "workspace", tools: [{ type: "function", name: "read", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }] },
];
const call = { id: "item1", type: "function_call", call_id: "call1", name: "client__exec", arguments: JSON.stringify({ input: 'text(await tools.exec_command({cmd:"ipconfig"}));' }) };

test("custom input returns to client unchanged; adapter makes only one model request", async () => {
  let count = 0;
  const bridge = createClientToolPassthrough({ transport: { async complete({ request }) {
    count++;
    assert.match(request.tools[0].description, /start: SOURCE/);
    assert.deepEqual(request.tools[1].parameters.required, ["path"]);
    return { id: "response1", output: [call] };
  } } });
  const result = await bridge.runTurn({ request: { tools, input: "ping gateway" } });
  assert.equal(count, 1);
  assert.deepEqual(result.output[0], { id: "item1", type: "custom_tool_call", call_id: "call1", name: "exec", input: JSON.parse(call.arguments).input });
});

test("client continuation preserves original task, tool IDs, output, and full history", () => {
  const originalCall = { id: "item1", type: "custom_tool_call", call_id: "call1", name: "exec", input: "text(1)" };
  const input = [
    { role: "user", content: [{ type: "input_text", text: "ping gateway" }] },
    originalCall,
    { type: "custom_tool_call_output", call_id: "call1", output: "gateway=192.0.2.1" },
    { role: "user", content: "continue" },
  ];
  const request = { tools, input, instructions: "Keep task", metadata: { thread: "a" } };
  const before = structuredClone(request);
  const codec = createResponsesToolCodec(request);
  assert.deepEqual(request, before);
  assert.equal(codec.request.input.length, 4);
  assert.deepEqual(codec.request.input[0], input[0]);
  assert.equal(codec.request.input[1].name, "client__exec");
  assert.equal(codec.request.input[2].type, "function_call_output");
  assert.equal(codec.request.input[2].call_id, "call1");
  assert.equal(codec.request.input[2].output, "gateway=192.0.2.1");
  assert.equal(codec.request.instructions, "Keep task");
});

test("namespace restored and unknown calls rejected without guessing a shell command", () => {
  const codec = createResponsesToolCodec({ tools });
  const result = codec.restore({ output: [{ ...call, name: "workspace__read", arguments: '{"path":"a"}' }] });
  assert.equal(result.output[0].namespace, "workspace");
  assert.equal(result.output[0].name, "read");
  assert.equal(result.output[0].arguments, '{"path":"a"}');
  assert.throws(() => codec.restore({ output: [{ ...call, name: "invented" }] }), /unadvertised/);
  assert.throws(() => codec.restore({ output: [{ ...call, arguments: '{"cmd":"whoami"}' }] }), /string input/);
});

test("parallel requests keep tool identities isolated", async () => {
  const bridge = createClientToolPassthrough({ transport: { async complete({ request }) {
    return { output: [{ ...call, name: request.tools[0].name, arguments: "{}" }] };
  } } });
  const results = await Promise.all(["one", "two"].map(name => bridge.runTurn({ request: { tools: [{ type: "function", name }], input: name } })));
  assert.deepEqual(results.map(r => r.output[0].name), ["one", "two"]);
});

test("HTTP SSE returns custom tool call to the client instead of executing it", async () => {
  const bridge = createClientToolPassthrough({ transport: { async complete() { return { id: "r1", output: [call] }; } } });
  const server = createBridgeServer({ bridge });
  const address = await server.listen();
  try {
    const response = await fetch(`http://${address.host}:${address.port}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tools, input: "ping", stream: true }) });
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.match(body, /custom_tool_call/);
    assert.match(body, /response.output_item.done/);
    assert.match(body, /response.completed/);
  } finally { await server.close(); }
});
