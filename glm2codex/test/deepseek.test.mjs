import test from "node:test";
import assert from "node:assert/strict";
import {
  DEEPSEEK_DEFAULT_MODEL, DEEPSEEK_MODELS, prepareDeepSeekRequest,
  createDeepSeekTransport, createDeepSeekToolPassthrough, createDeepSeekCodexRelay,
} from "../src/deepseek.mjs";

const fn = name => ({ type: "function", name, parameters: { type: "object", properties: {}, additionalProperties: true } });
const custom = { type: "custom", name: "exec", format: { type: "grammar", syntax: "lark", definition: "start: SOURCE" } };
const completed = output => ({ id: "resp_fixture", object: "response", status: "completed", output });
const textOutput = text => ({ id: "msg_fixture", type: "message", role: "assistant", content: [{ type: "output_text", text }] });
const toolCall = (name, callId, args) => ({ id: `item_${callId}`, type: "function_call", name, call_id: callId, arguments: args });
const json = body => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const unsupported = callback => assert.throws(callback, error => error?.code === "protocol");
const invalid = callback => assert.throws(callback, error => error?.code === "invalid_request");
const sse = events => events.map((event, sequence_number) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join("");

test("DeepSeek model and reasoning defaults use the documented provider mapping", () => {
  assert.equal(DEEPSEEK_DEFAULT_MODEL, "deepseek-flash");
  assert.deepEqual(DEEPSEEK_MODELS, ["deepseek-flash", "deepseek-v4-pro"]);
  for (const model of DEEPSEEK_MODELS) {
    assert.deepEqual(prepareDeepSeekRequest({ model, input: "Task" }).reasoning, { effort: "high" });
    for (const [effort, expected] of Object.entries({ none: "none", minimal: "low", low: "low", medium: "high", high: "high", xhigh: "high", max: "max", ultra: "max" })) {
      const request = { model, input: "Task", reasoning: { effort } };
      const original = structuredClone(request);
      assert.equal(prepareDeepSeekRequest(request).reasoning.effort, expected);
      assert.deepEqual(request, original);
    }
  }
  assert.equal(prepareDeepSeekRequest({ input: "Task", reasoning_effort: "xhigh" }).reasoning.effort, "high");
  const disabled = prepareDeepSeekRequest({ input: "Task", thinking: { type: "disabled" } });
  assert.deepEqual(disabled.reasoning, { effort: "none" });
  assert.equal(Object.hasOwn(disabled, "thinking"), false);
  assert.equal(Object.hasOwn(disabled, "reasoning_effort"), false);
  assert.equal(prepareDeepSeekRequest({ input: "Task" }, { reasoningEffort: "ultra" }).reasoning.effort, "max");
  invalid(() => prepareDeepSeekRequest({ input: "Task", model: "glm-5.3" }));
  invalid(() => prepareDeepSeekRequest({ input: "Task", reasoning: { effort: "unknown" } }));
});

test("DeepSeek rejects documented ignored semantic controls instead of claiming support", () => {
  for (const extension of [
    { reasoning: { summary: "auto" } }, { reasoning: { summary: "detailed" } },
    { text: { verbosity: "high" } }, { service_tier: "priority" }, { safety_identifier: "fixture" },
    { prompt_cache_key: "fixture" }, { prompt_cache_retention: "24h" }, { stream_options: { include_obfuscation: false } },
  ]) unsupported(() => prepareDeepSeekRequest({ input: "Task", ...extension }));
  assert.equal(prepareDeepSeekRequest({ input: "Task", reasoning: { summary: "none" } }).reasoning.summary, "none");
});

test("DeepSeek preserves instructions, full user/subagent history and raw reasoning without mutation", () => {
  const input = [
    { role: "user", content: "Original parent task" },
    { role: "developer", content: [{ type: "input_text", text: "Subagent constraint: inspect source only" }] },
    { type: "reasoning", id: "reason_fixture", content: [{ type: "reasoning_text", text: "fixture reasoning 中文 🧪\n" }] },
    { role: "assistant", content: [{ type: "output_text", text: "I inspected the first part." }] },
    { role: "developer", content: "Keep the newest developer constraint." },
    { role: "user", content: "Latest user update: include the delegated task." },
  ];
  const request = { input, instructions: "Global instructions", tools: [fn("inspect")] };
  const original = structuredClone(request);
  const result = prepareDeepSeekRequest(request);
  assert.deepEqual(request, original);
  assert.equal(result.instructions, original.instructions);
  assert.deepEqual(result.input, input.map(item => item.role === "developer" ? { ...item, role: "system" } : item));
  assert.deepEqual(result.input[2], input[2]);
});

test("DeepSeek requires explicit history instead of opaque state or ignored provider history", () => {
  const base = { input: "Task" };
  for (const extension of [
    { previous_response_id: "resp_opaque" }, { conversation: { id: "conv_opaque" } },
    { prompt: { id: "prompt_opaque" } }, { context_management: [{ type: "compaction" }] },
    { store: true }, { background: true }, { include: ["reasoning.encrypted_content"] },
    { truncation: "auto" }, { max_tool_calls: 1 }, { tool_stream: true },
  ]) unsupported(() => prepareDeepSeekRequest({ ...base, ...extension }));
  for (const item of [
    { type: "item_reference", id: "item_opaque" },
    { type: "web_search_call", id: "old_search", action: { type: "search", query: "fixture" } },
    { type: "reasoning", encrypted_content: "opaque", content: [] },
    { type: "reasoning", summary: [{ type: "summary_text", text: "Summary cannot substitute for full reasoning." }] },
    { role: "assistant", content: "Answer", reasoning_content: "Chat-only history field" },
    { role: "user", content: [{ type: "input_file", file_id: "file_opaque" }] },
    { role: "user", content: [{ type: "input_audio", data: "fixture" }] },
  ]) unsupported(() => prepareDeepSeekRequest({ input: [item] }));
  assert.equal(prepareDeepSeekRequest({ ...base, store: false, background: false, truncation: "disabled" }).store, false);
});

test("DeepSeek rejects unsupported builtins and invalid selectors before the upstream call", async () => {
  for (const type of ["web_search", "file_search", "computer_use", "code_interpreter", "mcp"]) {
    unsupported(() => prepareDeepSeekRequest({ input: "Task", tools: [{ type }] }));
  }
  for (const tool_choice of [
    { type: "function", name: "retired" }, { type: "custom", name: "inspect" },
    { type: "function", name: "inspect", namespace: "wrong" }, { type: "function" },
  ]) invalid(() => prepareDeepSeekRequest({ input: "Task", tools: [fn("inspect")], tool_choice }));
  let count = 0;
  const bridge = createDeepSeekToolPassthrough({ transport: { async complete() { count++; return completed([textOutput("done")]); } } });
  await assert.rejects(bridge.runTurn({ request: { input: "Task", tools: [{ type: "web_search" }] } }), error => error.code === "protocol");
  assert.equal(count, 0);
  assert.throws(() => createDeepSeekToolPassthrough({ transport: { complete() {} }, nativeTools: [{ type: "web_search" }] }), error => error.code === "configuration");
});

test("DeepSeek images retain supported sources only in flash user messages or tool outputs", () => {
  const image = { type: "input_image", image_url: "https://example.invalid/image.png", detail: "high" };
  const fileImage = { type: "input_image", file_id: "file-api-fixture", detail: "original" };
  const input = [
    { role: "user", content: [{ type: "input_text", text: "Inspect image" }, image, fileImage] },
    toolCall("screenshot", "image_call", "{}"),
    { type: "function_call_output", call_id: "image_call", output: [image] },
  ];
  assert.deepEqual(prepareDeepSeekRequest({ input }).input, input);
  unsupported(() => prepareDeepSeekRequest({ model: "deepseek-v4-pro", input }));
  for (const role of ["assistant", "system", "developer"]) unsupported(() => prepareDeepSeekRequest({ input: [{ role, content: [image] }] }));
  for (const part of [
    { type: "input_image" }, { ...image, file_id: "file-api-fixture" },
    { type: "input_image", file_id: "another-provider-file" }, { ...image, detail: "unknown" },
  ]) invalid(() => prepareDeepSeekRequest({ input: [{ role: "user", content: [part] }] }));
});

test("DeepSeek validates historical call/result pairing before sending full history", () => {
  const call = toolCall("retired", "old", "{}");
  const result = { type: "function_call_output", call_id: "old", output: "fixture" };
  for (const input of [
    [call], [result], [call, call, result], [call, result, result],
    [call, { ...result, type: "custom_tool_call_output" }],
    [{ ...call, call_id: "" }, result], [{ ...call, arguments: "false" }, result],
  ]) invalid(() => prepareDeepSeekRequest({ input }));
});

test("DeepSeek native transport uses /responses once and emits no GLM options", async () => {
  const seen = [];
  const bridge = createDeepSeekToolPassthrough({ transport: createDeepSeekTransport({ apiKey: "fixture-runtime-key", fetchImpl: async (url, init) => {
    seen.push({ url, body: JSON.parse(init.body), authorization: new Headers(init.headers).get("authorization") });
    return json(completed([textOutput("done")]));
  } }) });
  await bridge.runTurn({ request: { input: "Task", reasoning_effort: "xhigh", thinking: { type: "enabled" } } });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "https://api.deepseek.com/responses");
  assert.equal(seen[0].authorization, "Bearer fixture-runtime-key");
  assert.equal(seen[0].body.model, "deepseek-flash");
  assert.deepEqual(seen[0].body.reasoning, { effort: "high" });
  for (const field of ["thinking", "reasoning_effort", "tool_stream"]) assert.equal(Object.hasOwn(seen[0].body, field), false);
  assert.equal(seen[0].body.stream, false);
});

