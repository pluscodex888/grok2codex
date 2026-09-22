import test from "node:test";
import assert from "node:assert/strict";
import { createGLMTransport, resolveGLMEndpoint } from "../src/http.mjs";
import { createGLMToolPassthrough } from "../src/index.mjs";
import { createGLMCodexRelay } from "../src/integration.mjs";
import { responseSse } from "../../src/response-events.mjs";

const result = { id: "resp_glm", object: "response", model: "glm-5.3", status: "completed",
  output: [{ id: "msg_glm", type: "message", role: "assistant", content: [{ type: "output_text", text: "done", annotations: [] }] }] };
const chat = { id: "chat_glm", object: "chat.completion", model: "glm-5.3", created: 123,
  choices: [{ index: 0, message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15, prompt_tokens_details: { cached_tokens: 4 } } };
const input = { protocol: "responses", request: { model: "glm-5.3", input: "test", reasoning: { effort: "high" } }, sessionId: "session-one" };
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const collect = async frames => { const values = []; for await (const frame of frames) values.push(frame); return values; };

test("domestic native Responses path is not the Chat API base; custom authority remains unchanged", () => {
  for (const baseUrl of [undefined, "https://open.bigmodel.cn/api/paas/v4/", "https://open.bigmodel.cn/api/v1", "https://open.bigmodel.cn/api/v1/responses"]) {
    assert.equal(resolveGLMEndpoint({ baseUrl }).url, "https://open.bigmodel.cn/api/v1/responses");
    assert.equal(resolveGLMEndpoint({ baseUrl }).chatPath, "/api/paas/v4/chat/completions");
  }
  assert.equal(resolveGLMEndpoint({ region: "overseas" }).url, "https://api.z.ai/api/paas/v4/responses");
  assert.equal(resolveGLMEndpoint({ region: "gateway", baseUrl: "https://gateway.invalid/v1" }).url, "https://gateway.invalid/v1/responses");
  assert.equal(resolveGLMEndpoint({ region: "gateway", baseUrl: "https://gateway.invalid/custom", responsesPath: "/api/v1/responses" }).url, "https://gateway.invalid/api/v1/responses");
  for (const options of [{ region: "gateway" }, { baseUrl: "https://secret@host.invalid/v1" }, { baseUrl: "http://host.invalid/v1" },
    { responsesPath: "//other.invalid/responses" }, { responsesPath: "/../responses" }, { responsesPath: "/responses?key=secret" }]) {
    assert.throws(() => resolveGLMEndpoint(options), { code: "configuration" });
  }
});

test("native success is a single request, high effort and session identity preserved", async () => {
  const sent = [];
  const bridge = createGLMToolPassthrough({ transport: createGLMTransport({ apiKey: "test-only-key", fetchImpl: async (url, init) => {
    sent.push({ url, init }); return json(result);
  } }) });
  assert.equal((await bridge.runTurn({ request: { input: "test" }, sessionId: "session-one" })).id, result.id);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, "https://open.bigmodel.cn/api/v1/responses");
  const request = JSON.parse(sent[0].init.body);
  assert.equal(request.model, "glm-5.3"); assert.equal(request.reasoning.effort, "high");
  assert.equal(new Headers(sent[0].init.headers).get("session_id"), "session-one");
  assert.equal(sent[0].init.redirect, "error");
});

test("explicit unsupported endpoint falls back once, retaining last user task and session", async () => {
  const sent = [], routes = [];
  const transport = createGLMTransport({ onProtocol: event => routes.push(event), fetchImpl: async (url, init) => {
    sent.push({ url, init }); return sent.length === 1 ? json({ error: { code: "route_not_found", message: "No Responses endpoint" } }, 404) : json(chat);
  } });
  const response = await transport.complete({ ...input, request: { ...input.request, instructions: "system contract", input: [
    { role: "developer", content: "Task from parent: inspect fixture" }, { role: "user", content: "Do the inspection, not a greeting" },
  ] } });
  assert.equal(sent.length, 2); assert.match(sent[1].url, /\/api\/paas\/v4\/chat\/completions$/);
  assert.equal(new Headers(sent[1].init.headers).get("session_id"), "session-one");
  const forwarded = JSON.parse(sent[1].init.body);
  assert.deepEqual(forwarded.messages.map(message => message.content), ["system contract", "Task from parent: inspect fixture", "Do the inspection, not a greeting"]);
  assert.equal(forwarded.reasoning_effort, "high"); assert.equal(forwarded.thinking.clear_thinking, false);
  assert.equal(response.output.find(item => item.type === "message").content[0].text, "done");
  assert.equal(response.usage.input_tokens, 12);
  assert.deepEqual(routes, [{ protocol: "responses", reason: "preferred" }, { protocol: "chat", reason: "responses_unsupported" }]);
});

test("business denials, unsupported model and transient faults never downgrade", async () => {
  for (const [status, code] of [[400, "invalid_request"], [401, "invalid_api_key"], [403, "permission_denied"], [404, "model_not_found"],
    [429, "rate_limit_exceeded"], [429, "cyber_policy"], [500, "server_error"], [503, "overloaded"]]) {
    let calls = 0;
    const transport = createGLMTransport({ fetchImpl: async () => { calls++; return json({ error: { code, message: code } }, status); } });
    await assert.rejects(transport.complete(input), error => error.details.status === status && error.details.code === code);
    assert.equal(calls, 1, code);
    await assert.rejects(collect(transport.stream(input)), error => error.details.status === status);
    assert.equal(calls, 2, `${code} streaming`);
  }
});

