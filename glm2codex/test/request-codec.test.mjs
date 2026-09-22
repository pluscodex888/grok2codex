import test from "node:test";
import assert from "node:assert/strict";
import { prepareGLMRequest } from "../src/request.mjs";
import { createGLMToolCodec, createGLMToolPassthrough } from "../src/index.mjs";
import { responsesToGLMChat } from "../src/chat-request.mjs";

const functionTool = (name, extra = {}) => ({
  type: "function", name,
  parameters: { type: "object", properties: { value: {} }, additionalProperties: true },
  ...extra,
});
const customTool = (name = "exec") => ({
  type: "custom", name, description: "Execute the client's original tool input",
  format: { type: "grammar", syntax: "lark", definition: "start: SOURCE\nSOURCE: /[\\s\\S]+/" },
});
const makeCodec = (request = {}, options) => createGLMToolCodec(prepareGLMRequest({ input: "fixture task", ...request }), options);
const call = (name, callId, argumentsText = "{}") => ({ type: "function_call", name, call_id: callId, arguments: argumentsText });
const expectInvalidCall = fn => assert.throws(fn, error => error?.code === "invalid_tool_call");
const expectUnsupported = fn => assert.throws(fn, error => error?.code === "protocol");

test("native custom calls cannot bypass the encoded tool catalog or grammar checks", () => {
  const codec = makeCodec({ tools: [customTool()] }, { validateCustomInput: () => false });
  for (const name of ["exec", "unadvertised"]) {
    const item = { type: "custom_tool_call", name, namespace: "untrusted", call_id: "bypass", input: "unvalidated" };
    expectInvalidCall(() => codec.restoreItem(item, true));
    expectInvalidCall(() => codec.restore({ status: "completed", output: [item] }));
  }
});

test("upstream namespace cannot override the original function identity", () => {
  for (const namespace of [undefined, "trusted"]) {
    const tool = functionTool("inspect");
    const codec = makeCodec({ tools: namespace ? [{ type: "namespace", name: namespace, tools: [tool] }] : [tool] });
    const restored = codec.restoreItem({ ...call(codec.request.tools[0].name, "fixture"), namespace: "untrusted" });
    assert.equal(restored.namespace, namespace);
    assert.equal(restored.name, "inspect");
  }
});

test("selected tool type must match its catalog entry", () => {
  assert.throws(() => makeCodec({ tools: [customTool()], tool_choice: { type: "function", name: "exec" } }), error => error.code === "invalid_request");
  assert.throws(() => makeCodec({ tools: [functionTool("inspect")], tool_choice: { type: "custom", name: "inspect" } }), error => error.code === "invalid_request");
});

test("native Responses preparation preserves the entire task and provider state without mutation", () => {
  const request = {
    instructions: "Preserve the main user's task and the delegated subagent task.",
    model: "glm-5.3-flash", reasoning: { effort: "xhigh", summary: "auto" },
    previous_response_id: "resp_fixture_opaque", conversation: { id: "conv_fixture" },
    metadata: { task: "subagent-analysis", parent: "root-fixture" },
    input: [
      { role: "user", content: [{ type: "input_text", text: "Original task: investigate 中文 paths." }] },
      { role: "developer", content: "Only inspect files; maintain every earlier constraint." },
      { type: "reasoning", id: "reason_fixture", encrypted_content: "opaque-fixture", summary: [] },
      { role: "assistant", content: [{ type: "output_text", text: "Parent delegated the bounded task." }] },
      { role: "user", content: "Subagent task: inspect request encoding and report findings." },
      { role: "developer", content: "Newest constraint: do not change production files." },
      { role: "user", content: "Latest user update: include false, 0, null and emoji 🧪." },
    ],
    tools: [functionTool("inspect")],
  };
  const original = structuredClone(request);
  const prepared = prepareGLMRequest(request);
  assert.deepEqual(request, original);
  assert.deepEqual(prepared, { ...original, reasoning: { effort: "max", summary: "auto" } });
  const codec = createGLMToolCodec(prepared);
  assert.deepEqual(codec.request.input, original.input);
  assert.equal(codec.request.instructions, original.instructions);
  assert.deepEqual(codec.request.metadata, original.metadata);
  assert.equal(codec.request.previous_response_id, original.previous_response_id);
  assert.deepEqual(codec.request.conversation, original.conversation);
  assert.deepEqual(request, original);
});

