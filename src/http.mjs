import { BridgeError } from "./index.mjs";

function asObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function joinUrl(baseUrl, path) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  if (!base) throw new BridgeError("configuration", "baseUrl is required");
  if (/\/v1$/.test(base) && path.startsWith("/v1/")) return `${base}${path.slice(3)}`;
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

function errorMessage(body, status, statusText) {
  const record = asObject(body);
  const error = asObject(record.error);
  return String(error.message || record.message || statusText || `upstream request failed (${status})`);
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
} = {}) {
  if (typeof fetchImpl !== "function") throw new BridgeError("configuration", "fetch is required");
  return {
    async complete({ protocol, request }, signal) {
      if (protocol !== "responses" && protocol !== "chat") {
        throw new BridgeError("protocol", `unsupported protocol: ${protocol}`);
      }
      const controller = new AbortController();
      const onAbort = () => controller.abort(signal?.reason);
      const timer = setTimeout(() => controller.abort(new Error("upstream timeout")), timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const path = protocol === "responses" ? responsesPath : chatPath;
        const outgoing = { ...asObject(request), stream: false };
        const requestHeaders = {
          accept: "application/json",
          "content-type": "application/json",
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
          ...headers,
        };
        const response = await fetchImpl(joinUrl(baseUrl, path), {
          method: "POST",
          headers: requestHeaders,
          body: JSON.stringify(outgoing),
          signal: controller.signal,
        });
        const text = await response.text();
        let body;
        try { body = text ? JSON.parse(text) : {}; } catch {
          throw new BridgeError("upstream", `upstream returned non-JSON (${response.status})`, { status: response.status });
        }
        if (!response.ok) {
          throw new BridgeError("upstream", errorMessage(body, response.status, response.statusText), {
            status: response.status,
            body,
          });
        }
        return body;
      } catch (error) {
        if (error instanceof BridgeError) throw error;
        if (controller.signal.aborted) {
          throw new BridgeError("timeout", "upstream request timed out or was cancelled", { cause: String(error) });
        }
        throw new BridgeError("upstream", String(error));
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}