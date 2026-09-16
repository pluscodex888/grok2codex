import test from "node:test";
import assert from "node:assert/strict";
import { createBridge, createBridgeServer, createOpenAITransport, createClientToolPassthrough } from "../src/index.mjs";
import { createClaudeToolPassthrough } from "../claude2codex/src/index.mjs";
import { resolveSessionId } from "../src/session.mjs";

for (const model of ["grok-4.6", "gemini-3.1-pro", "claude-opus-4-6-thinking"]) {
  for (const stream of [false, true]) {
    test(`${model} stream=${stream}: concurrent identical prompts keep independent session IDs`, async () => {
      const seen = [];
      let release;
      const simultaneous = new Promise(resolve => { release = resolve; });
      const configured = { "x-fixed": "fixed" };
      const transport = createOpenAITransport({ baseUrl: "https://fixture.invalid/v1", apiKey: "upstream-only", headers: configured,
        fetchImpl: async (_url, init) => {
          const headers = new Headers(init.headers);
          const body = JSON.parse(init.body);
          seen.push({ id: headers.get("Session_id"), body });
          assert.equal(headers.get("authorization"), "Bearer upstream-only");
          assert.equal(headers.get("cookie"), null);
          assert.equal(headers.get("x-answer-user-level"), null);
          assert.equal(headers.get("x-fixed"), "fixed");
          if (seen.length === 2) release();
          await simultaneous;
          const response = { id: "resp-test", object: "response", model, status: "completed", output: [{ type: "message", id: "msg-test", status: "completed", role: "assistant", content: [{ type: "output_text", text: "ok", annotations: [] }] }], error: null };
          return body.stream
            ? new Response(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response })}\n\n`, { headers: { "content-type": "text/event-stream" } })
            : Response.json(response);
        } });
      const bridge = model.startsWith("claude") ? createClaudeToolPassthrough({ transport }) : createClientToolPassthrough({ transport });
      const server = createBridgeServer({ bridge });
      const { port } = await server.listen();
      const post = async (headers, extra = {}) => {
        const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
          method: "POST", headers: { "content-type": "application/json", authorization: "Bearer client-only", cookie: "client-only", "x-answer-user-level": "D", ...headers },
          body: JSON.stringify({ model, stream, input: "same first message", prompt_cache_key: "shared-cache-not-a-session", ...extra }),
          signal: AbortSignal.timeout(5000),
        });
        assert.equal(response.status, 200, await response.text());
      };
      try {
        await Promise.all([post({ Session_id: "thread-a" }), post({ "X-Codex-Session-Id": "thread-b" })]);
        assert.deepEqual(seen.map(v => v.id).sort(), ["thread-a", "thread-b"]);
        await post({ Session_id: "thread-a" }, { input: [{ type: "function_call_output", call_id: "call-a", output: "done" }] });
        assert.equal(seen[2].id, "thread-a", "tool continuation retains the same session");
        await post({}, { metadata: { session_id: "thread-c" } });
        assert.equal(seen[3].id, "thread-c");
        await post({});
        assert.equal(seen[4].id, null, "no previous request ID or content hash is reused");
        assert.ok(seen.every(v => v.body.prompt_cache_key === "shared-cache-not-a-session"));
        assert.deepEqual(configured, { "x-fixed": "fixed" });
      } finally { server.server.closeAllConnections(); await server.close(); }
    });
  }
}

test("session selection accepts explicit IDs only and rejects unsafe values", () => {
  assert.equal(resolveSessionId({ "sEsSiOn-Id": "header-a" }, { metadata: { session_id: "body-b" } }), "header-a");
  assert.equal(resolveSessionId({}, { metadata: { codex_session_id: "body-c" } }), "body-c");
  assert.equal(resolveSessionId({}, { prompt_cache_key: "cache", previous_response_id: "response", input: "same" }), undefined);
  for (const id of ["bad\r\nX-Test: evil", "with space", "a".repeat(129), 123, ["a", "b"]]) {
    assert.throws(() => resolveSessionId({ Session_id: id }, {}), /session identifier/);
  }
});

test("server rejects invalid identity before sending anything upstream", async () => {
  let calls = 0;
  const server = createBridgeServer({ bridge: { async runTurn() { calls++; } } });
  const { port } = await server.listen();
  try {
    const result = await fetch(`http://127.0.0.1:${port}/v1/responses`, { method: "POST", body: JSON.stringify({ metadata: { session_id: "bad\r\nheader" } }) });
    assert.equal(result.status, 400);
    assert.equal(calls, 0);
  } finally { server.server.closeAllConnections(); await server.close(); }
});

test("bridge-owned tool loop passes session identity on every upstream turn", async () => {
  const seen = [];
  const bridge = createBridge({
    tools: [{ name: "read", namespace: "test", inputSchema: { type: "object" } }],
    executor: { async execute() { return "done"; } },
    transport: { async complete(input) {
      seen.push(input.sessionId);
      return seen.length === 1 ? { id: "r1", output: [{ type: "function_call", call_id: "c1", name: "test__read", arguments: "{}" }] } : { id: "r2", output: [] };
    } },
  });
  await bridge.runTurn({ sessionId: "thread-tool", request: { model: "grok-4.6", input: "read" } });
  assert.deepEqual(seen, ["thread-tool", "thread-tool"]);
});
