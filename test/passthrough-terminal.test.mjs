import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createOpenAITransport } from "../src/http.mjs";
import { createClientToolPassthrough } from "../src/passthrough.mjs";
import { createBridgeServer } from "../src/server.mjs";

const tools = [{ type: "namespace", name: "functions", tools: [{ type: "custom", name: "exec" }] }];
const envelope = (output, extra = {}) => ({ id: "resp_fixture", object: "response", status: "completed", output, ...extra });
const parseSse = text => text.split(/\r?\n\r?\n/).filter(Boolean).map(frame => JSON.parse(frame.split(/\r?\n/).find(line => line.startsWith("data: ")).slice(6)));
const post = (url, body) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, stream: true }), signal: AbortSignal.timeout(3000) });

async function withThreeLayers(reply, run) {
  const requests = [], handoffs = [];
  const upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push(request);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(reply(request, requests.length)));
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const transport = createOpenAITransport({ baseUrl: `http://127.0.0.1:${upstream.address().port}` });
  const bridge = createClientToolPassthrough({ transport, onResponse: details => handoffs.push(details) });
  const server = createBridgeServer({ bridge });
  const { host, port } = await server.listen();
  try { await run(`http://${host}:${port}/v1/responses`, requests, handoffs); }
  finally { await server.close(); await new Promise(resolve => upstream.close(resolve)); }
}

for (const status of ["failed", "incomplete"]) {
  for (const knownName of [true, false]) {
    test(`${status} truncated custom input (${knownName ? "known" : "partial unknown"} name) preserves the upstream terminal across all three layers`, async () => {
      await withThreeLayers(request => envelope([
        { id: "partial_tool", type: "function_call", call_id: "partial_call", name: knownName ? request.tools[0].name : "unfinished_wire", arguments: '{"input":"partial' },
        { id: "partial_message", type: "message", role: "assistant", content: [{ type: "output_text", text: "Partial fixture text", annotations: [] }] },
      ], { status, ...(status === "failed" ? { error: { code: "server_error", message: "Fixture original failure" } } : { incomplete_details: { reason: "max_output_tokens" } }) }), async (url, requests, handoffs) => {
        const response = await post(url, { tools, input: "synthetic fixture" });
        const events = parseSse(await response.text());
        assert.equal(response.status, 200);
        assert.equal(requests.length, 1);
        assert.equal(events.at(-1).type, `response.${status}`);
        assert.equal(events.at(-1).response.status, status);
        assert.equal(events.at(-1).response.output[0].call_id, "partial_call");
        assert.equal(events.at(-1).response.output[0].arguments, '{"input":"partial');
        if (status === "failed") assert.equal(events.at(-1).response.error.code, "server_error");
        else assert.equal(events.at(-1).response.incomplete_details.reason, "max_output_tokens");
        assert.ok(events.some(event => event.type === "response.output_text.delta" && event.delta === "Partial fixture text"));
        assert.ok(!events.some(event => event.type === "response.completed" || /call_(arguments|input)\.done$/.test(event.type)
          || event.type === "response.output_item.done" && /tool_call|function_call/.test(event.item.type)));
        assert.deepEqual(handoffs, [{ status, calls: [] }]);
      });
    });
  }
}

for (const unknown of [false, true]) {
  test(`completed ${unknown ? "unadvertised call" : "invalid custom JSON"} remains rejected`, async () => {
    await withThreeLayers(request => envelope([{ id: "tool", type: "function_call", call_id: "call", name: unknown ? "not_advertised" : request.tools[0].name, arguments: unknown ? '{"input":"fixture"}' : "{" }]), async (url, requests, handoffs) => {
      const response = await post(url, { tools, input: "synthetic fixture" });
      assert.equal(response.status, 500);
      assert.equal((await response.json()).error.code, "invalid_tool_call");
      assert.equal(requests.length, 1);
      assert.deepEqual(handoffs, []);
    });
  });
}

test("completed custom calls and client-owned continuation retain names, namespace, call IDs and raw output", async () => {
  const input = [{ role: "user", content: "synthetic fixture" }];
  await withThreeLayers((request, turn) => turn === 1
    ? envelope([{ id: "custom_item", type: "function_call", call_id: "custom_call", name: request.tools[0].name, arguments: JSON.stringify({ input: "text(1);\ntext(2);" }) }])
    : envelope([{ id: "answer", type: "message", role: "assistant", content: [{ type: "output_text", text: "Fixture result received", annotations: [] }] }]), async (url, requests, handoffs) => {
    const events = parseSse(await (await post(url, { tools, input })).text());
    const completed = events.at(-1).response;
    assert.equal(completed.output[0].type, "custom_tool_call");
    assert.equal(completed.output[0].name, "exec");
    assert.equal(completed.output[0].namespace, "functions");
    assert.equal(completed.output[0].call_id, "custom_call");
    assert.equal(events.filter(event => event.type === "response.custom_tool_call_input.done").length, 1);
    input.push(...completed.output, { type: "custom_tool_call_output", call_id: "custom_call", output: "Actual fixture tool output\nline 2" });
    // The old tool is no longer advertised on the continuation; its history
    // still pairs by call_id, without authorizing a fresh call to that tool.
    const second = parseSse(await (await post(url, { tools: [], input })).text());
    assert.equal(second.at(-1).type, "response.completed");
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1].tools, []);
    assert.equal(requests[1].input[1].name, requests[0].tools[0].name);
    assert.equal(requests[1].input[1].call_id, "custom_call");
    assert.equal(requests[1].input[1].arguments, JSON.stringify({ input: "text(1);\ntext(2);" }));
    assert.deepEqual(requests[1].input[2], { type: "function_call_output", call_id: "custom_call", output: "Actual fixture tool output\nline 2" });
    assert.equal(handoffs[0].calls[0].callId, "custom_call");
    assert.deepEqual(handoffs[1].calls, []);
  });
});
