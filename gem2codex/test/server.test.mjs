import test from "node:test";
import assert from "node:assert/strict";
import { createGeminiCodexServer } from "../src/server.mjs";

test("serves Gemini generateContent and streaming paths", async () => {
  const bridge = { runTurn: async ({ request }) => ({ candidates: [{ content: { role: "model", parts: [{ text: request.contents?.[0]?.parts?.[0]?.text || "ok" }] } }] }) };
  const relay = createGeminiCodexServer({ bridge, model: "gemini-test" });
  const address = await relay.listen();
  try {
    const base = `http://${address.host}:${address.port}`;
    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);
    const response = await fetch(`${base}/v1beta/models/gemini-test:generateContent`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ contents: [{ parts: [{ text: "hello" }] }] }) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).candidates[0].content.parts[0].text, "hello");
    const stream = await fetch(`${base}/v1beta/models/gemini-test:streamGenerateContent`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ contents: [] }) });
    assert.equal(stream.status, 200);
    assert.match(await stream.text(), /^data: /);
  } finally { await relay.close(); }
});
