# GLM / DeepSeek → Codex tool adapter

This module is shipped inside `@grok2codex/client-bridge`. It does not execute
tools, load machine credentials, change desktop settings, or deploy a server.
The host owns approvals, sandboxing, MCP/browser runtimes, billing and model
selection. The client-facing contract remains **Responses**.

## Protocol and routing

The default is native Responses first. Only a structured, explicit unsupported
endpoint/protocol error allows **one** Chat Completions fallback, before any
response frame is forwarded and only when the request can be represented without
losing capabilities. No fixed retry delay or general model retry is added.

- 401/403, 429, policy/safety errors, quota/billing failures, model-not-found,
  unknown errors, ambiguous plain 404, timeout and partial streams do not fall back.
- `upstreamProtocol: "responses"` disables Chat fallback.
- `upstreamProtocol: "chat"` is an explicit host choice for a known Chat-only
  endpoint, not an automatic reaction to authentication or policy failures.
- Request cancellation and a total timeout cover both protocol attempts.
- API keys stay on the configured authority; redirects are rejected. Endpoint
  overrides are same-host absolute paths, not arbitrary second URLs.

In a server-managed GPT → GLM switch, New-API owns selection and billing; the
server-side protocol adapter owns conversion. The desktop sends its tool catalog,
executes the restored calls through its existing approval/runtime path, and sends
results with the same `call_id`. Do not map the same request again in the desktop.
A desktop that connects directly to a provider can host this adapter locally
instead. This JS library is not automatically loaded by the Go New-API or
CLIProxyAPI services; host integration and end-to-end acceptance are separate work.

## GLM

```js
import { createGLMCodexRelay } from "@grok2codex/client-bridge/glm/relay";

const relay = createGLMCodexRelay({
  model: "glm-5.3", // also glm-5.3-flash; never silently changes models
  reasoningEffort: "high",
  upstream: {
    region: "domestic", // domestic | overseas | gateway
    apiKey: runtimeCredential,
    upstreamProtocol: "auto",
    // baseUrl: configuredEndpoint, // required for gateway
    // responsesPath: "/api/v1/responses", // same-host override
    onProtocol({ protocol, reason }) { reportProtocolOnly(protocol, reason); },
  },
  // Optional: use the original runtime's synchronous grammar validator.
  // validateCustomInput({ name, namespace, input, format }) { return ...; },
});
await relay.listen();
```

Domestic native Responses uses `https://open.bigmodel.cn/api/v1/responses`.
The domestic Chat fallback uses `/api/paas/v4/chat/completions` on the same host.
A domestic Chat base ending `/api/paas/v4` is recognized; it is not blindly
extended into the nonexistent `/api/paas/v4/responses` path.

Overseas defaults to `https://api.z.ai/api/paas/v4`; gateways use their supplied
base URL. Responses availability for an overseas account/gateway must be verified
by that deployment; this library does not claim every endpoint supports it.

Both `glm-5.3` and `glm-5.3-flash` default to high reasoning. Explicit low/high/max
are preserved; medium maps to high, xhigh maps to max. Native requests use
`reasoning.effort`; Chat requests use `thinking.type=enabled`,
`thinking.clear_thinking=false` and `reasoning_effort`. Chat streaming with tools
sets `stream=true` and `tool_stream=true`.

## Tool compatibility and boundaries

| Item | Behavior |
| --- | --- |
| Function / namespace | Stable bounded wire names; restore original name and namespace |
| Custom text / grammar tools | Function `{input: string}` envelope; restore exact raw input |
| Tool history and results | Preserve calls/results and IDs; retired tools do not become newly executable |
| Last user / developer / child task | Preserve content and order; GLM Chat maps developer to system |
| Multiple tools / SSE fragments | Preserve index/ID/arguments; validate the whole terminal response before completion |
| Reasoning | Preserve native opaque state; Chat retains original plain reasoning, never invents it |
| Provider built-ins | Native GLM passthrough; Chat rejects unsupported types rather than removing them |
| Stored Responses / encrypted-only state | No Chat fallback; reconstructing a foreign provider session is not supported |
| Unknown / malformed calls | Reject; never execute parsed text/code blocks as tools |

