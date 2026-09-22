import test from "node:test";
import assert from "node:assert/strict";
import { chatCompletionToResponses, streamGLMChatResponses } from "../src/chat-response.mjs";
import { parseSseFrame } from "../../src/sse.mjs";
import { createResponsesToolCodec } from "../../src/passthrough.mjs";
import { streamClientResponses } from "../../src/responses-stream.mjs";

const frame = body => parseSseFrame(`data: ${JSON.stringify(body)}\n\n`);
const done = () => parseSseFrame("data: [DONE]\n\n");
const chunk = (delta, finish_reason = null, extra = {}) => frame({ id: "chat_fixture", model: "glm-5", created: 42,
  choices: [{ index: 0, delta, finish_reason }], ...extra });
const complete = (message, finish_reason = "stop", extra = {}) => ({ id: "chat_fixture", model: "glm-5", created: 42,
  choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason }], ...extra });
async function collect(frames, options) { const events = []; for await (const item of streamGLMChatResponses(frames, options)) events.push(item.value); return events; }
const tool = (index, id, name, args) => ({ index, ...(id === undefined ? {} : { id }), type: "function", function: { name, arguments: args } });
const executable = event => event.type === "response.completed" || event.type === "response.function_call_arguments.done"
  || event.type === "response.output_item.done" && event.item.type === "function_call";

test("buffered completion preserves text, raw reasoning, IDs, parallel calls and token details", () => {
  const result = chatCompletionToResponses(complete({ content: "你好 🌍", reasoning_content: "think twice", tool_calls: [
    { id: "call_a", type: "function", function: { name: "encoded_a", arguments: '{"value":1}' } },
    { id: "call_b", type: "function", function: { name: "encoded_b", arguments: '{"value":2}' } },
  ] }, "tool_calls", { usage: { prompt_tokens: 10, completion_tokens: 7, total_tokens: 17,
    prompt_tokens_details: { cached_tokens: 3 }, completion_tokens_details: { reasoning_tokens: 4 } } }));
  assert.equal(result.id, "chat_fixture");
  assert.equal(result.created_at, 42);
  assert.equal(result.status, "completed");
  assert.deepEqual(result.output[0].content, [{ type: "reasoning_text", text: "think twice" }]);
  assert.deepEqual(result.output[0].summary, []);
  assert.equal(result.output[1].content[0].text, "你好 🌍");
  assert.deepEqual(result.output.slice(2).map(item => [item.call_id, item.name, item.arguments]), [["call_a", "encoded_a", '{"value":1}'], ["call_b", "encoded_b", '{"value":2}']]);
  assert.deepEqual(result.usage, { input_tokens: 10, output_tokens: 7, total_tokens: 17,
    input_tokens_details: { cached_tokens: 3 }, output_tokens_details: { reasoning_tokens: 4 } });
});

test("reasoning and text arrive before terminal, fragmented tools wait for finish_reason AND [DONE]", async () => {
  let phase = 0;
  async function* upstream() {
    yield chunk({ role: "assistant", reasoning_content: "why " });
    phase = 1;
    yield chunk({ reasoning_content: "now", content: "hello ", tool_calls: [tool(1, "call_b", "enc", '{"b":')] });
    yield chunk({ content: "world", tool_calls: [tool(0, "call_a", "fun", '{"a":'), tool(1, undefined, "oded_b", "2}")] });
    yield chunk({ tool_calls: [tool(0, "call_a", "ction_a", "1}")] }, "tool_calls");
    phase = 2;
    yield frame({ id: "chat_fixture", choices: [], usage: { prompt_tokens: 8, completion_tokens: 5, total_tokens: 13, prompt_tokens_details: { cached_tokens: 2 } } });
    phase = 3;
    yield done();
  }
  const events = [];
  for await (const item of streamGLMChatResponses(upstream())) {
    const event = item.value;
    events.push(event);
    if (event.type === "response.reasoning_text.delta" && event.delta === "why ") assert.equal(phase, 0);
    if (event.type === "response.output_text.delta") assert.equal(phase, 1);
    if (event.type.startsWith("response.function_call_") || event.item?.type === "function_call") assert.equal(phase, 3);
  }
  assert.equal(events.filter(event => event.type === "response.reasoning_text.delta").map(event => event.delta).join(""), "why now");
  assert.equal(events.filter(event => event.type === "response.output_text.delta").map(event => event.delta).join(""), "hello world");
  assert.ok(events.every((event, index) => event.sequence_number === index));
  assert.ok(events.every(event => !event.type.includes("reasoning_summary")));
  const response = events.at(-1).response;
  assert.equal(events.at(-1).type, "response.completed");
  assert.deepEqual(response.output.filter(item => item.type === "function_call").map(item => [item.call_id, item.name, item.arguments]),
    [["call_a", "function_a", '{"a":1}'], ["call_b", "encoded_b", '{"b":2}']]);
  assert.equal(response.usage.input_tokens_details.cached_tokens, 2);
});

