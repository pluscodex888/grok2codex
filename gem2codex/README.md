# gem2codex

Gemini `generateContent` 中间层：把 Gemini 的 function calling 请求转换为 Codex 已批准的工具调用，再把 `FunctionResponse` 结果送回 Gemini，直到得到最终回答。

## 设计边界

- 参考 `E:\git\grok2codex` 的 provider-neutral bridge 结构。
- 中间层只负责 Gemini 协议、工具声明、参数校验、调用关联和多轮续接。
- Codex/app-server、审批、沙箱、MCP 和审计由宿主通过 `invoke` 提供；本项目不启动 shell、不读取凭据、不绕过审批。
- 默认监听 `127.0.0.1`，提供 Gemini 原生兼容接口：`/v1beta/models`、`/v1beta/models/:model:generateContent` 和 `:streamGenerateContent`。

## 使用

```js
import { createGeminiCodexRelay } from "./src/integration.mjs";

const relay = createGeminiCodexRelay({
  upstream: {
    baseUrl: process.env.GEMINI_BASE_URL,
    apiKey: process.env.GEMINI_API_KEY,
  },
  tools: [{
    stableId: "workspace.read",
    namespace: "workspace",
    name: "read_file",
    description: "Read an approved workspace file",
    inputSchema: {
      type: "object",
      required: ["path"],
      properties: { path: { type: "string" } },
    },
  }],
  invoke: ({ tool, arguments: args, correlation }) =>
    existingCodexApprovedToolGateway(tool, args, correlation),
});

await relay.listen();
```

The Gemini API uses `x-goog-api-key` for authentication and returns function calls in `candidates[].content.parts[].functionCall`. The bridge preserves the model content and sends results as `functionResponse` parts, including call IDs where provided.

## 官方文档依据

- [Gemini Function Calling](https://ai.google.dev/gemini-api/docs/function-calling)
- [Gemini Generate Content API](https://ai.google.dev/api/generate-content)
- [Gemini Tools](https://ai.google.dev/gemini-api/docs/tools)
- [Codex app-server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
- [Codex app-server JSON-RPC types](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/rpc.rs)

## 验证

```sh
npm test
```

