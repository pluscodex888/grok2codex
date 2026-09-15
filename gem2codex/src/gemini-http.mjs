import { BridgeError } from "./index.mjs";

const asObject = value => value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};

function joinUrl(baseUrl, path) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  if (!base) throw new BridgeError("configuration", "baseUrl is required");
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

function errorMessage(body, status, statusText) {
  const root = asObject(body);
  const error = asObject(root.error);
  return String(error.message || root.message || statusText || `Gemini request failed (${status})`);
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
      const abort = () => controller.abort(signal?.reason);
      const timer = setTimeout(() => controller.abort(new Error("Gemini request timeout")), timeoutMs);
      signal?.addEventListener("abort", abort, { once: true });
      try {
        const url = joinUrl(baseUrl, `/models/${encodeURIComponent(selectedModel)}:generateContent`);
        const response = await fetchImpl(url, {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/json", ...(apiKey ? { "x-goog-api-key": apiKey } : {}), ...headers },
          body: JSON.stringify({ ...asObject(request), model: undefined }),
          signal: controller.signal,
        });
        const text = await response.text();
        let body;
        try { body = text ? JSON.parse(text) : {}; } catch { throw new BridgeError("upstream", `Gemini returned non-JSON (${response.status})`, { status: response.status }); }
        if (!response.ok) throw new BridgeError("upstream", errorMessage(body, response.status, response.statusText), { status: response.status, body });
        return body;
      } catch (error) {
        if (error instanceof BridgeError) throw error;
        if (controller.signal.aborted) throw new BridgeError("timeout", "Gemini request timed out or was cancelled", { cause: String(error) });
        throw new BridgeError("upstream", String(error));
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      }
    },
  };
}