for (const [name, frames] of [
  ["EOF without finish", [chunk({ content: "partial", tool_calls: [tool(0, "call", "run", "{}")] })]],
  ["EOF after finish", [chunk({ tool_calls: [tool(0, "call", "run", "{}")] }, "tool_calls")]],
  ["DONE without finish", [chunk({ tool_calls: [tool(0, "call", "run", "{}")] }), done()]],
]) test(`${name} never releases tool completions`, async () => {
  const events = [];
  await assert.rejects(async () => { for await (const item of streamGLMChatResponses(frames)) events.push(item.value); }, { code: "upstream_stream_incomplete" });
  assert.ok(!events.some(executable));
});

for (const finish of ["length", "content_filter"]) test(`${finish} remains incomplete with partial tool arguments`, async () => {
  const events = await collect([chunk({ content: "partial", reasoning_content: "thinking", tool_calls: [tool(0, "call", "run", '{"arg":')] }, finish), done()]);
  assert.ok(!events.some(executable));
  assert.equal(events.at(-1).type, "response.incomplete");
  assert.equal(events.at(-1).response.incomplete_details.reason, finish === "length" ? "max_output_tokens" : finish);
  assert.equal(events.at(-1).response.output.at(-1).status, "incomplete");
  assert.equal(chatCompletionToResponses(complete({ tool_calls: [{ id: "call", type: "function", function: { name: "run", arguments: "{" } }] }, finish)).status, "incomplete");
});

test("provider errors preserve code, type and message and cannot release pending tools", async () => {
  const error = { code: "1301", type: "safety_error", message: "request rejected", vendor: "reason" };
  const events = await collect([chunk({ tool_calls: [tool(0, "call", "run", "{}")] }, "tool_calls"), frame({ error }), done()]);
  assert.ok(!events.some(executable));
  assert.equal(events.at(-1).type, "response.failed");
  assert.deepEqual(events.at(-1).response.error, error);
  assert.deepEqual(chatCompletionToResponses({ error }).error, error);
});

for (const [name, calls] of [
  ["duplicate IDs", [tool(0, "same", "a", "{}"), tool(1, "same", "b", "{}")]],
  ["invalid JSON in second parallel call", [tool(0, "a", "a", "{}"), tool(1, "b", "b", "{")]],
  ["missing call ID", [tool(0, undefined, "a", "{}")]],
  ["missing name", [tool(0, "a", "", "{}")]],
]) test(`${name} validates every call before releasing any executable event`, async () => {
  const events = [];
  await assert.rejects(async () => { for await (const item of streamGLMChatResponses([chunk({ tool_calls: calls }, "tool_calls"), done()])) events.push(item.value); });
  assert.ok(!events.some(executable));
  assert.throws(() => chatCompletionToResponses(complete({ tool_calls: calls }, "tool_calls")));
});

test("unknown finish reason, extra choices, changed identity and oversized stream fail closed", async () => {
  for (const frames of [
    [chunk({ content: "text" }, "unexpected"), done()],
    [frame({ choices: [{ index: 0, delta: {} }, { index: 1, delta: {} }] })],
    [chunk({ content: "text" }), chunk({}, "stop", { id: "another" }), done()],
    [chunk({ tool_calls: [tool(0, "first", "run", "{")] }), chunk({ tool_calls: [tool(0, "second", "", "}")] }, "tool_calls"), done()],
    [chunk({ content: "text" }, "stop"), chunk({ content: "late" }), done()],
  ]) await assert.rejects(collect(frames), { code: "upstream_invalid_response" });
  await assert.rejects(collect([chunk({ content: "payload" }, "stop"), done()], { maxResponseBytes: 10 }), { code: "upstream_invalid_response" });
  await assert.rejects(collect([], { maxResponseBytes: 0 }), { code: "configuration" });
});