test("native DeepSeek transport does not retry auth or unsupported responses errors", async () => {
  for (const status of [401, 403, 404, 429, 500]) {
    let count = 0;
    const transport = createDeepSeekTransport({ baseUrl: "https://gateway.invalid", fetchImpl: async () => {
      count++;
      return new Response(JSON.stringify({ error: { code: "fixture_error", message: "fixture failure" } }), { status, headers: { "content-type": "application/json" } });
    } });
    await assert.rejects(transport.complete({ protocol: "responses", request: { input: "Task" } }), error => error.code === "upstream");
    assert.equal(count, 1);
  }
});

test("DeepSeek only falls back after explicit Responses absence and preserves history without GLM fields", async () => {
  const seen = [], protocols = [];
  const transport = createDeepSeekTransport({ baseUrl: "https://gateway.invalid/proxy/responses", onProtocol: event => protocols.push(event), fetchImpl: async (url, init) => {
    const body = JSON.parse(init.body);
    seen.push({ url, body, sessionId: new Headers(init.headers).get("session_id") });
    if (seen.length === 1) return new Response(JSON.stringify({ error: { code: "unsupported_endpoint", message: "Responses endpoint is unavailable" } }), { status: 404, headers: { "content-type": "application/json" } });
    return json({ id: "chat_fixture", model: "deepseek-flash", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "done", reasoning_content: "new thinking" } }] });
  } });
  const bridge = createDeepSeekToolPassthrough({ transport });
  const reasoning = { type: "reasoning", content: [{ type: "reasoning_text", text: "all prior thinking" }] };
  const result = await bridge.runTurn({ sessionId: "fixture_session", request: {
    instructions: "Global task", tools: [fn("inspect")], reasoning: { effort: "xhigh" },
    input: [{ role: "developer", content: "Subagent task authority" }, { role: "user", content: "Initial task" }, reasoning,
      toolCall("inspect", "prior", "{}"), { type: "function_call_output", call_id: "prior", output: "prior result" },
      { role: "user", content: "Latest update" }],
  } });
  assert.deepEqual(seen.map(item => item.url), ["https://gateway.invalid/proxy/responses", "https://gateway.invalid/proxy/chat/completions"]);
  assert.deepEqual(seen.map(item => item.sessionId), ["fixture_session", "fixture_session"]);
  assert.deepEqual(protocols, [{ protocol: "responses", reason: "preferred" }, { protocol: "chat", reason: "responses_unsupported" }]);
  const chat = seen[1].body;
  assert.deepEqual(chat.thinking, { type: "enabled" });
  assert.equal(chat.reasoning_effort, "high");
  assert.equal(Object.hasOwn(chat, "tool_stream"), false);
  assert.equal(Object.hasOwn(chat.thinking, "clear_thinking"), false);
  assert.equal(chat.messages[0].content, "Global task");
  assert.deepEqual(chat.messages[1], { role: "system", content: "Subagent task authority" });
  assert.equal(chat.messages.find(item => item.reasoning_content).reasoning_content, "all prior thinking");
  assert.equal(chat.messages.at(-1).content, "Latest update");
  assert.equal(result.output[0].content[0].text, "new thinking");
  assert.equal(result.output[1].content[0].text, "done");
});

