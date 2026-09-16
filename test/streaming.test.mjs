import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createOpenAITransport, createClientToolPassthrough, createBridgeServer } from "../src/index.mjs";
import { readSseFrames } from "../src/sse.mjs";

const frame = value => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;
const envelope = (model, output = [], status = "in_progress") => ({ id: "resp_fixture", object: "response", created_at: 1, model, status, output, error: null });
const message = text => ({ id: "msg_fixture", type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tools = [{ type: "namespace", name: "functions", tools: [
  { type: "custom", name: "exec", format: { type: "grammar", syntax: "lark", definition: "start: SOURCE" } },
  { type: "function", name: "read", parameters: { type: "object" } },
] }];

async function withRelay(handler, run, transportOptions = {}) {
  const requests = [];
  const notifications = [];
  const upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    requests.push({ body, accept: req.headers.accept });
    try { await handler(body, res, req); } catch (error) { res.destroy(error); }
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const transport = createOpenAITransport({ baseUrl: `http://127.0.0.1:${upstream.address().port}`, ...transportOptions });
  const bridge = createClientToolPassthrough({ transport, onResponse: e => notifications.push(e) });
  const relay = createBridgeServer({ bridge });
  const { port } = await relay.listen();
  const post = (body = {}, signal = AbortSignal.timeout(5000)) => fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "grok-4.6", stream: true, ...body }), signal,
  });
  try { await run(post, requests, notifications); } finally {
    relay.server.closeAllConnections();
    upstream.closeAllConnections();
    await relay.close();
    await new Promise(resolve => upstream.close(resolve));
  }
}

for (const model of ["grok-4.6", "gemini-3.1-pro"]) {
  test(`${model}: client receives the first delta while upstream completion is gated`, { timeout: 7000 }, async () => {
    const finish = deferred();
    let upstreamFinished = false;
    await withRelay(async (body, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(frame({ type: "response.created", sequence_number: 0, response: envelope(body.model) }));
      // Real UTF-8 bytes and CRLF split at every byte, including inside a glyph.
      const raw = frame({ type: "response.output_text.delta", sequence_number: 1, item_id: "msg_fixture", output_index: 0, content_index: 0, delta: "你好🌍" }).replaceAll("\n", "\r\n");
      for (const byte of Buffer.from(raw)) res.write(Buffer.of(byte));
      await finish.promise;
      upstreamFinished = true;
      res.end(frame({ type: "response.completed", sequence_number: 2, response: envelope(body.model, [message("你好🌍")], "completed") }));
    }, async (post, requests) => {
      try {
        const response = await post({ model });
        assert.equal(response.status, 200);
        const events = [];
        for await (const chunk of readSseFrames(response.body)) {
          events.push(chunk.value);
          if (chunk.value.type === "response.output_text.delta") {
            assert.equal(upstreamFinished, false, "first text must not wait for complete response");
            assert.equal(chunk.value.delta, "你好🌍");
            finish.resolve();
          }
        }
        assert.equal(events.at(-1).type, "response.completed");
        assert.equal(requests.length, 1);
        assert.equal(requests[0].body.stream, true);
        assert.equal(requests[0].accept, "text/event-stream");
      } finally { finish.resolve(); }
    });
  });
}