The custom envelope preserves bytes, **not provider-side constrained decoding**.
Include `validateCustomInput` or keep the original client's grammar validation
enabled. The adapter still checks JSON, the exact single `input` key, tool identity
and call IDs; original permissions and runtime validation remain authoritative.

Text and raw reasoning stream as they arrive. Chat tool names/arguments can be
fragmented and interleaved, so their completion is held until `finish_reason` and
the actual `[DONE]` are both observed. `length`/`content_filter` remain incomplete;
early EOF or an upstream error never becomes a successful executable call.
Native Responses terminates with its actual completed/failed/incomplete event.

Chat fallback rejects requested reasoning summaries, structured Responses output,
verbosity, builtin-tool execution limits, unsupported media and provider-specific
state when their meaning cannot be preserved. It does not replace them with a
text-only request. Forced GLM Chat tool choice requires explicit endpoint support
(`supportsToolChoice`); `parallel_tool_calls:false` and chosen tool identities are
also enforced on returned calls.

## DeepSeek

```js
import { createDeepSeekCodexRelay } from "@grok2codex/client-bridge/glm/deepseek";
const relay = createDeepSeekCodexRelay({
  model: "deepseek-flash", // or deepseek-v4-pro
  reasoningEffort: "high",
  upstream: { baseUrl: "https://api.deepseek.com", apiKey: runtimeCredential },
});
await relay.listen();
```

DeepSeek has native `/responses`. Every request must contain full explicit history:
it does not store a `previous_response_id` or conversation. Unsupported state and
builtin tools are rejected locally because silently ignoring them would change
the request. Arbitrary custom tools (including exec) and namespaces are wrapped
as functions and restored to the client.

Unsupported reasoning summaries, verbosity, service-tier/safety/cache controls
and Responses `stream_options` are rejected locally as well. Metadata may be used
by the host to extract the session identity; DeepSeek does not persist or return
it as stored response metadata. Parallel-call restrictions are checked locally
before releasing completed calls because DeepSeek ignores that provider option.

DeepSeek's reasoning mapping differs from GLM: minimal→low, medium/xhigh→high,
ultra→max; none disables thinking. Its raw reasoning must remain in subsequent
tool-bearing history. Developer text is normalized to system to avoid the
provider's documented developer→user downgrade; developer images that cannot
retain that authority are rejected. `deepseek-flash` can accept supported image
inputs/tool results; do not assume the Pro model has that capability. DeepSeek
ignores `detail` on uploaded `file_id` images; use an image URL/data URL when
explicit image-detail selection is required.

Function schemas and `strict` are forwarded unchanged. DeepSeek's native
Responses documentation does not guarantee strict constrained decoding; the
client's original schema validation remains required. The adapter never opts
into a different `/beta` endpoint merely because a tool declares `strict:true`.

DeepSeek uses the same Responses-first / explicit-unsupported-only Chat policy.
Chat fallback does not send GLM-only `tool_stream` or `clear_thinking` fields.
Named/required Chat tool selection requires thinking disabled; it is never
disabled automatically. `user` maps to Chat `user_id`. Log-probability requests,
tool-output images and file IDs cannot currently be preserved by the Chat path
and are rejected rather than silently discarded. Dynamic injection of tool calls
is documented for native Responses, not Chat; keep such workloads native-only.

## Verification

```sh
node --test glm2codex/test/*.test.mjs
npm test
```

Tests use synthetic fixtures and mock transports; they require no credentials or
paid provider requests. Passing them does not mean an installed desktop or a
production Go relay has adopted this module. Deployments must verify the actual
provider, endpoint, model, session identity and two-turn tool-result continuation.

Official references:

- [GLM 5.3](https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3)
- [GLM Chat parameters](https://docs.z.ai/api-reference/llm/chat-completion)
- [GLM streamed tools](https://docs.z.ai/guides/capabilities/stream-tool)
- [GLM reasoning continuity](https://docs.z.ai/guides/capabilities/thinking-mode)
- [DeepSeek Responses](https://api-docs.deepseek.com/api/create-response/)
- [DeepSeek compatibility tables](https://api-docs.deepseek.com/guides/responses_api/)
- [DeepSeek thinking](https://api-docs.deepseek.com/guides/thinking_mode/)
- [OpenAI tool protocol](https://developers.openai.com/api/docs/guides/function-calling)
