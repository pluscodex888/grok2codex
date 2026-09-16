# Claude tool bridge

The Claude module is shipped in the same archive as Grok and Gemini. It connects a Codex client to Claude through an existing **Responses-compatible gateway**. The client retains tool execution, approvals, workspace access, and MCP.

The Antigravity catalog route used by default is `claude-opus-4-6-thinking`. This is a gateway model ID, not the Anthropic API's `claude-opus-4-6` ID. Select the exact name returned by your authenticated upstream model catalog; do not infer available cards or quota from the module's defaults.

```js
import { createClaudeCodexRelay } from "@grok2codex/client-bridge/claude/relay";

const relay = createClaudeCodexRelay({
  upstream: {
    baseUrl: configuredResponsesGateway,
    apiKey: runtimeCredential,
    fetchImpl: existingAuthenticatedFetch, // optional; retains host transport
  },
  model: "claude-opus-4-6-thinking",
});
const address = await relay.listen();
// Route the client's Responses requests to address.host/address.port.
// Keep its existing tool execution and approval path.
```

For hosts already creating their own relay, use `createClaudeToolPassthrough` from the `/claude` export with `createOpenAITransport`, then pass the full returned object to `createBridgeServer`. Root exports also expose these helpers and `isClaudeModel`.

## Request and continuation contract

- `stream: true` uses the shared incremental upstream SSE path. `stream: false` returns JSON. No background model calls, automatic retries, or second executor are introduced.
- Namespaced function tools, custom code-mode/patch tools, schemas, call IDs, and outputs use the established Grok tool codec. Text and code fences are never treated as executable calls.
- Complete successful tool calls return to the client. The next client request must contain the preceding output, reasoning items, and corresponding real tool results.
- `reasoning.encrypted_content` is added to `include`. Existing include options and opaque reasoning/signature data are preserved. The gateway owns provider-specific signature validation and thinking configuration; this module does not fabricate or convert signatures.
- No Grok image-generation tool is injected. Native tools are included only when explicitly supplied by the host/request and supported by the selected upstream route.
- HTTP errors retain status and safe details; SSE provider errors/terminal states pass through the shared stream bridge. Interrupted or failed generations cannot become completed executable tools.
- An Anthropic `overloaded_error` frame remains unchanged. If it has no Responses error code, the additional failed terminal includes `server_is_overloaded`, preserving the original type/message while allowing native Codex to show model capacity instead of retrying a generic disconnect.

This endpoint accepts OpenAI Responses, not Anthropic `/v1/messages`. The existing gateway handles the Claude/Antigravity conversion. An Anthropic API key or Messages endpoint cannot replace the configured gateway URL.

## Host integration

Adopt the entire versioned archive and its manifest/SHA metadata. Add Claude to the host's model-family routing and preferences using `isClaudeModel` and the server's model catalog; expose its own enable/disable setting. Preserve the current user/token card-pool selection through the host's authenticated transport. Do not hardcode an account, credential, quota, or private service URL.

The module does not install or restart the host, modify a model picker, change the selected pool, or publish a client release. A package test is separate from a real request through the installed client and the selected card.

## Protocol references (reviewed 2026-09-16)

- [Claude tool-use overview](https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview): client tool calls and their results belong to the application tool loop.
- [Claude tool definitions](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools): named tools have JSON schemas; thinking/tool-choice compatibility is model-dependent.
- [Claude streaming](https://platform.claude.com/docs/en/build-with-claude/streaming): partial JSON arguments and stream errors require explicit handling.
- [OpenAI function/custom tools](https://developers.openai.com/api/docs/guides/function-calling): preserve custom raw input and tool-result correlation across Responses turns.
- [Codex configuration](https://developers.openai.com/codex/config-reference): a custom model provider uses the configured Responses endpoint; credentials and provider selection belong to the host.

Official Claude documentation describes Messages API semantics. The module reuses the gateway's Responses conversion instead of sending Messages fields to the wrong endpoint.
