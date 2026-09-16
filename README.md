# Grok / Gemini client tool bridge

One repository and one versioned package for client-owned tool calls. The OpenAI-compatible Responses adapter supports Grok and Gemini model routes; the Gemini native adapter supports `generateContent` and `streamGenerateContent`.

The host owns model credentials, approvals, sandboxing, MCP, and tool execution. This library translates requests, tool names, call IDs, and results. It never starts a shell or obtains credentials from the machine.

## Repository layout

| Path | Responsibility |
| --- | --- |
| `src/passthrough.mjs` | Namespaced function/custom tools and client-owned continuation |
| `src/http.mjs`, `src/server.mjs` | OpenAI-compatible transport and Responses/Chat HTTP endpoints |
| `src/http-errors.mjs` | Shared upstream status, error details, and retry metadata |
| `src/index.mjs`, `src/codex.mjs`, `src/socket.mjs` | Tool catalog and optional host-supplied executor APIs |
| `gem2codex/src/` | Gemini native protocol adapter |
| `test/`, `gem2codex/test/` | Protocol and delivery regressions |
| `scripts/release.mjs` | Deterministic archive and file manifest |

`gem2codex/` is maintained here and shipped with the root package. Its package metadata is private to prevent accidental independent publication. Existing root import paths remain available; native Gemini APIs are exposed under `@grok2codex/client-bridge/gemini` and its `/http`, `/server`, and `/relay` subpaths.

See [the changelog](CHANGELOG.md) for release changes.

## Desktop clients that already execute tools

Use the Responses passthrough when the client owns the model/tool loop. It makes one upstream request and returns function or custom calls to that same client. The next client request carries the history and real tool results. Do not connect this mode to a second executor.

```js
import {
  createClientToolPassthrough,
  createOpenAITransport,
  createBridgeServer,
} from "@grok2codex/client-bridge";

const bridge = createClientToolPassthrough({
  transport: createOpenAITransport({
    baseUrl: configuredModelEndpoint,
    apiKey: runtimeCredential,
  }),
  nativeTools: [],
});
const relay = createBridgeServer({ bridge, model: selectedModel });
await relay.listen();
```

Use the host's configured model endpoint, including its existing authenticated transport when needed. Choose native provider tools explicitly: Grok image generation can use `nativeTools: [{ type: "image_generation" }]`; Gemini model routes can use their supported catalog. Grok and Gemini enable/disable preferences belong to the host and remain independent.

Namespaces and custom text tools are translated into function declarations, then restored with their original names, namespaces, raw input, and call IDs. Stable wire names fit Gemini's 64-character limit. Historical tools are translated for context without becoming newly executable tools. Text/code blocks remain text and are never synthesized into tool calls.

### Genuine Responses streaming (0.3.0)

With the setup above, `POST /v1/responses` with `stream: true` now sends `stream: true` upstream and forwards SSE events as they arrive. Text, reasoning, native image progress, and function argument deltas no longer wait for the entire response. Explicit `stream: false` calls still return one JSON response.

The transport exposes `stream()` and the passthrough exposes `streamTurn()`. Pass the complete bridge object to `createBridgeServer`, including when using `bridgeForRequest`; a host wrapper that retains only `runTurn()` uses the previous buffered path. Custom transports can implement the optional streaming method. Existing complete-only transports remain compatible.

Tool names, namespaces, call IDs, and raw custom input are restored before delivery. Function/custom completion events are held until the upstream confirms `response.completed`, so a failed generation cannot execute an unfinished tool call. Text and reasoning continue streaming while tool completion is pending.

HTTP errors before the first event retain their status. Provider SSE errors and failed/incomplete terminal events retain their original details; an error without a terminal event also receives a compatible `response.failed` carrying that error. An unexplained early EOF becomes `upstream_stream_incomplete`, never a successful empty answer. The bridge performs no automatic retry. Client cancellation closes upstream, writes respect downstream backpressure, and the existing `timeoutMs` still limits the whole upstream request.

If an upstream ignores `stream: true` and returns JSON, that single response is converted to SSE without a second request. The autonomous executor loop and Gemini native adapter retain their existing behavior; this change applies to the shared Grok/Gemini Responses passthrough. Shipping this library does not update a host application's embedded archive: the host must adopt and verify the new version.

## Gemini native API

```js
import { createGeminiCodexRelay } from "@grok2codex/client-bridge/gemini/relay";

const relay = createGeminiCodexRelay({
  upstream: { baseUrl: configuredGeminiEndpoint, apiKey: runtimeCredential },
  tools: approvedToolCatalog,
  invoke: invokeThroughExistingApprovalGateway,
});
await relay.listen();
```

This mode accepts Gemini native `contents` and `functionResponse` messages and uses an explicit host-supplied executor. Its endpoint is `/v1beta/models/:model:generateContent` (or `:streamGenerateContent`). It is not a drop-in replacement for a Responses endpoint. See [the native adapter](gem2codex/README.md).

## Responses and errors

- Upstream HTTP failures retain their status and safe diagnostic details. Retry metadata is forwarded when valid; authentication and validation errors must not become generic retryable 502 responses.
- Responses streaming emits text/function/custom lifecycle events and the actual `completed`, `failed`, or `incomplete` terminal event.
- Missing or invalid response payloads are errors, not successful empty answers. Cancellation follows the original request.
- Tool execution, approval, workspace access, and sandbox policy remain with the caller.
- In the streaming path, `onResponse` is an observer; its exceptions do not replace provider terminal events.

## Test and deliver

Node.js 20 or newer is required. There are no runtime dependencies.

```sh
npm test
npm run release
```

An optional Windows/Linux GitHub Actions configuration is provided in [.github/protocol-tests-template.yml](.github/protocol-tests-template.yml). To enable it, add it as `.github/workflows/ci.yml` using credentials with permission to manage workflows.

The release command writes `dist/grok2codex.tar.gz`. It includes both adapters and a fixed `grok2codex-manifest.json` with the package version, entry point, and file hashes. Consumers verify the archive SHA and version and distribute this exact archive. To choose an output file, use `npm run release -- /path/to/grok2codex.tar.gz`.

The archive keeps the existing name and `src/index.mjs` entry point for desktop compatibility. Source changes belong in this repository; generated archives and installed copies are not editing targets.

## Protocol references

- [OpenAI function and custom tools](https://developers.openai.com/api/docs/guides/function-calling)
- [OpenAI Responses streaming events](https://developers.openai.com/api/reference/resources/responses/streaming-events)
- [Gemini function calling](https://ai.google.dev/gemini-api/docs/function-calling)
- [Gemini generateContent](https://ai.google.dev/api/generate-content)

MIT licensed. This standalone library contains no desktop application source, private service configuration, or credentials.