test("interleaved custom/function calls retain identity; only completed response releases tool done events", async () => {
  const finish = deferred();
  const rawInput = 'text("你好");\ntext(await tools.read({path:"a"}));';
  await withRelay(async (body, res) => {
    const custom = { id: "custom", type: "function_call", call_id: "custom_call", name: body.tools[0].name, arguments: "", status: "in_progress" };
    const normal = { id: "normal", type: "function_call", call_id: "normal_call", name: body.tools[1].name, arguments: "", status: "in_progress" };
    const args = JSON.stringify({ input: rawInput });
    let seq = 0;
    const emit = e => res.write(frame({ ...e, sequence_number: seq++ }));
    res.writeHead(200, { "content-type": "text/event-stream" });
    emit({ type: "response.created", response: envelope(body.model) });
    for (const [index, item] of [custom, normal].entries()) emit({ type: "response.output_item.added", output_index: index, item });
    emit({ type: "response.function_call_arguments.delta", item_id: "custom", output_index: 0, delta: args.slice(0, 10) });
    emit({ type: "response.function_call_arguments.delta", item_id: "normal", output_index: 1, delta: '{"path":' });
    emit({ type: "response.function_call_arguments.delta", item_id: "custom", output_index: 0, delta: args.slice(10) });
    emit({ type: "response.function_call_arguments.delta", item_id: "normal", output_index: 1, delta: '"a"}' });
    custom.arguments = args; normal.arguments = '{"path":"a"}';
    for (const [index, item] of [custom, normal].entries()) {
      emit({ type: "response.function_call_arguments.done", item_id: item.id, output_index: index, name: item.name, arguments: item.arguments });
      emit({ type: "response.output_item.done", output_index: index, item: { ...item, status: "completed" } });
    }
    emit({ type: "response.reasoning_summary_text.delta", item_id: "thinking", output_index: 2, summary_index: 0, delta: "still thinking" });
    await finish.promise;
    emit({ type: "response.completed", response: envelope(body.model, [custom, normal].map(i => ({ ...i, status: "completed" })), "completed") });
    res.end();
  }, async (post, requests, notifications) => {
    const events = [];
    try {
      for await (const f of readSseFrames((await post({ tools })).body)) {
        events.push(f.value);
        if (f.value.type === "response.reasoning_summary_text.delta") {
          assert.ok(!events.some(e => e.type.endsWith(".done")), "no premature executable calls");
          finish.resolve();
        }
      }
      const output = events.at(-1).response.output;
      assert.deepEqual(output.map(i => [i.type, i.name, i.namespace, i.call_id]), [
        ["custom_tool_call", "exec", "functions", "custom_call"], ["function_call", "read", "functions", "normal_call"],
      ]);
      assert.equal(output[0].input, rawInput);
      assert.equal(output[1].arguments, '{"path":"a"}');
      assert.equal(events.filter(e => e.type === "response.custom_tool_call_input.delta").map(e => e.delta).join(""), rawInput);
      assert.equal(events.filter(e => e.type === "response.function_call_arguments.delta").map(e => e.delta).join(""), '{"path":"a"}');
      assert.ok(events.every((e, i) => !i || e.sequence_number > events[i - 1].sequence_number));
      assert.equal(requests.length, 1);
      assert.equal(notifications[0].calls.length, 2);
    } finally { finish.resolve(); }
  });
});

for (const terminal of ["failed", "incomplete"]) {
  test(`${terminal} discards pending custom completion but preserves terminal metadata`, async () => {
    await withRelay(async (body, res) => {
      const item = { id: "tool", type: "function_call", call_id: "call", name: body.tools[0].name, arguments: '{"input":"do not run"}' };
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(frame({ type: "response.output_item.added", sequence_number: 0, output_index: 0, item: { ...item, arguments: "" } }));
      res.write(frame({ type: "response.function_call_arguments.done", sequence_number: 1, item_id: "tool", output_index: 0, arguments: item.arguments }));
      res.write(frame({ type: "response.output_item.done", sequence_number: 2, output_index: 0, item }));
      res.end(frame({ type: `response.${terminal}`, sequence_number: 3, response: { ...envelope(body.model, [item], terminal),
        ...(terminal === "failed" ? { error: { code: "server_is_overloaded", message: "capacity" } } : { incomplete_details: { reason: "max_output_tokens" } }) } }));
    }, async (post, requests, notifications) => {
      const events = [];
      for await (const f of readSseFrames((await post({ tools })).body)) events.push(f.value);
      assert.equal(events.at(-1).type, `response.${terminal}`);
      assert.ok(!events.some(e => e.type.endsWith(".done") || e.type === "response.completed"));
      assert.deepEqual(notifications, [{ status: terminal, calls: [] }]);
    });
  });
}

