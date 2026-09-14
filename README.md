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
