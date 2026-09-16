import { BridgeError } from "./index.mjs";
import { safeErrorCode, safeErrorMessage, upstreamHttpError } from "../../src/http-errors.mjs";

const asObject = value => value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};

function joinUrl(baseUrl, path) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  if (!base) throw new BridgeError("configuration", "baseUrl is required");
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

/** Transport for the official Gemini generateContent REST API. */
export function createGeminiTransport({
  baseUrl = "https://generativelanguage.googleapis.com/v1beta",
  apiKey,
  headers = {},
  fetchImpl = globalThis.fetch,
  timeoutMs = 120_000,
} = {}) {
  if (typeof fetchImpl !== "function") throw new BridgeError("configuration", "fetch is required");
  return {
    async complete({ request, model, signal } = {}) {
      const selectedModel = String(model || request?.model || "").replace(/^models\//, "");
      if (!selectedModel) throw new BridgeError("configuration", "model is required");
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
        controller.abort(new Error("Gemini request timeout"));
      }, timeoutMs);
      signal?.addEventListener("abort", abort, { once: true });
      const requestHeaders = { accept: "application/json", "content-type": "application/json", ...(apiKey ? { "x-goog-api-key": apiKey } : {}), ...headers };
      const secrets = [apiKey, ...Object.entries(requestHeaders)
        .filter(([key]) => /authorization|key|token|cookie|secret/i.test(key))
        .map(([, value]) => String(value))].filter(Boolean);
      try {
        if (signal?.aborted) abort();
        controller.signal.throwIfAborted();
        const url = joinUrl(baseUrl, `/models/${encodeURIComponent(selectedModel)}:generateContent`);
        const response = await fetchImpl(url, {
          method: "POST",
          headers: requestHeaders,
          body: JSON.stringify({ ...asObject(request), model: undefined }),
          signal: controller.signal,
        });
        const text = await response.text();
        controller.signal.throwIfAborted();
        let body;
        try { body = text ? JSON.parse(text) : {}; } catch {
          const details = upstreamHttpError(response, undefined);
          throw new BridgeError(response.ok ? "upstream_invalid_response" : "upstream", details.message, details);
        }
        if (!response.ok) {
          const details = upstreamHttpError(response, body, { secrets });
          const nativeStatus = safeErrorCode(body?.error?.status);
          if (nativeStatus) details.nativeStatus = nativeStatus;
          throw new BridgeError("upstream", details.message, details);
        }
        return body;
      } catch (error) {
        if (controller.signal.aborted) {
          const timedOut = abortKind === "timeout";
          throw new BridgeError(timedOut ? "timeout" : "cancelled",
            timedOut ? "Gemini request timed out" : "Gemini request cancelled",
            { status: timedOut ? 504 : 499 });
        }
        if (error instanceof BridgeError) throw error;
        throw new BridgeError("upstream", safeErrorMessage(String(error), secrets) ?? "Gemini transport failed");
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      }
    },
  };
}