test("both GLM models default to high and respect explicit reasoning levels", () => {
  for (const model of ["glm-5.3", "glm-5.3-flash"]) {
    assert.equal(prepareGLMRequest({ model, input: "task" }).reasoning.effort, "high");
    for (const [requested, expected] of [["low", "low"], ["high", "high"], ["max", "max"], ["xhigh", "max"]]) {
      const request = { model, input: "task", reasoning: { effort: requested } };
      const original = structuredClone(request);
      assert.equal(prepareGLMRequest(request).reasoning.effort, expected);
      assert.deepEqual(request, original);
      const legacy = prepareGLMRequest({ model, input: "task", reasoning_effort: requested });
      assert.equal(legacy.reasoning.effort, expected);
      assert.equal(Object.hasOwn(legacy, "reasoning_effort"), false);
    }
  }
  assert.equal(prepareGLMRequest({ input: "task" }).model, "glm-5.3");
  assert.equal(prepareGLMRequest({ input: "task" }, { model: "glm-5.3-flash", reasoningEffort: "low" }).reasoning.effort, "low");
  assert.equal(prepareGLMRequest({ input: "task", reasoning: { effort: "low" }, reasoning_effort: "high" }).reasoning.effort, "low");
});

test("same-leaf namespace tools remain distinct, bounded and restore the original identities", () => {
  const leaf = "inspect_".repeat(14) + "中文";
  const namespaces = ["workspace_".repeat(12) + "one", "workspace_".repeat(12) + "two"];
  const tools = namespaces.map((name, i) => ({ type: "namespace", name, description: `Namespace ${i} authority`,
    tools: [functionTool(leaf, { description: `Inspect domain ${i}`, strict: true })] }));
  const codec = makeCodec({ tools });
  const wireNames = codec.request.tools.map(tool => tool.name);
  assert.equal(new Set(wireNames).size, 2);
  for (const [i, tool] of codec.request.tools.entries()) {
    assert.match(tool.name, /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/);
    assert.match(tool.description, new RegExp(`Namespace ${i} authority`));
    assert.match(tool.description, new RegExp(`Inspect domain ${i}`));
    assert.deepEqual(tool.parameters, tools[i].tools[0].parameters);
    assert.equal(tool.strict, true);
  }
  const restored = codec.restore({ output: wireNames.map((name, i) => call(name, `call_${i}`)) });
  assert.deepEqual(restored.output.map(item => [item.namespace, item.name, item.call_id]), namespaces.map((namespace, i) => [namespace, leaf, `call_${i}`]));
  const reversed = makeCodec({ tools: [...tools].reverse() });
  assert.deepEqual(reversed.request.tools.map(tool => tool.name).reverse(), wireNames);
});

test("custom raw Unicode, emoji, quotes, newlines and backslashes round-trip byte for byte", () => {
  const raw = 'text("中文 🧪 \\\\server\\path");\nconst values = [false, 0, null, "quoted \\\"value\\\""];\r\n';
  const codec = makeCodec({ tools: [{ type: "namespace", name: "runtime", description: "Client execution authority", tools: [customTool()] }] });
  assert.match(codec.request.tools[0].description, /Client execution authority/);
  assert.match(codec.request.tools[0].description, /start: SOURCE/);
  assert.deepEqual(codec.request.tools[0].parameters, {
    type: "object", properties: { input: { type: "string" } }, required: ["input"], additionalProperties: false,
  });
  const restored = codec.restore({ id: "resp_raw", output: [{ id: "item_raw", ...call(codec.request.tools[0].name, "call_raw", JSON.stringify({ input: raw })) }] });
  assert.deepEqual(restored.output, [{ id: "item_raw", type: "custom_tool_call", name: "exec", namespace: "runtime", call_id: "call_raw", input: raw }]);
  assert.equal(Buffer.compare(Buffer.from(restored.output[0].input), Buffer.from(raw)), 0);
});