for (const compatible of [false, true]) {
  test(`provider overload is preserved verbatim, one failed terminal (upstream terminal=${compatible})`, async () => {
    const original = 'id: error-id\r\nevent: error\r\ndata: {"type":"error","sequence_number":1,"vendor_id":9007199254740993123,"error":{"type":"server_error","code":"server_is_overloaded","message":"capacity request trace-fixture","param":null,"extra":{"n":9007199254740993123}}}\r\n\r\n';
    await withRelay(async (body, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(frame({ type: "response.created", sequence_number: 0, response: envelope(body.model) }));
      res.write(original);
      if (compatible) res.write(frame({ type: "response.failed", sequence_number: 2, response: { ...envelope(body.model, [], "failed"), error: { code: "server_is_overloaded", message: "capacity request trace-fixture" } } }));
      res.end();
    }, async (post) => {
      const text = await (await post()).text();
      assert.ok(text.includes(original));
      assert.equal((text.match(/event: response.failed/g) ?? []).length, 1);
      assert.ok(!text.includes("response.completed"));
      if (!compatible) assert.equal((text.match(/9007199254740993123/g) ?? []).length, 3);
      if (process.env.GROK2CODEX_SSE_FIXTURE_DIR) {
        mkdirSync(process.env.GROK2CODEX_SSE_FIXTURE_DIR, { recursive: true });
        writeFileSync(join(process.env.GROK2CODEX_SSE_FIXTURE_DIR, `bridge-overload-${compatible}.sse`), text);
      }
    });
  });
}

test("early EOF after visible text becomes explicit stream failure, never completion or replay", async () => {
  await withRelay(async (body, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(frame({ type: "response.output_text.delta", sequence_number: 0, delta: "partial" }));
  }, async (post, requests) => {
    const response = await post();
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.match(text, /upstream_stream_incomplete/);
    assert.match(text, /response.failed/);
    assert.doesNotMatch(text, /response.completed/);
    assert.equal(requests.length, 1);
  });
});

test("downstream cancellation closes its upstream stream", { timeout: 7000 }, async () => {
  const closed = deferred();
  await withRelay(async (body, res) => {
    res.once("close", closed.resolve);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(frame({ type: "response.output_text.delta", sequence_number: 0, delta: "started" }));
  }, async post => {
    const controller = new AbortController();
    const response = await post({}, controller.signal);
    const reader = response.body.getReader();
    assert.equal((await reader.read()).done, false);
    controller.abort();
    await closed.promise;
  });
});

test("stream timeout is reported after initial chunks; no second HTTP response is attempted", { timeout: 7000 }, async () => {
  await withRelay(async (body, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(frame({ type: "response.output_text.delta", sequence_number: 0, delta: "started" }));
  }, async post => {
    const response = await post();
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /"code":"timeout"/);
    assert.equal((body.match(/event: response.failed/g) ?? []).length, 1);
  }, { timeoutMs: 100 });
});

test("an explicit non-streaming caller remains non-streaming", async () => {
  await withRelay(async (body, res) => {
    assert.equal(body.stream, false);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(envelope(body.model, [message("whole")], "completed")));
  }, async (post, requests) => {
    const response = await post({ stream: false });
    assert.match(response.headers.get("content-type"), /application\/json/);
    assert.equal((await response.json()).output[0].content[0].text, "whole");
    assert.equal(requests.length, 1);
  });
});

for (const terminal of ["failed", "incomplete"]) {
  for (const advertised of [true, false]) {
    test(`${terminal} preserves provider reason despite malformed tool arguments (advertised=${advertised})`, async () => {
      await withRelay(async (body, res) => {
        const item = { id: "tool", type: "function_call", call_id: "call", name: advertised ? body.tools[0].name : "unfinished_name", arguments: '{"input":' };
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(frame({ type: "response.created", sequence_number: 0, response: envelope(body.model) }));
        res.write(frame({ type: "response.output_item.added", sequence_number: 1, output_index: 0, item: { ...item, arguments: "" } }));
        res.write(frame({ type: "response.function_call_arguments.done", sequence_number: 2, item_id: "tool", output_index: 0, arguments: item.arguments }));
        res.write(frame({ type: "response.output_item.done", sequence_number: 3, output_index: 0, item }));
        res.end(frame({ type: `response.${terminal}`, sequence_number: 4, response: { ...envelope(body.model, [item], terminal),
          ...(terminal === "failed" ? { error: { code: "server_is_overloaded", message: "capacity" } } : { incomplete_details: { reason: "max_output_tokens" } }) } }));
      }, async post => {
        const events = [];
        for await (const f of readSseFrames((await post({ tools })).body)) events.push(f.value);
        assert.equal(events.at(-1).type, `response.${terminal}`);
        assert.ok(!events.some(e => e.type.endsWith(".done") || e.type === "response.completed"));
        assert.equal(terminal === "failed" ? events.at(-1).response.error.code : events.at(-1).response.incomplete_details.reason,
          terminal === "failed" ? "server_is_overloaded" : "max_output_tokens");
      });
    });
  }
}

