import { BridgeError } from "../../src/index.mjs";
import { createOpenAITransport } from "../../src/http.mjs";
import { safeErrorMessage, upstreamHttpError } from "../../src/http-errors.mjs";
import { sessionHeaders } from "../../src/session.mjs";
import { readSseFrames } from "../../src/sse.mjs";
import { responsesToGLMChat } from "./chat-request.mjs";
import { chatCompletionToResponses, streamGLMChatResponses } from "./chat-response.mjs";

export const GLM_ENDPOINTS = Object.freeze({ domestic: "https://open.bigmodel.cn/api/v1", overseas: "https://api.z.ai/api/paas/v4" });

/** Resolve on the configured authority only; never probe another host with a key. */
export function resolveGLMEndpoint({ region = "domestic", baseUrl, responsesPath, chatPath } = {}) {
  if (!["domestic", "overseas", "gateway"].includes(region)) throw new BridgeError("configuration", "Unknown GLM endpoint region");
  if (region === "gateway" && !baseUrl) throw new BridgeError("configuration", "A self-hosted GLM gateway requires baseUrl");
  let url;
  try { url = new URL(baseUrl ?? GLM_ENDPOINTS[region]); } catch { throw new BridgeError("configuration", "Invalid GLM baseUrl"); }
  if (url.username || url.password || url.search || url.hash || !["http:", "https:"].includes(url.protocol)) {
    throw new BridgeError("configuration", "GLM baseUrl must be an HTTP(S) URL without credentials, query or fragment");
  }
  if (url.protocol !== "https:" && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new BridgeError("configuration", "Non-loopback GLM endpoints require HTTPS");
  const basePath = url.pathname.replace(/\/+$/, "").replace(/\/responses$/, "");
  const domestic = url.hostname === "open.bigmodel.cn" && ["", "/api/paas/v4", "/api/v1"].includes(basePath);
  const checked = (path, suffix) => {
    if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") || /[?#\\\s]/.test(path)
      || path.split("/").includes("..") || !path.endsWith(suffix)) throw new BridgeError("configuration", `Endpoint path must stay on the configured host and end in ${suffix}`);
    return path;
  };
  const native = checked(responsesPath ?? (domestic ? "/api/v1/responses" : `${basePath}/responses`), "/responses");
  const chat = checked(chatPath ?? (domestic ? "/api/paas/v4/chat/completions" : `${basePath}/chat/completions`), "/chat/completions");
  return { baseUrl: url.origin, responsesPath: native, chatPath: chat, url: `${url.origin}${native}` };
}

/** Only an explicit endpoint/protocol absence permits the single Chat fallback. */
export function isGLMResponsesUnsupported(error) {
  if (!(error instanceof BridgeError) || error.code !== "upstream") return false;
  const { status, code, type, message = "", param } = error.details ?? {};
  if (param || /auth|permission|policy|safety|cyber|billing|quota|model|api.?key|access.?denied/i.test(`${code ?? ""} ${type ?? ""} ${message}`)) return false;
  if (status === 400) return ["unsupported_endpoint", "unsupported_protocol", "responses_not_supported"].includes(code);
  if (![404, 405, 501].includes(status)) return false;
  if (["not_found", "route_not_found", "endpoint_not_found", "unsupported_endpoint", "unsupported_protocol", "responses_not_supported", "not_implemented"].includes(code)) return true;
  // Some OpenAI-compatible gateways (including the overseas GLM endpoint)
  // return the generic `{code: "upstream_error", message: "Not Found"}`
  // envelope for an unimplemented Responses route. Treat only this exact
  // route-level message as protocol absence; model/auth/policy 404s remain
  // errors and must never be retried through Chat Completions.
  return status === 404 && code === "upstream_error" && /^not found$/i.test(String(message).trim());
}

export function createGLMTransport(options = {}) {
  return createResponsesFallbackTransport(options, { endpoint: resolveGLMEndpoint(options), toChat: responsesToGLMChat });
}

