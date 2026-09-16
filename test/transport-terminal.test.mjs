import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createOpenAITransport } from "../src/http.mjs";
import { createBridgeServer } from "../src/server.mjs";
import { createClientToolPassthrough } from "../src/passthrough.mjs";
import { safeErrorMessage, safeRetryAfter, upstreamHttpError, relayHttpError } from "../src/http-errors.mjs";

const message = text => ({ id: "msg_fixture", type: "message", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] });
const responseBody = (output, extra = {}) => ({ id: "resp_fixture", object: "response", model: "fixture", status: "completed", output, ...extra });
const parseSse = text => text.split(/\r?\n\r?\n/).filter(Boolean).map(frame => JSON.parse(frame.split(/\r?\n/).find(line => line.startsWith("data: ")).slice(6)));

async function withRelay(bridge, run) {
  const server = createBridgeServer({ bridge });
  const { host, port } = await server.listen();
  try { await run(`http://${host}:${port}/v1/responses`); } finally { await server.close(); }
}

async function post(url, body = { stream: true }) {
  return fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(3000) });
}

for (const [status, retryAfter] of [[400, undefined], [401, undefined], [429, "61"], [503, "Wed, 16 Sep 2026 08:00:00 GMT"]]) {
  test(`actual HTTP ${status} retains public details and Retry-After without replay`, async () => {
    let calls = 0;
    const secret = "fixture-private-value-not-a-real-key";
    const upstream = createServer(async (req, res) => {
      calls++;
      for await (const _ of req) { /* consume only synthetic body */ }
      res.writeHead(status, { "content-type": "application/json", ...(retryAfter ? { "retry-after": retryAfter } : {}) });
      res.end(JSON.stringify({ error: { code: "invalid_schema", type: "invalid_request_error", param: "tools[0].parameters", message: `Invalid schema at tools[0].parameters\nBearer abcdefghijklmnop api_key=${secret}`, private: secret }, debug: secret }));
    });
    await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
    const transport = createOpenAITransport({ baseUrl: `http://127.0.0.1:${upstream.address().port}`, apiKey: secret });
    try {
      await withRelay(createClientToolPassthrough({ transport }), async url => {
        const response = await post(url, { stream: true, input: "fixture", tools: [] });
        assert.equal(response.status, status);
        assert.equal(response.headers.get("retry-after"), retryAfter ?? null);
        const body = await response.json();
        assert.equal(body.error.code, "invalid_schema");
        assert.equal(body.error.param, "tools[0].parameters");
        assert.match(body.error.message, /Invalid schema at tools\[0\].parameters/);
        assert.doesNotMatch(JSON.stringify(body), new RegExp(secret + "|abcdefghijklmnop|private|debug|\\\\n"));
        assert.equal(calls, 1);
      });
    } finally { await new Promise(resolve => upstream.close(resolve)); }
  });
}

test("shared error helpers redact credentials, bound text, and reject unsafe metadata", () => {
  const text = safeErrorMessage('bad\u0000 schema: Bearer secret-bearer api_key=secret-key access_token="secret-token" sk-abcdefghijklmnopqrst https://user:pass@example.test/?token=opaque\n' + "x".repeat(2000));
  assert.ok(text.length <= 1024);
  assert.doesNotMatch(text, /secret-bearer|secret-key|secret-token|sk-abcdefghijklmnopqrst|user:pass|opaque|[\u0000-\u001f]/);
  assert.equal(safeRetryAfter("60\r\nX-Test: bad"), undefined);
  assert.equal(safeRetryAfter("-1"), undefined);
  const details = upstreamHttpError({ status: 400, headers: { get: () => "bad" } }, { error: { code: "bad\ncode", param: "tools\r\nX:secret" } });
  assert.equal(details.code, "upstream_error");
  assert.equal(details.param, undefined);
  assert.equal(details.retryAfter, undefined);
  assert.equal(relayHttpError({ code: "upstream", details: { status: 200 } }).status, 502);
});

for (const [status, raw, code] of [[400, "<html>synthetic error</html>", "upstream_error"], [200, "not JSON", "upstream_invalid_response"], [200, "", "upstream_invalid_response"]]) {
  test(`non-JSON/empty HTTP ${status} response is never successful SSE (${raw.length})`, async () => {
    const transport = createOpenAITransport({ baseUrl: "https://fixture.invalid", fetchImpl: async () => new Response(raw, { status }) });
    await withRelay(createClientToolPassthrough({ transport }), async url => {
      const response = await post(url);
      assert.equal(response.status, status === 400 ? 400 : 502);
      assert.equal((await response.json()).error.code, code);
    });
  });
}

for (const [name, body, code] of [
  ["missing body", null, "upstream_invalid_response"],
  ["missing output", { id: "fixture", object: "response" }, "upstream_invalid_response"],
  ["chat shape", { id: "fixture", object: "chat.completion", choices: [] }, "upstream_invalid_response"],
  ["empty output", responseBody([]), "upstream_empty_response"],
  ["empty text", responseBody([message("")]), "upstream_empty_response"],
  ["reasoning only", responseBody([{ type: "reasoning", summary: [] }]), "upstream_empty_response"],
  ["nonterminal body", responseBody([], { status: "in_progress" }), "upstream_invalid_response"],
  ["missing call id", responseBody([{ type: "function_call", name: "test", arguments: "{}" }]), "upstream_invalid_response"],
  ["incomplete call in completed body", responseBody([{ type: "function_call", call_id: "partial", name: "test", arguments: "{}", status: "incomplete" }]), "upstream_invalid_response"],
  ["malformed message alongside valid tool", responseBody([{ type: "message", content: "wrong shape" }, { type: "function_call", call_id: "call", name: "tool", arguments: "{}" }]), "upstream_invalid_response"],
]) {
  test(`${name} cannot become response.completed`, async () => {
    await withRelay({ runTurn: async () => body }, async url => {
      const response = await post(url);
      assert.equal(response.status, 502);
      assert.equal((await response.json()).error.code, code);
    });
  });
}