test("function argument bytes preserve false, zero, null and formatting exactly", () => {
  const argumentsText = '{ "flag": false, "count": 0, "missing": null, "value": "中文 🧪", "path": "C:\\\\fixture", "line": "a\\nb" }';
  const codec = makeCodec({ tools: [functionTool("inspect")] });
  const restored = codec.restore({ output: [call(codec.request.tools[0].name, "call_values", argumentsText)] });
  assert.equal(restored.output[0].arguments, argumentsText);
  assert.deepEqual(JSON.parse(restored.output[0].arguments), { flag: false, count: 0, missing: null, value: "中文 🧪", path: "C:\\fixture", line: "a\nb" });
});

test("custom and function history keep paired call IDs without advertising retired tools", () => {
  const argumentsText = '{ "value": false, "count": 0, "missing": null }';
  const raw = 'text("历史 🧪");\n';
  const input = [
    { role: "user", content: "Original task" },
    { id: "item_custom", type: "custom_tool_call", namespace: "retired", name: "exec", call_id: "old_custom", input: raw },
    { type: "custom_tool_call_output", call_id: "old_custom", output: [{ type: "input_text", text: "custom result" }] },
    { id: "item_function", type: "function_call", namespace: "retired", name: "inspect", call_id: "old_function", arguments: argumentsText },
    { type: "function_call_output", call_id: "old_function", output: "function result" },
    { role: "developer", content: "Continue under the current tool catalog." },
    { role: "user", content: "Newest follow-up task" },
  ];
  const original = structuredClone(input);
  const codec = makeCodec({ tools: [functionTool("current")], input });
  assert.deepEqual(input, original);
  assert.equal(codec.request.tools.length, 1);
  assert.deepEqual(codec.request.input, [
    input[0],
    { id: "item_custom", ...call("retired__exec", "old_custom", JSON.stringify({ input: raw })) },
    { ...input[2], type: "function_call_output" },
    { id: "item_function", ...call("retired__inspect", "old_function", argumentsText) },
    ...input.slice(4),
  ]);
  for (const name of ["retired__exec", "retired__inspect"]) {
    assert.equal(codec.request.tools.some(tool => tool.name === name), false);
    expectInvalidCall(() => codec.restore({ output: [call(name, "new_call")] }));
  }
});

test("tool_choice preserves selection semantics and targets the encoded namespace identity", () => {
  const tools = [
    { type: "namespace", name: "one", tools: [customTool("exec")] },
    { type: "namespace", name: "two", tools: [customTool("exec")] },
  ];
  for (const tool_choice of ["auto", "none", "required"]) assert.equal(makeCodec({ tools, tool_choice }).request.tool_choice, tool_choice);
  const codec = makeCodec({ tools, tool_choice: { type: "custom", namespace: "two", name: "exec" } });
  assert.deepEqual(codec.request.tool_choice, { type: "function", name: codec.request.tools[1].name });
  const functionCodec = makeCodec({ tools: [functionTool("inspect")], tool_choice: { type: "function", name: "inspect" } });
  assert.deepEqual(functionCodec.request.tool_choice, { type: "function", name: functionCodec.request.tools[0].name });
});

