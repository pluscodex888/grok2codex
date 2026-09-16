# Changelog

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