test("DeepSeek native-only mode never downgrades and endpoint paths remain on one authority", async () => {
  let count = 0;
  const bridge = createDeepSeekToolPassthrough({ transport: createDeepSeekTransport({ upstreamProtocol: "responses", fetchImpl: async () => {
    count++;
    return new Response(JSON.stringify({ error: { code: "unsupported_endpoint", message: "Responses is unsupported" } }), { status: 404 });
  } }) });
  await assert.rejects(bridge.runTurn({ request: { input: "Task" } }), error => error.code === "upstream");
  assert.equal(count, 1);
  for (const options of [
    { baseUrl: "http://nonlocal.invalid" }, { baseUrl: "https://user:password@fixture.invalid" },
    { responsesPath: "https://other.invalid/responses" }, { responsesPath: "//other.invalid/responses" },
    { chatPath: "/../chat/completions" }, { baseUrl: "https://fixture.invalid?token=fixture" },
  ]) assert.throws(() => createDeepSeekTransport(options), error => error.code === "configuration");
});

test("DeepSeek named and required Chat choice require disabled thinking without remapping max", async () => {
  for (const choice of ["required", { type: "custom", namespace: "runtime", name: "exec" }]) {
    let count = 0;
    const transport = createDeepSeekTransport({ upstreamProtocol: "chat", fetchImpl: async (_url, init) => {
      count++;
      const request = JSON.parse(init.body);
      assert.deepEqual(request.thinking, { type: "disabled" });
      assert.equal(Object.hasOwn(request, "reasoning_effort"), false);
      assert.equal(Object.hasOwn(request, "tool_stream"), false);
      if (typeof choice === "object") assert.deepEqual(request.tool_choice, { type: "function", function: { name: request.tools[0].function.name } });
      else assert.equal(request.tool_choice, "required");
      return json({ id: "chat_selected", choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null,
        tool_calls: [{ id: "selected", type: "function", function: { name: request.tools[0].function.name, arguments: '{"input":"fixture"}' } }] } }] });
    } });
    const bridge = createDeepSeekToolPassthrough({ transport });
    const request = { input: "Task", tools: [{ type: "namespace", name: "runtime", tools: [custom] }], tool_choice: choice };
    await assert.rejects(bridge.runTurn({ request: { ...request, reasoning: { effort: "high" } } }), error => error.code === "protocol");
    assert.equal(count, 0);
    const result = await bridge.runTurn({ request: { ...request, reasoning: { effort: "none" } } });
    assert.equal(count, 1);
    assert.equal(result.output[0].namespace, "runtime");
    assert.equal(result.output[0].name, "exec");
    assert.equal(result.output[0].input, "fixture");
  }
});