/** Shared wire transport. Provider adapters own endpoint and request semantics. */
export function createResponsesFallbackTransport(options, { endpoint, toChat }) {
  const mode = options.upstreamProtocol ?? "auto";
  if (!["auto", "responses", "chat"].includes(mode)) throw new BridgeError("configuration", "upstreamProtocol must be auto, responses or chat");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const transport = createOpenAITransport({ ...options, ...endpoint, fetchImpl: (url, init) => fetchImpl(url, { ...init, redirect: "error" }) });
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new BridgeError("configuration", "timeoutMs must be positive");
  const check = input => {
    if (input.protocol !== "responses") throw new BridgeError("protocol", "GLM adapter exposes Responses to clients", { status: 400 });
    return input;
  };
  const notify = (protocol, reason) => {
    try { options.onProtocol?.({ protocol, reason }); } catch { /* observer only */ }
  };
  const deadline = signal => {
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort(signal.reason);
    if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(new Error("GLM request timeout")); }, timeoutMs);
    return { signal: controller.signal, finish() { clearTimeout(timer); signal?.removeEventListener("abort", abort); },
      error(error) {
        if (timedOut) return new BridgeError("timeout", "Upstream request timed out", { status: 504 });
        if (signal?.aborted) return new BridgeError("cancelled", "Request was cancelled", { status: 499 });
        return error;
      } };
  };
  const chatRequest = (input, stream, originalError) => {
    try { return toChat(input.request, { stream, allowImages: options.allowImages, supportsToolChoice: options.supportsToolChoice }); }
    catch (error) {
      if (originalError) {
        // Keep the actual upstream denial/status. Do not hide dropped capability.
        originalError.details = { ...originalError.details, fallback_unavailable: error.message };
        throw originalError;
      }
      throw error;
    }
  };
  async function* chatFrames(input, request, signal) {
    const headers = new Headers({ "content-type": "application/json", accept: "text/event-stream",
      ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}), ...sessionHeaders(options.headers ?? {}, input.sessionId, input.request) });
    const secrets = [options.apiKey, ...Array.from(headers).filter(([name]) => /authorization|key|token|cookie|secret/i.test(name)).map(([, value]) => value)].filter(Boolean);
    try {
      signal.throwIfAborted();
      const response = await fetchImpl(`${endpoint.baseUrl}${endpoint.chatPath}`, { method: "POST", headers,
        body: JSON.stringify(request), signal, redirect: "error" });
      const sse = /^text\/event-stream(?:;|$)/i.test(response.headers.get("content-type") ?? "");
      if (!response.ok || !sse) {
        let body;
        try { body = JSON.parse(await response.text()); } catch {
          if (response.ok) throw new BridgeError("upstream_invalid_response", "GLM returned neither JSON nor SSE");
        }
        signal.throwIfAborted();
        if (!response.ok) { const details = upstreamHttpError(response, body, { secrets }); throw new BridgeError("upstream", details.message, details); }
        yield { buffered: chatCompletionToResponses(body, { model: request.model }) };
      } else yield* streamGLMChatResponses(readSseFrames(response.body, options.maxSSEFrameBytes), { model: request.model });
    } catch (error) {
      if (error instanceof BridgeError || signal.aborted) throw error;
      throw new BridgeError("upstream", safeErrorMessage(String(error), secrets) ?? "GLM stream failed");
    }
  }
  return {
    async complete(input, signal) {
      check(input);
      const budget = deadline(signal);
      try {
        let error;
        if (mode !== "chat") {
          notify("responses", "preferred");
          try {
            const result = await transport.complete(input, budget.signal);
            budget.signal.throwIfAborted();
            return result;
          } catch (caught) {
            if (mode !== "auto" || !isGLMResponsesUnsupported(caught)) throw caught;
            error = caught;
          }
        }
        const request = chatRequest(input, false, error);
        budget.signal.throwIfAborted();
        notify("chat", error ? "responses_unsupported" : "explicit");
        const result = await transport.complete({ ...input, protocol: "chat", request }, budget.signal);
        budget.signal.throwIfAborted();
        return chatCompletionToResponses(result, { model: request.model });
      } catch (error) { throw budget.error(error); } finally { budget.finish(); }
    },
    async *stream(input, signal) {
      check(input);
      const budget = deadline(signal);
      try {
        let error, emitted = false;
        if (mode !== "chat") {
          notify("responses", "preferred");
          try {
            for await (const frame of transport.stream(input, budget.signal)) { budget.signal.throwIfAborted(); emitted = true; yield frame; }
            return;
          } catch (caught) {
            if (mode !== "auto" || emitted || !isGLMResponsesUnsupported(caught)) throw caught;
            error = caught;
          }
        }
        const request = chatRequest(input, true, error);
        budget.signal.throwIfAborted();
        notify("chat", error ? "responses_unsupported" : "explicit");
        for await (const frame of chatFrames(input, request, budget.signal)) { budget.signal.throwIfAborted(); yield frame; }
      } catch (error) { throw budget.error(error); } finally { budget.finish(); }
    },
  };
}
