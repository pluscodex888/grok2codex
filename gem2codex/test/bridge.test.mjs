import test from "node:test";
import assert from "node:assert/strict";
import { createGeminiCodexBridge, BridgeError } from "../src/index.mjs";

const tool = {
  stableId: "workspace.read",
  namespace: "workspace",
  name: "read_file",
  inputSchema: { type: "object", required: ["path"], properties: { path: { type: "string" } } },
};

test("executes Gemini function call and sends FunctionResponse continuation", async () => {
  const requests = [];
  const transport = {
    async complete({ request }) {
      requests.push(request);
      if (requests.length === 1) return { candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "workspace__read_file", id: "call-1", args: { path: "README.md" } } }] } }] };
      return { candidates: [{ content: { role: "model", parts: [{ text: "Here is the file." }] } }], usageMetadata: { totalTokenCount: 4 } };
    },
  };
  const bridge = createGeminiCodexBridge({ transport, tools: [{ ...tool, wireName: "workspace__read_file" }], executor: { execute: async (_tool, args) => ({ text: `contents of ${args.path}` }) } });
  const result = await bridge.runTurn({ request: { model: "gemini-2.5-flash", contents: [{ role: "user", parts: [{ text: "read it" }] }], tools: [{ googleSearch: {} }] } });
  assert.equal(result.candidates[0].content.parts[0].text, "Here is the file.");
  assert.equal(requests.length, 2);
  assert.equal(requests[1].contents.at(-1).parts[0].functionResponse.name, "workspace__read_file");
  assert.equal(requests[1].tools.length, 2);
  assert.deepEqual(requests[1].contents.at(-1).parts[0].functionResponse.response.output, { text: "contents of README.md" });
});

test("rejects invalid Gemini function arguments before executor", async () => {
  const bridge = createGeminiCodexBridge({
    transport: { complete: async () => ({ candidates: [{ content: { parts: [{ functionCall: { name: "workspace__read_file", args: {} } }] } }] }) },
    tools: [{ ...tool, wireName: "workspace__read_file" }],
    executor: { execute: async () => assert.fail("executor must not run") },
  });
  await assert.rejects(() => bridge.runTurn({ request: { contents: [] } }), error => error instanceof BridgeError && error.code === "invalid_arguments");
});