test("DeepSeek Chat none retains tools needed to replay reasoning and preserves max effort", async () => {
  let captured;
  const bridge = createDeepSeekToolPassthrough({ transport: createDeepSeekTransport({ upstreamProtocol: "chat", fetchImpl: async (_url, init) => {
    captured = JSON.parse(init.body);
    return json({ id: "chat_none", choices: [{ finish_reason: "stop", message: { role: "assistant", content: "done" } }] });
  } }) });
  await bridge.runTurn({ request: { input: "Task", tools: [fn("inspect")], tool_choice: "none", reasoning: { effort: "max" } } });
  assert.equal(captured.tool_choice, "none");
  assert.equal(captured.tools.length, 1);
  assert.equal(captured.reasoning_effort, "max");
  assert.deepEqual(captured.thinking, { type: "enabled" });
});

test("DeepSeek Chat maps user identity and refuses logprob loss before dispatch", async () => {
  const native = prepareDeepSeekRequest({ input: "Task", user_id: "fixture_user" });
  assert.equal(native.user, "fixture_user");
  assert.equal(Object.hasOwn(native, "user_id"), false);
  invalid(() => prepareDeepSeekRequest({ input: "Task", user: "one", user_id: "two" }));
  invalid(() => prepareDeepSeekRequest({ input: "Task", user: 123 }));
  const seen = [];
  const bridge = createDeepSeekToolPassthrough({ transport: createDeepSeekTransport({ upstreamProtocol: "chat", fetchImpl: async (_url, init) => {
    seen.push(JSON.parse(init.body));
    return json({ id: "chat_user", choices: [{ finish_reason: "stop", message: { role: "assistant", content: "done" } }] });
  } }) });
  await bridge.runTurn({ request: { input: "Task", user: "fixture_user" } });
  assert.equal(seen[0].user_id, "fixture_user");
  assert.equal(Object.hasOwn(seen[0], "user"), false);
  for (const extension of [{ top_logprobs: 0 }, { top_logprobs: 3 }, { logprobs: true }]) {
    await assert.rejects(bridge.runTurn({ request: { input: "Task", ...extension } }), error => error.code === "protocol");
  }
  await assert.rejects(bridge.runTurn({ request: { input: "Task", user: "one", user_id: "two" } }), error => error.code === "invalid_request");
  assert.equal(seen.length, 1);
});