test("a successful terminal cannot release a tool with conflicting earlier arguments", async () => {
  await withRelay(async (body, res) => {
    const item = { id: "tool", type: "function_call", call_id: "call", name: body.tools[0].name, arguments: '{"input":"original"}' };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(frame({ type: "response.output_item.added", sequence_number: 0, output_index: 0, item: { ...item, arguments: "" } }));
    res.write(frame({ type: "response.function_call_arguments.done", sequence_number: 1, item_id: "tool", output_index: 0, arguments: item.arguments }));
    res.end(frame({ type: "response.completed", sequence_number: 2, response: envelope(body.model, [{ ...item, arguments: '{"input":"different"}', status: "completed" }], "completed") }));
  }, async post => {
    const text = await (await post({ tools })).text();
    assert.match(text, /invalid_tool_call/);
    assert.match(text, /response.failed/);
    assert.doesNotMatch(text, /event: response\.completed|event: response\.custom_tool_call_input\.done/);
  });
});

test("bare SSE error object retains its provider code and request ID", async () => {
  const raw = 'data: {"error":{"type":"server_error","code":"server_error","message":"trace: synthetic-request-id","param":null}}\n\n';
  await withRelay(async (body, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(raw);
  }, async post => {
    const text = await (await post()).text();
    assert.ok(text.startsWith(raw));
    assert.match(text, /response.failed/);
    assert.doesNotMatch(text, /upstream_stream_incomplete|response.completed/);
    assert.equal((text.match(/synthetic-request-id/g) ?? []).length, 2);
  });
});

test("native image events, keepalives, and unknown provider metadata survive streaming", async () => {
  const progress = 'event: response.image_generation_call.partial_image\ndata: {"type":"response.image_generation_call.partial_image","sequence_number":1,"partial_image_b64":"fixture","vendor_id":9007199254740993123}\n\n';
  const keepalive = ': upstream keepalive\n\n';
  await withRelay(async (body, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(frame({ type: "response.created", sequence_number: 0, response: envelope(body.model) }));
    res.write(keepalive);
    res.write(progress);
    res.end(frame({ type: "response.completed", sequence_number: 2, response: envelope(body.model, [{ type: "image_generation_call", id: "image", status: "completed", result: "fixture" }], "completed") }));
  }, async post => {
    const text = await (await post({ tools: [{ type: "image_generation" }] })).text();
    assert.ok(text.includes(keepalive));
    assert.ok(text.includes(progress));
    assert.match(text, /response.completed/);
  });
});

test("SSE framing accepts mixed line endings, multiline JSON, and byte-split Unicode", async () => {
  const raw = 'id: fixture\r\nevent: response.output_text.delta\ndata: {"type":"response.output_text.delta",\rdata: "delta":"你好🌍"}\r\n\n';
  const bytes = Buffer.from(raw);
  let cursor = 0;
  const body = new ReadableStream({ pull(controller) {
    if (cursor === bytes.length) controller.close();
    else controller.enqueue(bytes.subarray(cursor, ++cursor));
  } });
  const result = [];
  for await (const f of readSseFrames(body)) result.push(f);
  assert.equal(result.length, 1);
  assert.equal(result[0].raw, raw);
  assert.equal(result[0].value.delta, "你好🌍");
});

test("oversized or truncated SSE frames fail explicitly", async () => {
  for (const [raw, limit, code] of [['data: {"large":"abcdef"}\n\n', 10, "upstream_invalid_response"],
    ['data: {"type":"error"}', 100, "upstream_stream_incomplete"]]) {
    await assert.rejects(async () => {
      for await (const f of readSseFrames(new Response(raw).body, limit)) void f;
    }, error => error.code === code);
  }
});
