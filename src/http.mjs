import { BridgeError } from "./index.mjs";
import { safeErrorCode, safeErrorMessage, upstreamHttpError } from "./http-errors.mjs";
import { readSseFrames } from "./sse.mjs";
import { sessionHeaders } from "./session.mjs";

function asObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function joinUrl(baseUrl, path) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  if (!base) throw new BridgeError("configuration", "baseUrl is required");
  if (/\/v1$/.test(base) && path.startsWith("/v1/")) return `${base}${path.slice(3)}`;
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

export function normalizeResponsesBody(value, { secrets = [] } = {}) {
  const body = asObject(value);
  if (typeof body.id !== "string" || !body.id || (body.object !== undefined && body.object !== "response")
    || !Array.isArray(body.output)) {
    throw new BridgeError("upstream_invalid_response", "Upstream did not return a Responses object");
  }
  const status = body.error ? "failed" : body.incomplete_details ? "incomplete" : body.status ?? "completed";
  if (!["completed", "failed", "incomplete"].includes(status)) {
    throw new BridgeError("upstream_invalid_response", "Buffered upstream response has no terminal status");
  }
  for (const item of body.output) {
    if (!item || typeof item !== "object" || typeof item.type !== "string") {
      throw new BridgeError("upstream_invalid_response", "Upstream returned an invalid output item");
    }
    if (item.type === "message" && (!Array.isArray(item.content) || item.content.some(part =>
      !part || typeof part.type !== "string" || part.type === "output_text" && typeof part.text !== "string"
      || part.type === "refusal" && typeof part.refusal !== "string"))) {
      throw new BridgeError("upstream_invalid_response", "Upstream returned invalid message content");
    }
    if (status === "completed" && (item.type === "function_call" || item.type === "custom_tool_call")
      && (typeof item.call_id !== "string" || !item.call_id || typeof item.name !== "string" || !item.name
        || typeof item[item.type === "function_call" ? "arguments" : "input"] !== "string"
        || item.status !== undefined && item.status !== "completed")) {
      throw new BridgeError("upstream_invalid_response", "Upstream returned an incomplete client tool call");
    }
  }
  const hasOutput = body.output.some(item => item.type === "message"
    ? Array.isArray(item.content) && item.content.some(part => part && (
      typeof part.text === "string" && part.text.length > 0 || typeof part.refusal === "string" && part.refusal.length > 0
      || typeof part.type === "string" && !["output_text", "refusal"].includes(part.type)))
    : item.type !== "reasoning");
  if (status === "completed" && !hasOutput) {
    throw new BridgeError("upstream_empty_response", "Upstream completed without a message or tool result");
  }
  const result = { ...body, object: "response", status };
  if (body.error) {
    const code = safeErrorCode(body.error.code) ?? "upstream_error";
    result.error = { code, message: safeErrorMessage(body.error.message, secrets) ?? `Upstream response failed (${code}).` };
  }
  return result;
}

/**
 * A small OpenAI-compatible transport. It intentionally receives credentials
 * at runtime and never logs or persists them. The bridge controls the tool
 * catalog; this adapter only sends the current protocol request upstream.
 */