for (const status of ["failed", "incomplete"]) {
  test(`${status} retains its real terminal event and never completes a partial tool call`, async () => {
    const body = responseBody([{ id: "partial", type: "function_call", call_id: "call_partial", name: "tool", arguments: '{"incomplete":' }], {
      status, ...(status === "failed" ? { error: { code: "server_error", message: "synthetic failure" } } : { incomplete_details: { reason: "max_output_tokens" } }),
    });
    await withRelay({ runTurn: async () => body }, async url => {
      const response = await post(url);
      const events = parseSse(await response.text());
      assert.equal(response.status, 200);
      assert.equal(events.at(-1).type, `response.${status}`);
      assert.equal(events.at(-1).response.status, status);
      assert.ok(!events.some(e => e.type === "response.completed" || e.type === "response.function_call_arguments.done" || e.type === "response.output_item.done"));
    });
  });
}

test("a body error or incomplete details cannot be overridden by status completed", async () => {
  for (const extra of [{ error: { code: "blocked", message: "synthetic" } }, { incomplete_details: { reason: "max_output_tokens" } }]) {
    await withRelay({ runTurn: async () => responseBody([], extra) }, async url => {
      const events = parseSse(await (await post(url)).text());
      assert.equal(events.at(-1).type, extra.error ? "response.failed" : "response.incomplete");
    });
  }
});

test("SSE reconstructs Unicode text, namespaced functions and custom inputs without double content", async () => {
  const output = [message("Hello 世界\nsecond line"),
    { id: "fc_fixture", type: "function_call", call_id: "call_function", namespace: "workspace", name: "read", arguments: '{"path":"测试"}' },
    { id: "ctc_fixture", type: "custom_tool_call", call_id: "call_custom", namespace: "functions", name: "exec", input: "text(1);\ntext(2);" }];
  await withRelay({ runTurn: async () => responseBody(output, { usage: { total_tokens: 3 } }) }, async url => {
    const events = parseSse(await (await post(url)).text());
    assert.deepEqual(events.map(e => e.sequence_number), events.map((_, i) => i));
    assert.deepEqual(events[0].response.output, []);
    const reconstructed = new Map();
    const executable = [];
    for (const event of events) {
      if (event.type === "response.output_item.added") reconstructed.set(event.output_index, structuredClone(event.item));
      const item = reconstructed.get(event.output_index);
      if (event.type === "response.content_part.added") item.content[event.content_index] = structuredClone(event.part);
      if (event.type === "response.output_text.delta") item.content[event.content_index].text += event.delta;
      if (event.type === "response.function_call_arguments.delta") item.arguments += event.delta;
      if (event.type === "response.custom_tool_call_input.delta") item.input += event.delta;
      if (event.type === "response.output_item.done" && /^(function_call|custom_tool_call)$/.test(event.item.type)) executable.push(event.item.call_id);
    }
    assert.equal(reconstructed.get(0).content[0].text, output[0].content[0].text);
    assert.equal(reconstructed.get(1).arguments, output[1].arguments);
    assert.equal(reconstructed.get(1).namespace, "workspace");
    assert.equal(reconstructed.get(2).input, output[2].input);
    assert.equal(reconstructed.get(2).namespace, "functions");
    assert.deepEqual(executable, ["call_function", "call_custom"]);
    assert.equal(events.filter(e => e.type === "response.content_part.done").length, 1);
    assert.equal(events.filter(e => e.type === "response.function_call_arguments.done").length, 1);
    assert.equal(events.filter(e => e.type === "response.custom_tool_call_input.done").length, 1);
    assert.equal(events.at(-1).type, "response.completed");
    assert.equal(events.at(-1).response.usage.total_tokens, 3);
  });
});

test("refusal is preserved as content, not mistaken for an empty result", async () => {
  await withRelay({ runTurn: async () => responseBody([{ id: "refusal", type: "message", role: "assistant", content: [{ type: "refusal", refusal: "Synthetic refusal" }] }]) }, async url => {
    const events = parseSse(await (await post(url)).text());
    assert.ok(events.some(e => e.type === "response.refusal.delta" && e.delta === "Synthetic refusal"));
    assert.ok(events.some(e => e.type === "response.refusal.done" && e.refusal === "Synthetic refusal"));
    assert.equal(events.at(-1).type, "response.completed");
  });
});

test("pre-cancelled requests do not call upstream; in-flight cancel differs from timeout", async () => {
  let count = 0;
  const fetchImpl = async (_url, { signal }) => {
    count++;
    return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  };
  const transport = createOpenAITransport({ baseUrl: "https://fixture.invalid", fetchImpl, timeoutMs: 15 });
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(transport.complete({ protocol: "responses", request: {} }, cancelled.signal), e => e.code === "cancelled" && e.details.status === 499);
  assert.equal(count, 0);
  await assert.rejects(transport.complete({ protocol: "responses", request: {} }), e => e.code === "timeout" && e.details.status === 504);
  const running = new AbortController();
  const pending = transport.complete({ protocol: "responses", request: {} }, running.signal);
  running.abort();
  await assert.rejects(pending, e => e.code === "cancelled" && e.details.status === 499);
});
