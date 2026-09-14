# grok2codex client bridge

`@grok2codex/client-bridge` is a small, provider-neutral client middleware for routing Grok client function calls to an already-approved local tool executor.

It deliberately does **not** import Codex, CLIProxyAPI, New-API, Electron, an xAI SDK, or any private application type. Integrations provide three narrow interfaces:

- `tools`: a public tool catalog with stable IDs and JSON Schema;
- `transport`: the caller's Grok Responses or Chat Completions transport;
- `executor`: the caller's existing, permission-aware local executor.

The bridge only performs name mapping, schema checks, policy checks, call/result correlation, dispatcher fallback for large catalogs, and protocol continuation. It never starts a shell, reads a file, stores credentials, or exposes a listener.

## Minimal usage

```js
import { createBridge } from "@grok2codex/client-bridge";

const bridge = createBridge({
  tools: [{
    stableId: "workspace.read",
    namespace: "workspace",
    name: "read_file",
    description: "Read an approved workspace file",
    inputSchema: {
      type: "object",
      required: ["path"],
      properties: { path: { type: "string" } }
    },
    source: "codex"
  }],
  transport: { complete: sendToYourGrokTransport },
  executor: { execute: executeThroughYourApprovedCodexGateway },
  policy: { allowTool: checkYourExistingApprovalPolicy }
});

const response = await bridge.runTurn({
  protocol: "responses",
  request: { model: "grok", input: "Read the project file" }
});
```

## Connecting a Grok-compatible endpoint

The package includes a credential-in-memory OpenAI-compatible transport. It
supports the Responses and Chat Completions paths used by the enhanced
desktop client and forces the internal continuation requests to be buffered,
so a tool call is never acknowledged before its approved executor returns.

```js
import { createBridge, createOpenAITransport } from "@grok2codex/client-bridge";

const transport = createOpenAITransport({
  baseUrl: process.env.GROK_BASE_URL,
  apiKey: process.env.GROK_API_KEY,
});
const bridge = createBridge({ transport, tools, executor });
```

For a client that expects an OpenAI-compatible local endpoint, use the
optional relay server. It exposes `/healthz`, `/v1/models`,
`/v1/responses`, and `/v1/chat/completions`; the host still supplies the
executor that talks to its existing Codex/app-server approval path.

```js
import { createBridgeServer } from "@grok2codex/client-bridge/server";
const relay = createBridgeServer({ bridge, host: "127.0.0.1", port: 0 });
console.log(await relay.listen());
```

In the enhanced desktop deployment, set `baseUrl` to the configured internal
New-API/CLIProxyAPI model route (the same OpenAI-compatible route used by the
desktop model provider), and point the desktop provider at the relay's local
`/v1` endpoint. Do not point the relay at a direct xAI route when the host
expects Codex tools: the direct route has no local approval executor.

When the approved tool catalog is request-scoped, provide
`bridgeForRequest(protocol, body)` and return a separately constructed bridge
for that request. This avoids mutating a shared catalog while another turn is
running.

The relay emits a compact final SSE sequence when `stream: true`. This keeps
the upstream tool loop private while preserving the standard response shape
expected by the desktop renderer. Approval, workspace, cancellation, and
MCP routing remain host responsibilities.

For a single integration entry point, use `createGrokCodexRelay()` with the
Codex fingerprint and the host's existing app-server callback:

```js
import { createGrokCodexRelay, fingerprint } from "@grok2codex/client-bridge";
const relay = createGrokCodexRelay({
  upstream: { baseUrl: process.env.INTERNAL_MODEL_BASE_URL, apiKey: process.env.INTERNAL_MODEL_KEY },
  codex: { fingerprint: fingerprint({ appServer: "v2", toolRegistry: "current" }), supportsInputSchema: true },
  grok: { protocol: "responses", model: "grok", supportsClientFunctionCalls: true },
  registry: [{ fingerprint: fingerprint({ appServer: "v2", toolRegistry: "current" }), adapter: "codex-v2", requiredCapabilities: { supportsInputSchema: true } }],
  tools,
  invoke: ({ tool, arguments: args, correlation }) => existingCodexAppServerGateway(tool, args, correlation),
});
await relay.listen();
```

The executor can also be isolated behind a newline-delimited JSON-RPC socket:

```js
import { createJsonRpcSocketClient, createSocketExecutor } from "@grok2codex/client-bridge/socket";
const rpc = createJsonRpcSocketClient({ connect: () => connectToDesktopRelaySocket() });
const executor = createSocketExecutor({ rpc, method: "codex/tool/execute" });
```

Each request carries a stable tool ID, validated arguments, and thread/turn
correlation. The socket side owns approvals and app-server access; closing or
timing out the socket fails only the pending tool call.

Before advertising tools, hosts can perform a capability handshake. The
fingerprint registry is owned by the bridge package; an unknown Codex
fingerprint returns `text-only` and never executes a guessed tool schema.
`onStateChange` exposes the call lifecycle (`DISCOVERED`, `VALIDATED`,
`APPROVAL_PENDING`, `EXECUTING`, `RESULT_READY`, or `REJECTED`) for the
renderer and audit sink without exposing tool arguments.

If the host owns the request loop, use `getProviderTools("responses")` or `getProviderTools("chat")` to obtain the correctly shaped declarations. `prepareRequest()` is a convenience that installs the bridge-owned tool list and does not copy arbitrary caller tools into the catalog.

## Boundary rules

The executor remains the source of truth for approvals, workspace roots, sandboxing, cancellation, and auditing. The bridge must be placed between the model transport and that executor; it must not become a second executor. Unknown tools, invalid JSON, schema failures, duplicate names, and unknown fingerprints fail closed.

For catalogs larger than the configured limit, the bridge publishes one `bridge__dispatch` function rather than flattening every namespace into the model request. The dispatcher still resolves only the in-memory approved catalog.

## Development

```sh
npm test
```

The package has no runtime dependencies. Keep provider-specific transports and desktop adapters in the consuming application or separate adapter packages.

## Scope and licensing

This repository is an independent protocol/client library. It contains no vendor credentials, private URLs, internal paths, copied application code, or project-specific deployment configuration. It is released under the MIT License.