test("DeepSeek streaming Chat fallback removes GLM-only stream fields and restores client tools", async () => {
  const seen = [];
  const bridge = createDeepSeekToolPassthrough({ transport: createDeepSeekTransport({ fetchImpl: async (url, init) => {
    const body = JSON.parse(init.body);
    seen.push({ url, body, sessionId: new Headers(init.headers).get("session_id") });
    if (seen.length === 1) return new Response(JSON.stringify({ error: { code: "unsupported_endpoint", message: "Responses unsupported" } }), { status: 404 });
    assert.equal(body.stream, true);
    assert.equal(Object.hasOwn(body, "tool_stream"), false);
    assert.deepEqual(body.thinking, { type: "enabled" });
    const name = body.tools[0].function.name;
    const chunks = [
      { id: "chat_stream", choices: [{ index: 0, delta: { reasoning_content: "fixture thinking" }, finish_reason: null }] },
      { id: "chat_stream", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "stream_custom", type: "function", function: { name, arguments: '{"input":"fixture 🧪"}' } }] }, finish_reason: null }] },
      { id: "chat_stream", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ];
    return new Response(chunks.map(value => `data: ${JSON.stringify(value)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  } }) });
  const frames = [];
  for await (const frame of bridge.streamTurn({ sessionId: "fallback_stream_session", request: { input: "Task", tools: [custom] } })) frames.push(frame);
  assert.deepEqual(seen.map(item => item.url), ["https://api.deepseek.com/responses", "https://api.deepseek.com/chat/completions"]);
  assert.deepEqual(seen.map(item => item.sessionId), ["fallback_stream_session", "fallback_stream_session"]);
  assert.equal(frames.at(-1).value.type, "response.completed");
  const output = frames.at(-1).value.response.output;
  assert.equal(output[0].content[0].text, "fixture thinking");
  assert.equal(output[1].type, "custom_tool_call");
  assert.equal(output[1].input, "fixture 🧪");
});

test("DeepSeek restores namespace and raw custom input while retaining retired history without re-advertising", async () => {
  const raw = 'text("中文 🧪 \\\\fixture");\ntext(false, 0, null);\r\n';
  const tools = [
    { type: "namespace", name: "first_".repeat(20), description: "First tool authority", tools: [custom] },
    { type: "namespace", name: "second_".repeat(20), description: "Second tool authority", tools: [custom] },
    fn("inspect"),
  ];
  const history = [
    { role: "user", content: "Original task" },
    { type: "reasoning", content: [{ type: "reasoning_text", text: "prior reasoning" }] },
    { type: "custom_tool_call", namespace: "retired", name: "exec", call_id: "old_custom", input: "text(0)" },
    { type: "custom_tool_call_output", call_id: "old_custom", output: "old result" },
    { role: "developer", content: "Newest constraint" },
    { role: "user", content: "Latest task" },
  ];
  const seen = [], grammar = [];
  const bridge = createDeepSeekToolPassthrough({ validateCustomInput: value => { grammar.push(value); return true; }, transport: { async complete({ protocol, request }) {
    assert.equal(protocol, "responses");
    seen.push(request);
    if (seen.length === 1) return completed([
      { id: "reason_new", type: "reasoning", content: [{ type: "reasoning_text", text: "current reasoning" }] },
      toolCall(request.tools[1].name, "raw", JSON.stringify({ input: raw })),
      toolCall(request.tools[2].name, "values", '{ "flag": false, "count": 0, "nil": null }'),
    ]);
    return completed([textOutput("done")]);
  } } });
  const request = { input: history, tools, instructions: "Keep all history" };
  const original = structuredClone(request);
  const result = await bridge.runTurn({ request });
  assert.deepEqual(request, original);
  assert.equal(new Set(seen[0].tools.map(tool => tool.name)).size, 3);
  for (const tool of seen[0].tools) assert.match(tool.name, /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/);
  assert.match(seen[0].tools[1].description, /Second tool authority/);
  assert.equal(seen[0].tools.some(tool => tool.name === "retired__exec"), false);
  assert.equal(seen[0].input[2].name, "retired__exec");
  assert.equal(seen[0].input[3].call_id, "old_custom");
  assert.deepEqual(result.output[1], { id: "item_raw", type: "custom_tool_call", name: "exec", namespace: tools[1].name, call_id: "raw", input: raw });
  assert.equal(result.output[2].arguments, '{ "flag": false, "count": 0, "nil": null }');
  assert.deepEqual(grammar, [{ name: "exec", namespace: tools[1].name, input: raw, format: custom.format }]);
  await bridge.runTurn({ request: { input: [...history, ...result.output,
    { type: "custom_tool_call_output", call_id: "raw", output: "custom done" },
    { type: "function_call_output", call_id: "values", output: "function done" },
  ], tools, instructions: request.instructions } });
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[1].input.filter(item => item.type === "reasoning"), [history[1], result.output[0]]);
  assert.deepEqual(seen[1].input.slice(-2).map(item => item.call_id), ["raw", "values"]);
});

test("DeepSeek uses shared validation to reject invalid calls and disabled parallel execution", async () => {
  for (const variant of ["extra", "malformed", "unknown", "grammar", "parallel", "duplicate"]) {
    const bridge = createDeepSeekToolPassthrough({ validateCustomInput: () => variant !== "grammar", transport: { async complete({ request }) {
      const item = toolCall(variant === "unknown" ? "unadvertised" : request.tools[0].name, "first",
        variant === "extra" ? '{"input":"raw","extra":false}' : variant === "malformed" ? '{"input":' : '{"input":"raw"}');
      return completed(variant === "parallel" || variant === "duplicate" ? [item, { ...item, call_id: variant === "duplicate" ? "first" : "second" }] : [item]);
    } } });
    await assert.rejects(bridge.runTurn({ request: { input: "Task", tools: [custom], parallel_tool_calls: variant !== "parallel" } }), error => error.code === "invalid_tool_call");
  }
});

test("DeepSeek terminal SSE without DONE preserves reasoning and returns client custom calls", async () => {
  const raw = "text('中文 🧪');\n";
  const reasoning = { id: "reason_fixture", type: "reasoning", content: [{ type: "reasoning_text", text: "fixture reasoning" }] };
  let count = 0;
  const bridge = createDeepSeekToolPassthrough({ transport: createDeepSeekTransport({ fetchImpl: async (_url, init) => {
    count++;
    const request = JSON.parse(init.body);
    assert.equal(request.stream, true);
    const item = toolCall(request.tools[0].name, "stream_call", JSON.stringify({ input: raw }));
    return new Response(sse([
      { type: "response.created", response: { id: "resp_fixture", status: "in_progress" } },
      { type: "response.reasoning_text.delta", item_id: reasoning.id, delta: "fixture reasoning" },
      { type: "response.output_item.done", item: reasoning, output_index: 0 },
      { type: "response.output_item.added", item: { ...item, arguments: "" }, output_index: 1 },
      { type: "response.function_call_arguments.delta", item_id: item.id, delta: item.arguments, output_index: 1 },
      { type: "response.function_call_arguments.done", item_id: item.id, arguments: item.arguments, output_index: 1 },
      { type: "response.output_item.done", item, output_index: 1 },
      { type: "response.completed", response: completed([reasoning, item]) },
    ]), { headers: { "content-type": "text/event-stream" } });
  } }) });
  const frames = [];
  for await (const frame of bridge.streamTurn({ request: { input: "Task", tools: [custom] } })) frames.push(frame);
  assert.equal(count, 1);
  assert.equal(frames.some(frame => frame.data === "[DONE]"), false);
  assert.equal(frames.find(frame => frame.value?.type === "response.reasoning_text.delta").value.delta, "fixture reasoning");
  const terminal = frames.at(-1).value;
  assert.equal(terminal.type, "response.completed");
  assert.deepEqual(terminal.response.output[0], reasoning);
  assert.equal(terminal.response.output[1].type, "custom_tool_call");
  assert.equal(terminal.response.output[1].input, raw);
});

test("DeepSeek SSE without a terminal event fails rather than declaring a finished response", async () => {
  const bridge = createDeepSeekToolPassthrough({ transport: createDeepSeekTransport({ fetchImpl: async () => new Response(sse([
    { type: "response.created", response: { id: "resp_fixture", status: "in_progress" } },
  ]), { headers: { "content-type": "text/event-stream" } }) }) });
  await assert.rejects(async () => { for await (const _frame of bridge.streamTurn({ request: { input: "Task" } })) { /* drain */ } }, error => error.code === "upstream_stream_incomplete");
});

test("DeepSeek relay exposes a Responses endpoint using runtime-only upstream configuration", async () => {
  let count = 0;
  const relay = createDeepSeekCodexRelay({ upstream: { baseUrl: "https://fixture-gateway.invalid", fetchImpl: async (url, init) => {
    count++;
    assert.equal(url, "https://fixture-gateway.invalid/responses");
    assert.equal(JSON.parse(init.body).model, "deepseek-flash");
    return json(completed([textOutput("fixture done")]));
  } } });
  const address = await relay.listen();
  try {
    const response = await fetch(`http://${address.host}:${address.port}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: "Task" }) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).output[0].content[0].text, "fixture done");
    assert.equal(count, 1);
  } finally { await relay.close(); }
});
