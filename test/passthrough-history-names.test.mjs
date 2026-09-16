import test from "node:test";
import assert from "node:assert/strict";
import { encodeWireName } from "../src/index.mjs";
import { createClientToolPassthrough, createResponsesToolCodec } from "../src/passthrough.mjs";

const functionTool = name => ({
  type: "function", name,
  parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
});

test("retired custom history is translated without advertising or authorizing the retired tool", () => {
  const request = {
    tools: [functionTool("current")],
    input: [
      { role: "user", content: "fixture task" },
      { type: "custom_tool_call", id: "item-old", call_id: "call-old", namespace: "retired", name: "exec", input: "fixture\nraw input" },
      { type: "custom_tool_call_output", call_id: "call-old", output: [{ type: "input_text", text: "fixture result" }] },
      { role: "user", content: "continue fixture" },
    ],
    instructions: "fixture instruction", previous_response_id: "previous-fixture",
  };
  const original = structuredClone(request);
  const codec = createResponsesToolCodec(request);
  assert.deepEqual(request, original);
  assert.deepEqual(codec.request.tools, [{ ...request.tools[0], name: "client__current" }]);
  assert.deepEqual(codec.request.input, [
    request.input[0],
    { type: "function_call", id: "item-old", call_id: "call-old", name: "retired__exec", arguments: JSON.stringify({ input: "fixture\nraw input" }) },
    { ...request.input[2], type: "function_call_output" },
    request.input[3],
  ]);
  assert.equal(codec.request.instructions, request.instructions);
  assert.equal(codec.request.previous_response_id, request.previous_response_id);
  assert.throws(() => codec.restore({ output: [{ type: "function_call", name: "retired__exec", call_id: "new-call", arguments: '{"input":"fixture"}' }] }), /unadvertised tool/);
});

test("same-name history in another namespace keeps its recorded identity", () => {
  const codec = createResponsesToolCodec({
    tools: [{ type: "custom", name: "exec" }],
    input: [
      { type: "custom_tool_call", namespace: "older", name: "exec", call_id: "older-call", input: "old fixture" },
      { type: "custom_tool_call_output", call_id: "older-call", output: "old result" },
    ],
  });
  assert.equal(codec.request.tools[0].name, "client__exec");
  assert.equal(codec.request.input[0].name, "older__exec");
  assert.equal(codec.request.input[0].type, "function_call");
  assert.equal(codec.request.input[1].call_id, "older-call");
  assert.deepEqual(codec.restore({ output: [{ type: "function_call", name: "client__exec", call_id: "current-call", arguments: '{"input":"new fixture"}' }] }).output, [
    { type: "custom_tool_call", name: "exec", call_id: "current-call", input: "new fixture" },
  ]);
});

test("retired function history retains argument bytes and paired call IDs", () => {
  const argumentsText = '{ "value": "fixture", "extra": [1, 2] }';
  const codec = createResponsesToolCodec({ tools: [], input: [
    { type: "function_call", namespace: "previous", name: "read", call_id: "function-old", arguments: argumentsText },
    { type: "function_call_output", call_id: "function-old", output: "fixture" },
  ] });
  assert.deepEqual(codec.request.tools, []);
  assert.deepEqual(codec.request.input, [
    { type: "function_call", name: "previous__read", call_id: "function-old", arguments: argumentsText },
    { type: "function_call_output", call_id: "function-old", output: "fixture" },
  ]);
  assert.throws(() => codec.restore({ output: [{ type: "function_call", name: "previous__read", call_id: "new", arguments: "{}" }] }), /unadvertised tool/);
});