test("function and custom selectors must identify an advertised tool with the correct namespace", () => {
  const tools = [functionTool("inspect"), { type: "namespace", name: "runtime", tools: [customTool()] }];
  for (const tool_choice of [
    { type: "function", name: "retired" },
    { type: "function", name: "inspect", namespace: "wrong" },
    { type: "function" },
    { type: "custom", name: "exec" },
    { type: "custom", name: "exec", namespace: "wrong" },
    { type: "custom" },
  ]) assert.throws(() => makeCodec({ tools, tool_choice }), error => error?.code === "invalid_request");
  const nativeChoice = { type: "web_search" };
  assert.deepEqual(makeCodec({ tools: [{ type: "web_search" }], tool_choice: nativeChoice }).request.tool_choice, nativeChoice);
});

test("the host grammar validator receives original custom identity and rejects invalid raw input", () => {
  const seen = [];
  const tool = customTool();
  const codec = makeCodec({ tools: [{ type: "namespace", name: "runtime", tools: [tool] }] }, {
    validateCustomInput(value) { seen.push(value); return value.input === "allowed 🧪\n"; },
  });
  assert.equal(codec.restore({ output: [call(codec.request.tools[0].name, "valid", JSON.stringify({ input: "allowed 🧪\n" }))] }).output[0].input, "allowed 🧪\n");
  expectInvalidCall(() => codec.restore({ output: [call(codec.request.tools[0].name, "invalid", JSON.stringify({ input: "forbidden" }))] }));
  assert.deepEqual(seen, ["allowed 🧪\n", "forbidden"].map(input => ({ name: "exec", namespace: "runtime", input, format: tool.format })));
});

test("malformed JSON, custom wrapper extras and non-object function arguments cannot become executable calls", () => {
  const custom = makeCodec({ tools: [customTool()] });
  for (const args of ['{"input":', '{"input":"ok","extra":false}', '{"input":false}', '{"input":0}', '{"input":null}', '"raw"', "null", "[]"]) {
    expectInvalidCall(() => custom.restore({ output: [call(custom.request.tools[0].name, "bad", args)] }));
  }
  const fn = makeCodec({ tools: [functionTool("inspect")] });
  for (const args of ['{"value":', "null", "false", "0", "[]", '"raw"']) {
    expectInvalidCall(() => fn.restore({ output: [call(fn.request.tools[0].name, "bad", args)] }));
  }
});

test("unadvertised calls, duplicate call IDs and forbidden parallel calls are rejected", () => {
  const codec = makeCodec({ tools: [functionTool("inspect")] });
  expectInvalidCall(() => codec.restore({ output: [call("invented_tool", "bad")] }));
  expectInvalidCall(() => codec.restore({ output: [call(codec.request.tools[0].name, "same"), call(codec.request.tools[0].name, "same")] }));
  const serial = makeCodec({ tools: [functionTool("inspect")], parallel_tool_calls: false });
  expectInvalidCall(() => serial.restore({ output: [call(serial.request.tools[0].name, "one"), call(serial.request.tools[0].name, "two")] }));
});

test("completed tool calls require a nonempty string call ID for safe client continuation", () => {
  const codec = makeCodec({ tools: [functionTool("inspect"), customTool()] });
  for (const [index, tool] of codec.request.tools.entries()) {
    for (const callId of [undefined, null, "", 0, false]) {
      expectInvalidCall(() => codec.restore({ output: [call(tool.name, callId, index ? '{"input":"fixture"}' : "{}")] }));
    }
  }
});

test("returned calls respect none, required and an explicitly selected identity", () => {
  const tools = [functionTool("one"), functionTool("two")];
  const disabled = makeCodec({ tools, tool_choice: "none" });
  expectInvalidCall(() => disabled.restore({ status: "completed", output: [call(disabled.request.tools[0].name, "call_disabled")] }));
  const required = makeCodec({ tools, tool_choice: "required" });
  expectInvalidCall(() => required.restore({ status: "completed", output: [] }));
  const selected = makeCodec({ tools, tool_choice: { type: "function", name: "one" } });
  expectInvalidCall(() => selected.restore({ status: "completed", output: [call(selected.request.tools[1].name, "call_wrong")] }));
  assert.equal(selected.restore({ status: "completed", output: [call(selected.request.tools[0].name, "call_right")] }).output[0].name, "one");
});

