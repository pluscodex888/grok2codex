import test from "node:test";
import assert from "node:assert/strict";
import { createOpenAITransport } from "../src/http.mjs";
import { createBridgeServer } from "../src/server.mjs";
import { createClientToolPassthrough, createResponsesToolCodec } from "../src/passthrough.mjs";
import { upstreamHttpError } from "../src/http-errors.mjs";

for (const stream of [true, false]) {
  test(`xAI flat HTTP error survives the complete bridge (stream=${stream})`, async () => {
    let calls = 0;
    const transport = createOpenAITransport({ baseUrl: "https://fixture.invalid", fetchImpl: async () => {
      calls++;
      return new Response(JSON.stringify({ code: "internal", error: "Auth context expired." }), {
        status: 500, headers: { "content-type": "application/json" },
      });
    } });
    const server = createBridgeServer({ bridge: createClientToolPassthrough({ transport }) });
    const address = await server.listen();
    try {
      const response = await fetch(`http://${address.host}:${address.port}/v1/responses`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "grok-4.6", input: "fixture", stream, tools: [] }),
      });
      assert.equal(response.status, 500);
      const body = await response.json();
      assert.equal(body.error.code, "internal");
      assert.equal(body.error.message, "Auth context expired.");
      assert.equal(calls, 1);
    } finally { await server.close(); }
  });
}

test("flat xAI errors retain redaction and do not override nested error details", () => {
  const response = { status: 500 };
  assert.equal(upstreamHttpError(response, { code: "internal", error: "Auth context expired. token=fixture-secret" }).message,
    "Auth context expired. token=[REDACTED]");
  assert.equal(upstreamHttpError(response, { code: "internal", error: { code: "nested", message: "nested reason" } }).code, "nested");
});

test("stateless native history preserves opaque reasoning and image results through tool translation", () => {
  const image = { type: "image_generation_call", id: "ig_fixture", status: "completed", result: Buffer.alloc(4096, 7).toString("base64") };
  const reasoning = { type: "reasoning", id: "rs_fixture", encrypted_content: "opaque-provider-owned-payload", summary: [] };
  const call = { type: "custom_tool_call", name: "exec", call_id: "call_fixture", input: "fixture()" };
  const output = { type: "custom_tool_call_output", call_id: "call_fixture", output: "fixture output" };
  const request = { model: "grok-4.6", store: false, include: ["reasoning.encrypted_content"],
    tools: [{ type: "custom", name: "exec" }, { type: "image_generation" }],
    input: [reasoning, image, call, output] };
  const before = structuredClone(request);
  const codec = createResponsesToolCodec(request);
  assert.deepEqual(request, before);
  assert.deepEqual(codec.request.input.slice(0, 2), [reasoning, image]);
  assert.equal(codec.request.input[2].call_id, codec.request.input[3].call_id);
  assert.equal(codec.request.input[3].output, output.output);
  assert.deepEqual(codec.restore({ output: [reasoning, image] }).output, [reasoning, image]);
});
