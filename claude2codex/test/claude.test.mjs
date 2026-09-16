import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createClaudeCodexRelay } from "../src/integration.mjs";
import { CLAUDE_DEFAULT_MODEL, createClaudeToolPassthrough, isClaudeModel, prepareClaudeRequest } from "../src/index.mjs";
import { readSseFrames } from "../../src/sse.mjs";

const frame = value => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;
const envelope = (output, status = "completed", extra = {}) => ({ id: "resp_claude_fixture", object: "response", model: CLAUDE_DEFAULT_MODEL, created_at: 1, status, output, ...extra });
const message = text => ({ id: "msg_claude_fixture", type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tools = [{ type: "namespace", name: "functions", tools: [
  { type: "custom", name: "apply_patch", description: "Apply an approved patch in the host", format: { type: "grammar", syntax: "lark", definition: "start: SOURCE" } },
  { type: "function", name: "read_file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
] }];

async function withRelay(handler, run) {
  const requests = [];
  const notifications = [];
  const upstream = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks));
      requests.push({ body, headers: req.headers, path: req.url });
      await handler(body, res, requests.length);
    } catch (error) { res.destroy(error); }
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const relay = createClaudeCodexRelay({ upstream: {
    baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiKey: "synthetic-credential",
    headers: { "X-AIO-Credential-Group": "synthetic-pool" },
  }, onResponse: event => notifications.push(event) });
  const { port } = await relay.listen();
  const post = (body, signal = AbortSignal.timeout(5000)) => fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ stream: true, ...body }), signal,
  });
  try { await run(post, requests, notifications, relay); } finally {
    relay.server.server.closeAllConnections();
    upstream.closeAllConnections();
    await relay.close();
    await new Promise(resolve => upstream.close(resolve));
  }
}

test("Claude streams before completion and returns parallel tools to the same client for continuation", { timeout: 7000 }, async () => {
  const finish = deferred();
  const patch = "*** Begin Patch\n*** Add File: fixture.txt\n+你好\n*** End Patch";
  const reasoning = { type: "reasoning", id: "rs_fixture", encrypted_content: "opaque-provider-signature-fixture", summary: [{ type: "summary_text", text: "Inspect then update" }] };
  const input = [{ role: "user", content: [{ type: "input_text", text: "Apply an approved change" }] }];
  let generated = false;
  let upstreamToolCalls;
  await withRelay(async (body, res, turn) => {
    assert.equal(body.model, CLAUDE_DEFAULT_MODEL);
    assert.equal(body.stream, true);
    assert.deepEqual(body.include, ["message.output_text.logprobs", "reasoning.encrypted_content"]);
    assert.ok(body.tools.every(tool => tool.type === "function"));
    assert.ok(body.tools.every(tool => /^[A-Za-z0-9_-]{1,64}$/.test(tool.name)));
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (turn === 1) {
      const custom = { type: "function_call", id: "fc_custom", call_id: "call_custom", name: body.tools[0].name, arguments: JSON.stringify({ input: patch }), status: "completed" };
      const normal = { type: "function_call", id: "fc_read", call_id: "call_read", name: body.tools[1].name, arguments: '{"path":"fixture.txt"}', status: "completed" };
      upstreamToolCalls = [custom, normal];
      let sequence = 0;
      const emit = value => res.write(frame({ ...value, sequence_number: sequence++ }));
      emit({ type: "response.created", response: envelope([], "in_progress") });
      emit({ type: "response.reasoning_summary_text.delta", item_id: reasoning.id, output_index: 0, summary_index: 0, delta: "Inspect then update" });
      await finish.promise;
      generated = true;
      emit({ type: "response.output_item.done", item: reasoning, output_index: 0 });
      for (const [index, item] of upstreamToolCalls.entries()) {
        const output_index = index + 1;
        emit({ type: "response.output_item.added", output_index, item: { ...item, arguments: "", status: "in_progress" } });
        emit({ type: "response.function_call_arguments.delta", item_id: item.id, output_index, delta: item.arguments });
        emit({ type: "response.function_call_arguments.done", item_id: item.id, output_index, arguments: item.arguments });
        emit({ type: "response.output_item.done", output_index, item });
      }
      emit({ type: "response.completed", response: envelope([reasoning, ...upstreamToolCalls]) });
    } else {
      assert.deepEqual(body.input.slice(0, 1), input);
      assert.deepEqual(body.input[1], reasoning, "never rewrite a Claude thinking signature");
      assert.deepEqual(body.input.slice(2, 4), upstreamToolCalls);
      assert.deepEqual(body.input.slice(4).map(item => [item.type, item.call_id, item.output]), [
        ["function_call_output", "call_custom", "approved patch applied"],
        ["function_call_output", "call_read", "你好"],
      ]);
      res.write(frame({ type: "response.completed", sequence_number: 0, response: envelope([message("Completed using the client tool results")]) }));
    }
    res.end();
  }, async (post, requests, notifications) => {
    try {
      const request = { input, tools, include: ["message.output_text.logprobs"] };
      const before = structuredClone(request);
      const first = [];
      for await (const event of readSseFrames((await post(request)).body)) {
        first.push(event.value);
        if (event.value.type === "response.reasoning_summary_text.delta") {
          assert.equal(generated, false, "client receives progress before the upstream finishes");
          finish.resolve();
        }
      }
      assert.deepEqual(request, before);
      const output = first.at(-1).response.output;
      assert.equal(output[1].type, "custom_tool_call");
      assert.equal(output[1].name, "apply_patch");
      assert.equal(output[1].namespace, "functions");
      assert.equal(output[1].input, patch);
      assert.equal(output[2].name, "read_file");
      assert.equal(output[2].arguments, '{"path":"fixture.txt"}');
      const second = [];
      for await (const event of readSseFrames((await post({ ...request, input: [...input, ...output,
        { type: "custom_tool_call_output", call_id: "call_custom", output: "approved patch applied" },
        { type: "function_call_output", call_id: "call_read", output: "你好" },
      ] })).body)) second.push(event.value);
      assert.equal(second.at(-1).response.output[0].content[0].text, "Completed using the client tool results");
      assert.equal(requests.length, 2, "only the client initiates a continuation");
      for (const upstream of requests) {
        assert.equal(upstream.path, "/v1/responses");
        assert.equal(upstream.headers["x-aio-credential-group"], "synthetic-pool");
        assert.equal(upstream.headers.authorization, "Bearer synthetic-credential");
      }
      assert.equal(notifications[0].calls.length, 2);
      assert.equal(notifications[1].calls.length, 0);
    } finally { finish.resolve(); }
  });
});