test("passthrough makes one Responses call per turn and returns tools to the client", async () => {
  const seen = [], notices = [];
  const controller = new AbortController();
  const bridge = createGLMToolPassthrough({
    model: "glm-5.3-flash", onResponse: value => notices.push(value),
    transport: { async complete(envelope, signal) {
      seen.push(envelope);
      assert.equal(signal, controller.signal);
      return { id: "response_fixture", status: "completed", output: [call(envelope.request.tools[0].name, "client_call", JSON.stringify({ input: "text(false, 0, null)" }))] };
    } },
  });
  const request = { input: [{ role: "user", content: "Run the client tool" }], tools: [customTool()] };
  const original = structuredClone(request);
  const result = await bridge.runTurn({ request, signal: controller.signal, sessionId: "fixture_session" });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].protocol, "responses");
  assert.equal(seen[0].sessionId, "fixture_session");
  assert.equal(seen[0].request.model, "glm-5.3-flash");
  assert.equal(seen[0].request.reasoning.effort, "high");
  assert.deepEqual(request, original);
  assert.deepEqual(result.output, [{ type: "custom_tool_call", name: "exec", call_id: "client_call", input: "text(false, 0, null)" }]);
  assert.deepEqual(notices, [{ calls: [{ type: "custom_tool_call", name: "exec", namespace: undefined, callId: "client_call" }] }]);
  await assert.rejects(bridge.runTurn({ protocol: "chat", request }), error => error?.code === "protocol");
  assert.equal(seen.length, 1);
});

test("Chat conversion keeps full explicit history, reasoning and adjacent parallel call/result batches", () => {
  const input = [
    { role: "user", content: [{ type: "input_text", text: "Original main task" }] },
    { role: "developer", content: "Subagent constraint: inspect only" },
    { type: "reasoning", content: [{ type: "reasoning_text", text: "Think 中文 " }, { type: "reasoning_text", text: "🧪" }] },
    { role: "assistant", content: [{ type: "output_text", text: "I will inspect both tools." }] },
    { type: "custom_tool_call", namespace: "runtime", name: "exec", call_id: "custom_one", input: "text(0)\n" },
    { role: "developer", content: "Interleaved developer update" },
    { type: "function_call", name: "inspect", call_id: "function_two", arguments: '{ "value": false }' },
    { type: "function_call_output", call_id: "function_two", output: "second tool result" },
    { role: "user", content: "Interleaved latest user update" },
    { type: "custom_tool_call_output", call_id: "custom_one", output: [{ type: "input_text", text: "first tool result" }] },
    { role: "assistant", content: "Both inspections completed." },
    { role: "user", content: "Latest task: report findings." },
  ];
  const codec = makeCodec({ instructions: "Global instructions", input, tools: [
    { type: "namespace", name: "runtime", tools: [customTool()] }, functionTool("inspect"),
  ] });
  const original = structuredClone(codec.request);
  const chat = responsesToGLMChat(codec.request);
  assert.deepEqual(codec.request, original);
  assert.deepEqual(chat.messages, [
    { role: "system", content: "Global instructions" },
    { role: "user", content: "Original main task" },
    { role: "system", content: "Subagent constraint: inspect only" },
    { role: "assistant", content: "I will inspect both tools.", reasoning_content: "Think 中文 🧪", tool_calls: [
      { id: "custom_one", type: "function", function: { name: "runtime__exec", arguments: JSON.stringify({ input: "text(0)\n" }) } },
      { id: "function_two", type: "function", function: { name: "client__inspect", arguments: '{ "value": false }' } },
    ] },
    { role: "tool", tool_call_id: "function_two", content: "second tool result" },
    { role: "tool", tool_call_id: "custom_one", content: "first tool result" },
    { role: "system", content: "Interleaved developer update" },
    { role: "user", content: "Interleaved latest user update" },
    { role: "assistant", content: "Both inspections completed." },
    { role: "user", content: "Latest task: report findings." },
  ]);
  assert.deepEqual(chat.thinking, { type: "enabled", clear_thinking: false });
  assert.equal(chat.reasoning_effort, "high");
});