test("explicit Responses-only mode and nonportable history never fall back", async () => {
  for (const request of [input.request, { ...input.request, previous_response_id: "resp_foreign" },
    { ...input.request, tools: [{ type: "web_search" }] }, { ...input.request, store: true }]) {
    let calls = 0;
    const transport = createGLMTransport({ ...(request === input.request ? { upstreamProtocol: "responses" } : {}),
      fetchImpl: async () => { calls++; return json({ error: { code: "unsupported_endpoint", message: "Responses unavailable" } }, 404); } });
    await assert.rejects(transport.complete({ ...input, request }), error => error.details.status === 404);
    assert.equal(calls, 1);
  }
});

test("ambiguous 404 and conflicting policy classification are not protocol absence", async () => {
  for (const body of [{}, { message: "unknown failure" }, { error: { code: "endpoint_not_found", type: "policy_error" } },
    { error: { code: "endpoint_not_found", param: "model" } }]) {
    let calls = 0;
    const transport = createGLMTransport({ fetchImpl: async () => { calls++; return json(body, 404); } });
    await assert.rejects(transport.complete(input), error => error.details.status === 404);
    assert.equal(calls, 1);
  }
});

test("one total deadline also rejects a late custom fetch that ignores abort", async () => {
  let calls = 0;
  const transport = createGLMTransport({ timeoutMs: 5, fetchImpl: async () => {
    calls++; await new Promise(resolve => setTimeout(resolve, 20)); return json(result);
  } });
  await assert.rejects(transport.complete(input), error => error.code === "timeout" && error.details.status === 504);
  assert.equal(calls, 1);
});

test("Chat error is returned without another attempt or retry delay", async () => {
  let calls = 0;
  const transport = createGLMTransport({ fetchImpl: async () => {
    calls++; return calls === 1 ? json({ error: { code: "unsupported_protocol" } }, 400)
      : json({ error: { code: "cyber_policy", message: "Risk rejected" } }, 400);
  } });
  await assert.rejects(transport.complete(input), error => error.details.code === "cyber_policy" && error.details.status === 400);
  assert.equal(calls, 2);
});

test("native SSE remains native and early EOF never retries Chat", async () => {
  let calls = 0;
  const transport = createGLMTransport({ fetchImpl: async () => {
    calls++; return new Response(responseSse("responses", result), { headers: { "content-type": "text/event-stream" } });
  } });
  const frames = await collect(transport.stream(input));
  assert.equal(frames.at(-1).value.type, "response.completed"); assert.equal(calls, 1);
  const bridge = createGLMToolPassthrough({ transport: createGLMTransport({ fetchImpl: async () => {
    calls++; return new Response('data: {"type":"response.created","response":{"id":"resp_partial"}}\n\n', { headers: { "content-type": "text/event-stream" } });
  } }) });
  await assert.rejects(collect(bridge.streamTurn({ request: input.request })), { code: "upstream_stream_incomplete" });
  assert.equal(calls, 2);
});

test("stream fallback enables tool_stream and returns Responses, including JSON-only Chat upstream", async () => {
  const sent = [];
  const bridge = createGLMToolPassthrough({ transport: createGLMTransport({ fetchImpl: async (url, init) => {
    sent.push({ url, body: JSON.parse(init.body), headers: new Headers(init.headers) });
    return sent.length === 1 ? json({ error: { code: "endpoint_not_found" } }, 404) : json(chat);
  } }) });
  const frames = await collect(bridge.streamTurn({ sessionId: "stream-session", request: { ...input.request,
    tools: [{ type: "function", name: "read", parameters: { type: "object", properties: {} } }] } }));
  assert.equal(sent.length, 2); assert.equal(sent[1].body.stream, true); assert.equal(sent[1].body.tool_stream, true);
  assert.equal(sent[1].headers.get("session_id"), "stream-session");
  assert.equal(frames.at(-1).value.type, "response.completed");
});

test("client cancellation sends no upstream request when already aborted", async () => {
  let calls = 0;
  const transport = createGLMTransport({ fetchImpl: async () => { calls++; return json(result); } });
  await assert.rejects(transport.complete(input, AbortSignal.abort()), { code: "cancelled" });
  await assert.rejects(collect(transport.stream(input, AbortSignal.abort())), { code: "cancelled" });
  assert.equal(calls, 0);
});

test("HTTP relay exposes Responses, preserves header identity and rejects client Chat", async () => {
  const sent = [];
  const relay = createGLMCodexRelay({ upstream: { region: "gateway", baseUrl: "https://fixture.invalid/v1", fetchImpl: async (url, init) => {
    sent.push({ url, init }); return json(result);
  } } });
  const { host, port } = await relay.listen();
  try {
    const response = await fetch(`http://${host}:${port}/v1/responses`, { method: "POST", headers: { "content-type": "application/json", "X-Codex-Thread-Id": "thread-two" }, body: JSON.stringify({ input: "test" }) });
    assert.equal(response.status, 200); assert.equal((await response.json()).id, result.id);
    assert.equal(new Headers(sent[0].init.headers).get("session_id"), "thread-two");
    const rejected = await fetch(`http://${host}:${port}/v1/chat/completions`, { method: "POST", body: JSON.stringify({ messages: [] }) });
    assert.equal(rejected.status, 400); assert.equal(sent.length, 1);
  } finally { await relay.close(); }
});