test("explicit Claude catalog selection and nonstreaming remain intact", async () => {
  await withRelay(async (body, res) => {
    assert.equal(body.model, "claude-sonnet-4-6");
    assert.equal(body.stream, false);
    assert.deepEqual(body.reasoning, { effort: "high" });
    assert.deepEqual(body.tools, []);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(envelope([message("Sonnet reply")], "completed", { model: body.model })));
  }, async post => {
    const response = await post({ model: "claude-sonnet-4-6", stream: false, input: "fixture", reasoning: { effort: "high" } });
    assert.match(response.headers.get("content-type"), /application\/json/);
    assert.equal((await response.json()).model, "claude-sonnet-4-6");
  });
});

test("non-Claude requests fail before dispatch and do not select another card", async () => {
  await withRelay(() => assert.fail("must not dispatch"), async (post, requests) => {
    for (const model of ["gemini-3.1-pro", "grok-4.6", "gpt-5.6-sol", ""]) {
      const response = await post({ model, input: "fixture" });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error.code, "invalid_request");
    }
    assert.equal(requests.length, 0);
  });
});

for (const [status, type] of [[400, "invalid_request_error"], [429, "rate_limit_error"], [529, "overloaded_error"]]) {
  test(`Claude HTTP ${status} keeps its status/type/retry metadata without replay`, async () => {
    await withRelay(async (body, res) => {
      res.writeHead(status, { "content-type": "application/json", "retry-after": "12" });
      res.end(JSON.stringify({ type: "error", error: { type, message: "synthetic Claude rejection" }, request_id: "req_fixture" }));
    }, async (post, requests) => {
      const response = await post({ input: "fixture" });
      assert.equal(response.status, status);
      assert.equal(response.headers.get("retry-after"), "12");
      assert.equal((await response.json()).error.type, type);
      assert.equal(requests.length, 1);
    });
  });
}

test("Anthropic-shaped SSE overload remains verbatim and receives a failed terminal", async () => {
  const original = 'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},"request_id":"req_fixture"}\n\n';
  await withRelay(async (body, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(original);
  }, async (post, requests) => {
    const text = await (await post({ input: "fixture" })).text();
    assert.ok(text.startsWith(original));
    assert.match(text, /event: response.failed/);
    assert.match(text, /"code":"server_is_overloaded"/);
    assert.match(text, /"type":"overloaded_error"/);
    assert.doesNotMatch(text, /response.completed|upstream_stream_incomplete/);
    assert.equal(requests.length, 1);
    if (process.env.GROK2CODEX_CLAUDE_FIXTURE_DIR) {
      mkdirSync(process.env.GROK2CODEX_CLAUDE_FIXTURE_DIR, { recursive: true });
      writeFileSync(join(process.env.GROK2CODEX_CLAUDE_FIXTURE_DIR, "claude-overload.sse"), text);
    }
  });
});

test("client cancellation closes a Claude upstream request", { timeout: 7000 }, async () => {
  const closed = deferred();
  await withRelay(async (body, res) => {
    res.once("close", closed.resolve);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(frame({ type: "response.reasoning_summary_text.delta", sequence_number: 0, delta: "progress" }));
  }, async post => {
    const controller = new AbortController();
    const response = await post({ input: "fixture" }, controller.signal);
    await response.body.getReader().read();
    controller.abort();
    await closed.promise;
  });
});

test("opaque reasoning history, images and supplied controls survive request preparation without mutation", async () => {
  const original = { model: "claude-opus-4-6-thinking", input: [
    { type: "reasoning", encrypted_content: "opaque-signature", summary: [], provider_metadata: { key: "keep" } },
    { role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,fixture", detail: "auto" }] },
  ], include: ["reasoning.encrypted_content"], reasoning: { effort: "high" }, parallel_tool_calls: false, max_output_tokens: 8192, store: false };
  const before = structuredClone(original);
  assert.deepEqual(prepareClaudeRequest(original), original);
  assert.deepEqual(original, before);
  assert.equal(isClaudeModel(" Claude-Opus-4-6-thinking "), true);
  assert.equal(isClaudeModel("not-claude"), false);
  assert.throws(() => prepareClaudeRequest({ include: "invalid" }), error => error.code === "invalid_request");
  const bridge = createClaudeToolPassthrough({ transport: { complete: async () => assert.fail("must not dispatch") } });
  assert.equal(bridge.streamTurn, undefined, "complete-only custom transports remain compatible");
  await assert.rejects(bridge.runTurn({ protocol: "chat", request: {} }), error => error.code === "protocol");
});
