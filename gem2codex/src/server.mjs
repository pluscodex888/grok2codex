import { createServer } from "node:http";
import { BridgeError } from "./index.mjs";
import { relayHttpError, safeErrorCode } from "../../src/http-errors.mjs";

const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const writeJson = (res, status, body, extraHeaders = {}) => { res.writeHead(status, { ...headers, ...extraHeaders }); res.end(JSON.stringify(body)); };

const nativeErrorStatuses = {
  400: "INVALID_ARGUMENT", 401: "UNAUTHENTICATED", 403: "PERMISSION_DENIED", 404: "NOT_FOUND",
  409: "ABORTED", 429: "RESOURCE_EXHAUSTED", 499: "CANCELLED", 500: "INTERNAL",
  501: "UNIMPLEMENTED", 502: "UNAVAILABLE", 503: "UNAVAILABLE", 504: "DEADLINE_EXCEEDED",
};

async function readBody(req, maxBytes) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > maxBytes) throw new BridgeError("request_too_large", "request body exceeds configured limit"); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { throw new BridgeError("invalid_request", "request body is not valid JSON"); }
}

function streamResponse(body) {
  const candidate = body?.candidates?.[0];
  const chunk = { ...body, candidates: candidate ? [candidate] : [] };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

export function createGeminiCodexServer({ bridge, host = "127.0.0.1", port = 0, model = "gemini-2.5-flash", maxBodyBytes = 2 * 1024 * 1024, context, authorize } = {}) {
  if (!bridge || typeof bridge.runTurn !== "function") throw new BridgeError("configuration", "bridge is required");
  const server = createServer(async (req, res) => {
    const requestAbort = new AbortController();
    const abort = () => requestAbort.abort(new Error("Gemini client disconnected"));
    const onClose = () => { if (!res.writableEnded) abort(); };
    req.once("aborted", abort);
    res.once("close", onClose);
    try {
      if (typeof authorize === "function" && !(await authorize(req))) return writeJson(res, 401, { error: { message: "unauthorized", status: "UNAUTHENTICATED" } });
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      if (req.method === "GET" && url.pathname === "/healthz") return writeJson(res, 200, { ok: true });
      if (req.method === "GET" && url.pathname === "/v1beta/models") return writeJson(res, 200, { models: [{ name: `models/${model}`, supportedGenerationMethods: ["generateContent", "streamGenerateContent"] }] });
      const match = url.pathname.match(/^\/v1beta\/models\/([^:]+):(generateContent|streamGenerateContent)$/);
      if (req.method !== "POST" || !match) return writeJson(res, 404, { error: { message: "not found", status: "NOT_FOUND" } });
      const body = await readBody(req, maxBodyBytes);
      const result = await bridge.runTurn({ request: { ...body, model: match[1] }, context: typeof context === "function" ? await context(req, body) : context, signal: requestAbort.signal });
      if (requestAbort.signal.aborted || res.destroyed) return;
      if (match[2] === "streamGenerateContent") { res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive" }); res.end(streamResponse(result)); }
      else writeJson(res, 200, result);
    } catch (error) {
      if (requestAbort.signal.aborted || res.destroyed || res.writableEnded) return;
      const e = error instanceof BridgeError ? error : new BridgeError("internal_error", String(error));
      const result = relayHttpError(e);
      writeJson(res, result.status, { error: {
        code: result.status,
        message: result.error.message,
        status: safeErrorCode(e.details?.nativeStatus) ?? nativeErrorStatuses[result.status] ?? "UNKNOWN",
        ...(result.error.param ? { param: result.error.param } : {}),
      } }, result.headers);
    } finally {
      req.off("aborted", abort);
      res.off("close", onClose);
    }
  });
  return {
    server,
    async listen() { await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, resolve); }); const address = server.address(); return { host, port: typeof address === "object" && address ? address.port : port }; },
    async close() { if (!server.listening) return; await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); },
  };
}
