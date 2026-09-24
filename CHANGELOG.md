# Changelog

## Unreleased

- Preserve xAI flat HTTP errors (`{ code, error: "message" }`) through streaming
  and nonstreaming bridges, retaining the original status and redacting secrets.
- Verify native image results and opaque reasoning remain unchanged during
  client-tool history conversion. No automatic request retry is added.

## 0.4.1

- Preserve each request's explicit conversation ID across the shared Grok,
  Gemini and Claude Responses tool bridge, including streaming and tool results.
- Forward a canonical `Session_id` header without sharing mutable session state
  or forwarding client credentials. Never infer conversation identity from
  prompt text or `prompt_cache_key`.

## 0.4.0

- Add `claude2codex` to the shared release, with typed `/claude` and `/claude/relay` exports and root helpers.
- Default the Claude Responses relay to the Antigravity catalog ID `claude-opus-4-6-thinking`, while retaining explicitly selected Claude model IDs and the host's authenticated transport/card-pool routing.
- Reuse incremental streaming, namespaced/custom tool conversion, client-owned execution, cancellation and original error propagation; do not inject Grok image tools.
- Request and preserve opaque reasoning continuation data, with no provider signature fabrication or manual-thinking overrides.
- Preserve the original Anthropic SSE overload frame and classify its supplementary failed terminal for native Codex's model-capacity display.
- Document Claude/Codex protocol references and the separate client integration step; validate streaming tools, real tool-result continuation, HTTP/SSE failures, and the combined delivery archive.

## 0.3.0

- Stream Grok and Gemini Responses incrementally from upstream through the client-owned tool passthrough, including text, reasoning, function arguments, and native image progress.
- Preserve provider SSE error frames, unknown metadata, and failed/incomplete outcomes; append a compatible failed terminal when the provider emits only an error. Detect unexplained early EOF without replaying a request.
- Restore tool identities and custom raw input; release executable tool completion only after a valid successful terminal response. Keep partial tool parsing from hiding a provider failure.
- Propagate cancellation, bound SSE frames and pending tool data, and honor downstream backpressure. Keep explicit nonstreaming requests and JSON-only upstreams compatible.
- Add typed streaming methods and loopback HTTP regressions for both models, interleaved tools, errors, cancellation, and first-delta delivery before generation completes.

## 0.2.2

- Ship the Responses and Gemini native adapters from one repository, version, and archive, with typed native subpath exports.
- Preserve upstream HTTP status, bounded diagnostic messages, valid retry metadata, cancellation, and timeout errors.
- Emit Responses text and tool events with the actual completed, failed, or incomplete terminal state. Report malformed or empty successful responses as upstream errors.
- Keep historical function/custom call results paired while restricting execution to currently advertised tools. Bound generated wire names to 64 characters with a stable hash suffix.
- Preserve existing desktop exports and native Grok image generation.
- Verify the delivered archive, manifest hashes, and both adapters in automated tests, with an optional Windows/Linux CI template.

Gemini native endpoints and OpenAI-compatible Responses endpoints remain separate protocols. Desktop clients that already own tool execution continue to use the Responses passthrough API.