test("long custom and function names survive provider limits and client continuation", async () => {
  const namespace = "catalog_" + "shared_prefix_".repeat(5);
  const names = ["operation_".repeat(8) + "first", "operation_".repeat(8) + "second"];
  const tools = [{ type: "namespace", name: namespace, tools: [
    { type: "custom", name: names[0], format: { type: "grammar", syntax: "lark", definition: "start: SOURCE" } },
    functionTool(names[1]),
  ] }];
  const input = [{ role: "user", content: "fixture task" }];
  const seen = [];
  const bridge = createClientToolPassthrough({ transport: { async complete({ request }) {
    seen.push(request);
    assert.equal(new Set(request.tools.map(tool => tool.name.slice(0, 64))).size, 2);
    for (const tool of request.tools) assert.match(tool.name, /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/);
    if (seen.length === 1) return { output: [
      { type: "function_call", name: request.tools[0].name, call_id: "custom-long", arguments: '{"input":"fixture raw"}' },
      { type: "function_call", name: request.tools[1].name, call_id: "function-long", arguments: '{"value":"fixture"}' },
    ] };
    return { output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "fixture complete" }] }] };
  } } });
  const result = await bridge.runTurn({ request: { tools, input } });
  assert.deepEqual(result.output, [
    { type: "custom_tool_call", name: names[0], namespace, call_id: "custom-long", input: "fixture raw" },
    { type: "function_call", name: names[1], namespace, call_id: "function-long", arguments: '{"value":"fixture"}' },
  ]);
  input.push(...result.output,
    { type: "custom_tool_call_output", call_id: "custom-long", output: "custom fixture result" },
    { type: "function_call_output", call_id: "function-long", output: "function fixture result" });
  const final = await bridge.runTurn({ request: { tools, input } });
  assert.equal(seen.length, 2, "one model request per client turn");
  assert.deepEqual(seen[1].input.slice(1, 3).map(item => item.name), seen[0].tools.map(tool => tool.name));
  assert.deepEqual(seen[1].input.slice(-2).map(item => [item.type, item.call_id, item.output]), [
    ["function_call_output", "custom-long", "custom fixture result"],
    ["function_call_output", "function-long", "function fixture result"],
  ]);
  assert.equal(final.output[0].content[0].text, "fixture complete");
});

test("bounded wire identities are independent of catalog order and include original Unicode names", () => {
  const names = ["name_".repeat(20) + "one", "name_".repeat(20) + "two", "工具".repeat(20)];
  const first = createResponsesToolCodec({ tools: names.map(functionTool) }).request.tools.map(tool => tool.name);
  const reversed = createResponsesToolCodec({ tools: [...names].reverse().map(functionTool) }).request.tools.map(tool => tool.name).reverse();
  assert.deepEqual(first, reversed);
  assert.equal(new Set(first).size, names.length);
  for (const name of first) assert.match(name, /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/);
  assert.notEqual(encodeWireName("long_".repeat(20), "."), encodeWireName("long_".repeat(20), "_x2e_"));
  assert.match(encodeWireName("3rd_party", "operation"), /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/);
});

test("existing short wire names and exact 64-character names remain compatible", () => {
  assert.equal(encodeWireName("client", "exec"), "client__exec");
  assert.equal(encodeWireName("workspace", "read_file"), "workspace__read_file");
  const boundary = "x".repeat(56);
  assert.equal(encodeWireName("client", boundary), "client__" + boundary);
  assert.equal(encodeWireName("client", boundary).length, 64);
});

test("ambiguous short aliases still reject a collision in catalog or history", () => {
  assert.throws(() => createResponsesToolCodec({ tools: [functionTool("a.b"), functionTool("a_x2e_b")] }), /tool wire name collision/);
  assert.throws(() => createResponsesToolCodec({ tools: [functionTool("a.b")], input: [
    { type: "custom_tool_call", name: "a_x2e_b", call_id: "old", input: "fixture" },
  ] }), /tool wire name collision/);
});

test("name mapping preserves complex function schema and native tools exactly", () => {
  const tool = { ...functionTool("long_schema_name_".repeat(5)), strict: true, parameters: {
    type: "object", properties: { value: { anyOf: [{ type: "string" }, { type: "null" }] }, tuple: { type: "array", prefixItems: [{ type: "string" }] } },
    required: ["value"], additionalProperties: false,
  } };
  const native = { type: "web_search", search_context_size: "low" };
  const request = { tools: [tool, native], tool_choice: { type: "function", name: tool.name }, reasoning: { effort: "medium" } };
  const original = structuredClone(request);
  const codec = createResponsesToolCodec(request, { nativeTools: [{ type: "image_generation" }] });
  assert.deepEqual(request, original);
  assert.deepEqual(codec.request.tools[0], { ...tool, name: encodeWireName("client", tool.name) });
  assert.deepEqual(codec.request.tools.slice(1), [native, { type: "image_generation" }]);
  assert.deepEqual(codec.request.tool_choice, { type: "function", name: codec.request.tools[0].name });
  assert.deepEqual(codec.request.reasoning, request.reasoning);
});