test("Chat conversion maps explicit tool choice only with endpoint support", () => {
  const request = makeCodec({ tools: [functionTool("inspect")], tool_choice: { type: "function", name: "inspect" } }).request;
  expectUnsupported(() => responsesToGLMChat(request));
  const chat = responsesToGLMChat(request, { supportsToolChoice: true });
  assert.deepEqual(chat.tool_choice, { type: "function", function: { name: request.tools[0].name } });
  const none = responsesToGLMChat({ ...request, tool_choice: "none" });
  assert.equal(none.tools, undefined);
  const required = { ...request, tool_choice: "required" };
  expectUnsupported(() => responsesToGLMChat(required));
  assert.equal(responsesToGLMChat(required, { supportsToolChoice: true }).tool_choice, "required");
});

test("Chat conversion rejects opaque response state and unsupported history instead of dropping it", () => {
  const base = { model: "glm-5.3", input: "Current task", tools: [] };
  for (const extension of [
    { previous_response_id: "resp_opaque" }, { conversation: "conv_opaque" },
    { prompt: { id: "prompt_opaque" } }, { context_management: [{ type: "compaction" }] },
    { store: true }, { background: true }, { text: { format: { type: "json_schema", name: "fixture", schema: {} } } },
  ]) expectUnsupported(() => responsesToGLMChat({ ...base, ...extension }));
  for (const item of [
    { type: "item_reference", id: "item_opaque" },
    { type: "reasoning", encrypted_content: "opaque-provider-state", content: [] },
    { type: "reasoning", content: [{ type: "unknown", text: "must not disappear" }] },
    { type: "reasoning", summary: [{ type: "summary_text", text: "Only visible summary remains; raw reasoning is unavailable." }] },
    { type: "compaction", encrypted_content: "opaque-compaction-state" },
  ]) expectUnsupported(() => responsesToGLMChat({ ...base, input: [{ role: "user", content: "Task" }, item] }));
});

test("Chat conversion rejects built-in tools and unsupported images", () => {
  const base = { model: "glm-5.3", input: "Task" };
  for (const type of ["web_search", "file_search", "computer_use_preview", "image_generation"]) {
    expectUnsupported(() => responsesToGLMChat({ ...base, tools: [{ type }] }));
  }
  const imageRequest = { ...base, input: [{ role: "user", content: [
    { type: "input_text", text: "Inspect this fixture" }, { type: "input_image", image_url: "https://example.invalid/fixture.png" },
  ] }] };
  expectUnsupported(() => responsesToGLMChat(imageRequest));
  expectUnsupported(() => responsesToGLMChat({ ...base, input: [{ role: "user", content: [{ type: "input_image", file_id: "file_opaque" }] }] }, { allowImages: true }));
});

test("Chat conversion rejects missing, duplicate and orphan historical tool results", () => {
  const base = { model: "glm-5.3", tools: [] };
  const historyCall = call("retired__inspect", "fixture_call");
  for (const input of [
    [historyCall],
    [historyCall, { ...historyCall }],
    [{ type: "function_call_output", call_id: "orphan", output: "result" }],
    [historyCall, { type: "function_call_output", call_id: "fixture_call", output: "one" }, { type: "function_call_output", call_id: "fixture_call", output: "duplicate" }],
  ]) assert.throws(() => responsesToGLMChat({ ...base, input }), error => error?.code === "invalid_request");
});