export function createOpenAITransport({
  baseUrl,
  apiKey,
  headers = {},
  fetchImpl = globalThis.fetch,
  timeoutMs = 120_000,
  responsesPath = "/v1/responses",
  chatPath = "/v1/chat/completions",
  maxSSEFrameBytes = 32 * 1024 * 1024,
} = {}) {
  if (typeof fetchImpl !== "function") throw new BridgeError("configuration", "fetch is required");
  if (!Number.isSafeInteger(maxSSEFrameBytes) || maxSSEFrameBytes <= 0) throw new BridgeError("configuration", "maxSSEFrameBytes must be a positive integer");
  return {
    async *stream({ protocol, request, sessionId }, signal) {
      if (protocol !== "responses") throw new BridgeError("protocol", "Streaming transport requires Responses");
      const scopedHeaders = sessionHeaders(headers, sessionId, request);
      const controller = new AbortController();
      let abortKind;
      const abort = () => {
        if (controller.signal.aborted) return;
        abortKind = "cancelled";
        controller.abort(signal?.reason);
      };
      const timer = setTimeout(() => {
        if (controller.signal.aborted) return;
        abortKind = "timeout";
        controller.abort(new Error("upstream timeout"));
      }, timeoutMs);
      signal?.addEventListener("abort", abort, { once: true });
      const requestHeaders = new Headers({ "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}), ...scopedHeaders });
      requestHeaders.set("accept", "text/event-stream");
      const secrets = [apiKey, ...Array.from(requestHeaders)
        .filter(([key]) => /authorization|key|token|cookie|secret/i.test(key))
        .map(([, value]) => String(value))].filter(Boolean);
      try {
        if (signal?.aborted) abort();
        controller.signal.throwIfAborted();
        const response = await fetchImpl(joinUrl(baseUrl, responsesPath), {
          method: "POST", headers: requestHeaders,
          body: JSON.stringify({ ...asObject(request), stream: true }), signal: controller.signal,
        });
        const sse = /^text\/event-stream(?:;|$)/i.test(response.headers.get("content-type") ?? "");
        if (!response.ok || !sse) {
          const text = await response.text();
          controller.signal.throwIfAborted();
          let body;
          try { body = JSON.parse(text); } catch {
            if (response.ok) throw new BridgeError("upstream_invalid_response", "Upstream returned neither SSE nor JSON");
          }
          if (!response.ok) {
            const details = upstreamHttpError(response, body, { secrets });
            throw new BridgeError("upstream", details.message, details);
          }
          // Legacy providers may ignore stream=true. Preserve compatibility
          // with that one response, without retrying or double billing.
          yield { buffered: normalizeResponsesBody(body, { secrets }) };
          return;
        }
        yield* readSseFrames(response.body, maxSSEFrameBytes);
      } catch (error) {
        if (controller.signal.aborted) {
          const timeout = abortKind === "timeout";
          throw new BridgeError(timeout ? "timeout" : "cancelled", timeout ? "Upstream request timed out" : "Request was cancelled",
            { status: timeout ? 504 : 499 });
        }
        if (error instanceof BridgeError) throw error;
        throw new BridgeError("upstream", safeErrorMessage(String(error), secrets) ?? "Upstream stream failed");
      } finally {
        controller.abort();
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      }
    },
    async complete({ protocol, request, sessionId }, signal) {
      if (protocol !== "responses" && protocol !== "chat") {
        throw new BridgeError("protocol", `unsupported protocol: ${protocol}`);
      }
      const scopedHeaders = sessionHeaders(headers, sessionId, request);
      const controller = new AbortController();
      const onAbort = () => controller.abort(signal?.reason);
      const timer = setTimeout(() => controller.abort(new Error("upstream timeout")), timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        if (signal?.aborted) { onAbort(); throw signal.reason ?? new Error("request cancelled"); }
        const path = protocol === "responses" ? responsesPath : chatPath;
        const outgoing = { ...asObject(request), stream: false };
        const requestHeaders = {
          accept: "application/json",
          "content-type": "application/json",
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
          ...scopedHeaders,
        };
        const response = await fetchImpl(joinUrl(baseUrl, path), {
          method: "POST",
          headers: requestHeaders,
          body: JSON.stringify(outgoing),
          signal: controller.signal,
        });
        const text = await response.text();
        const secrets = [apiKey, ...Object.entries(requestHeaders)
          .filter(([key]) => /authorization|key|token|cookie|secret/i.test(key))
          .map(([, value]) => String(value))].filter(Boolean);
        let body;
        try { body = text ? JSON.parse(text) : {}; } catch {
          if (response.ok) throw new BridgeError("upstream_invalid_response", "Upstream returned non-JSON");
          const details = upstreamHttpError(response, undefined);
          throw new BridgeError("upstream", details.message, details);
        }
        if (!response.ok) {
          const details = upstreamHttpError(response, body, { secrets });
          throw new BridgeError("upstream", details.message, details);
        }
        return protocol === "responses" ? normalizeResponsesBody(body, { secrets }) : body;
      } catch (error) {
        if (error instanceof BridgeError) throw error;
        if (controller.signal.aborted) {
          throw signal?.aborted
            ? new BridgeError("cancelled", "Request was cancelled", { status: 499 })
            : new BridgeError("timeout", "Upstream request timed out", { status: 504 });
        }
        throw new BridgeError("upstream", safeErrorMessage(String(error), [apiKey]) ?? "Upstream request failed");
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}
