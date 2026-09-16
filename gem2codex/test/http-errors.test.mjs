import test from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { createGeminiTransport } from "../src/gemini-http.mjs";
import { createGeminiCodexServer } from "../src/server.mjs";

const contents = [{ role: "user", parts: [{ text: "fixture" }] }];

async function throughServer(transport, inspect) {
  const relay = createGeminiCodexServer({ bridge: { runTurn: args => transport.complete(args) } });
  const address = await relay.listen();
  try {
    const response = await fetch(`http://${address.host}:${address.port}/v1beta/models/gemini-fixture:generateContent`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ contents }),
    });
    await inspect(response);
  } finally { await relay.close(); }
}

test("native Gemini rejection preserves HTTP status and symbolic status with bounded redacted diagnostics", async () => {
  const apiKey = "fixture-api-key-value";
  const transport = createGeminiTransport({
    baseUrl: "https://upstream.example/v1beta", apiKey,
    fetchImpl: async () => new Response(JSON.stringify({ error: {
      code: 400, status: "INVALID_ARGUMENT", param: "tools[0].functionDeclarations[0].parameters",
      message: `Invalid schema at tools[0].functionDeclarations[0].parameters; api_key=${apiKey}. ${"detail ".repeat(250)}`,
      details: [{ private_body: "must not leave transport" }],
    } }), { status: 400 }),
  });
  await throughServer(transport, async response => {
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error.code, 400);
    assert.equal(body.error.status, "INVALID_ARGUMENT");
    assert.equal(body.error.param, "tools[0].functionDeclarations[0].parameters");
    assert.match(body.error.message, /Invalid schema at tools\[0\]/);
    assert.match(body.error.message, /REDACTED/);
    assert.ok(body.error.message.length <= 1024);
    assert.doesNotMatch(JSON.stringify(body), /fixture-api-key-value|private_body|must not leave/);
  });
});

test("Gemini rate limits and availability errors retain safe Retry-After values", async t => {
  for (const [status, nativeStatus, retryAfter] of [
    [429, "RESOURCE_EXHAUSTED", "17"],
    [503, "UNAVAILABLE", "Wed, 16 Sep 2026 12:00:00 GMT"],
  ]) await t.test(String(status), async () => {
    const transport = createGeminiTransport({ fetchImpl: async () => new Response(JSON.stringify({ error: {
      code: status, status: nativeStatus, message: "Fixture retry later",
    } }), { status, headers: { "retry-after": retryAfter } }) });
    await throughServer(transport, async response => {
      assert.equal(response.status, status);
      assert.equal(response.headers.get("retry-after"), retryAfter);
      const body = await response.json();
      assert.equal(body.error.status, nativeStatus);
      assert.equal(body.error.code, status);
    });
  });
});

test("non-JSON native errors keep their HTTP status without reflecting the upstream body", async () => {
  const transport = createGeminiTransport({ fetchImpl: async () => new Response("<html>private upstream fixture</html>", {
    status: 429, headers: { "retry-after": "5" },
  }) });
  await throughServer(transport, async response => {
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("retry-after"), "5");
    const body = await response.json();
    assert.equal(body.error.status, "RESOURCE_EXHAUSTED");
    assert.doesNotMatch(JSON.stringify(body), /html|private upstream/);
  });
});

test("malformed successful upstream JSON becomes a 502 protocol failure", async () => {
  const transport = createGeminiTransport({ fetchImpl: async () => new Response("not JSON", { status: 200 }) });
  await throughServer(transport, async response => {
    assert.equal(response.status, 502);
    assert.equal((await response.json()).error.status, "UNAVAILABLE");
  });
});

test("already cancelled Gemini requests never invoke the upstream transport", async () => {
  let calls = 0;
  const controller = new AbortController();
  controller.abort(new Error("private cancellation reason"));
  const transport = createGeminiTransport({ fetchImpl: async () => { calls++; return new Response("{}"); } });
  await assert.rejects(transport.complete({ model: "gemini-fixture", request: { contents }, signal: controller.signal }), error => {
    assert.equal(error.code, "cancelled");
    assert.equal(error.details.status, 499);
    assert.doesNotMatch(JSON.stringify(error), /private cancellation reason/);
    return true;
  });
  assert.equal(calls, 0);
});

test("cancellation during body consumption aborts the same upstream request", async () => {
  const controller = new AbortController();
  let reading;
  const started = new Promise(resolve => { reading = resolve; });
  let upstreamSignal;
  const transport = createGeminiTransport({ fetchImpl: async (_url, init) => {
    upstreamSignal = init.signal;
    return { ok: true, status: 200, text: () => new Promise((_resolve, reject) => {
      reading();
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    }) };
  } });
  const pending = transport.complete({ model: "gemini-fixture", request: { contents }, signal: controller.signal });
  const checked = assert.rejects(pending, error => error.code === "cancelled" && error.details.status === 499);
  await started;
  controller.abort(new Error("fixture cancellation"));
  await checked;
  assert.equal(upstreamSignal.aborted, true);
});

test("Gemini request timeout remains distinguishable from client cancellation", async () => {
  const transport = createGeminiTransport({ timeoutMs: 15, fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
  }) });
  await throughServer(transport, async response => {
    assert.equal(response.status, 504);
    const body = await response.json();
    assert.equal(body.error.status, "DEADLINE_EXCEEDED");
    assert.match(body.error.message, /timed out/);
  });
});

test("network failures redact supplied credentials without retaining causes or response bodies", async () => {
  const apiKey = "fixture-network-api-secret";
  const authorization = "Bearer fixture-network-token";
  const transport = createGeminiTransport({ apiKey, headers: { authorization }, fetchImpl: async () => {
    throw new Error(`fixture network failure api_key=${apiKey} ${authorization}`);
  } });
  await assert.rejects(transport.complete({ model: "gemini-fixture", request: { contents } }), error => {
    assert.equal(error.code, "upstream");
    assert.match(error.message, /fixture network failure/);
    assert.doesNotMatch(error.message, /fixture-network-api-secret|fixture-network-token/);
    assert.equal(error.details.body, undefined);
    assert.equal(error.details.cause, undefined);
    return true;
  });
});

test("closing the native HTTP client propagates cancellation to the existing bridge transport", { timeout: 2000 }, async () => {
  let startedResolve;
  let abortedResolve;
  const started = new Promise(resolve => { startedResolve = resolve; });
  const aborted = new Promise(resolve => { abortedResolve = resolve; });
  const transport = createGeminiTransport({ fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
    startedResolve();
    init.signal.addEventListener("abort", () => { abortedResolve(); reject(init.signal.reason); }, { once: true });
  }) });
  const relay = createGeminiCodexServer({ bridge: { runTurn: args => transport.complete(args) } });
  const address = await relay.listen();
  const req = httpRequest({ host: address.host, port: address.port, method: "POST", path: "/v1beta/models/gemini-fixture:generateContent", headers: { "content-type": "application/json" } });
  req.on("error", () => {});
  try {
    req.end(JSON.stringify({ contents }));
    await started;
    req.destroy();
    await aborted;
  } finally {
    req.destroy();
    await relay.close();
  }
});