test("shared Responses codec restores namespace and raw custom input after Chat completion", async () => {
  const codec = createResponsesToolCodec({ tools: [{ type: "namespace", name: "functions", tools: [
    { type: "custom", name: "exec" }, { type: "function", name: "read", parameters: { type: "object" } },
  ] }] });
  const input = 'text("你好");\ntext(await tools.read({ path: "a" }));';
  const customArguments = JSON.stringify({ input });
  const customName = codec.request.tools[0].name;
  const functionName = codec.request.tools[1].name;
  const upstream = streamGLMChatResponses([
    chunk({ tool_calls: [tool(0, "custom", customName.slice(0, 5), customArguments.slice(0, 8))] }),
    chunk({ reasoning_content: "consider tools", tool_calls: [tool(1, "function", functionName, '{"path":"a"}')] }),
    chunk({ tool_calls: [tool(0, undefined, customName.slice(5), customArguments.slice(8))] }, "tool_calls"), done(),
  ]);
  const events = [];
  for await (const event of streamClientResponses(upstream, codec)) events.push(event.value);
  assert.equal(events.at(-1).type, "response.completed");
  const calls = events.at(-1).response.output.filter(item => item.type !== "reasoning");
  assert.deepEqual(calls.map(item => [item.type, item.namespace, item.name, item.call_id]), [
    ["custom_tool_call", "functions", "exec", "custom"], ["function_call", "functions", "read", "function"],
  ]);
  assert.equal(calls[0].input, input);
  assert.equal(events.find(event => event.type === "response.custom_tool_call_input.done").input, input);
  assert.equal(events.find(event => event.type === "response.function_call_arguments.done").arguments, '{"path":"a"}');
});

for (const finish of ["stop", "tool_calls"]) test(`DeepSeek terminal role:null preserves ${finish}, usage and real DONE gating`, async () => {
  const codec = createResponsesToolCodec({ tools: [{ type: "custom", name: "exec" }] });
  let sentDone = false;
  async function* upstream() {
    yield chunk({ role: "assistant", content: "" });
    if (finish === "stop") yield chunk({ content: "Hello!" });
    else yield chunk({ tool_calls: [tool(0, "call_deepseek", codec.request.tools[0].name, '{"input":"text(1)"}')] });
    // Official DeepSeek Chat shape: no separate usage-only chunk; nullable
    // role and usage accompany the last choice with a non-null finish_reason.
    yield chunk({ content: "", role: null }, finish, { usage: {
      prompt_tokens: 17, completion_tokens: 9, total_tokens: 26,
      prompt_tokens_details: { cached_tokens: 4 }, prompt_cache_hit_tokens: 4, prompt_cache_miss_tokens: 13,
    } });
    sentDone = true;
    yield done();
  }
  const events = [];
  for await (const event of streamClientResponses(streamGLMChatResponses(upstream()), codec)) {
    events.push(event.value);
    if (executable(event.value) || event.value.type === "response.custom_tool_call_input.done") assert.equal(sentDone, true);
  }
  const terminal = events.at(-1);
  assert.equal(terminal.type, "response.completed");
  assert.equal(terminal.response.usage.input_tokens, 17);
  assert.equal(terminal.response.usage.output_tokens, 9);
  assert.equal(terminal.response.usage.input_tokens_details.cached_tokens, 4);
  if (finish === "stop") assert.equal(terminal.response.output[0].content[0].text, "Hello!");
  else {
    assert.equal(terminal.response.output[0].type, "custom_tool_call");
    assert.equal(terminal.response.output[0].call_id, "call_deepseek");
    assert.equal(terminal.response.output[0].input, "text(1)");
  }
});

test("nullable delta role does not permit an actual non-assistant role", async () => {
  await assert.rejects(collect([chunk({ role: "user", content: "unexpected" }, "stop"), done()]), { code: "upstream_invalid_response" });
});

test("large numeric usage and provider error metadata retain wire precision", async () => {
  const raw = 'data: {"id":"chat_fixture","choices":[],"usage":{"prompt_tokens":9007199254740993123}}\n\n';
  const frames = [chunk({ content: "ok" }, "stop"), parseSseFrame(raw), done()];
  let terminal;
  for await (const item of streamGLMChatResponses(frames)) terminal = item;
  assert.ok(terminal.raw.includes('"input_tokens":9007199254740993123'));
});
