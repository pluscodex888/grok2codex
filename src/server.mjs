import { createServer } from "node:http";
import { resolveSessionId } from "./session.mjs";
import { once } from "node:events";
import { responseSse } from "./response-events.mjs";
import { failedSseFrame, rewriteSseFrame } from "./sse.mjs";
import { BridgeError } from "./index.mjs";
import { normalizeResponsesBody } from "./http.mjs";
import { relayHttpError } from "./http-errors.mjs";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

function json(res, status, body, headers = {}) {
  res.writeHead(status, { ...JSON_HEADERS, ...headers });
  res.end(JSON.stringify(body));
}

async function readBody(req, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new BridgeError("request_too_large", "request body exceeds configured limit");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  try { return text ? JSON.parse(text) : {}; } catch {
    throw new BridgeError("invalid_request", "request body is not valid JSON");
  }
}

/**
 * Start a localhost-compatible relay. The host supplies a bridge whose
 * executor is already connected to its Codex/app-server approval path.
 * Nothing in this module executes commands or reads local files.
 */
export function createBridgeServer({
  bridge,
  host = "127.0.0.1",
  port = 0,
  model = "grok",
  maxBodyBytes = 2 * 1024 * 1024,
  context,
  bridgeForRequest,
} = {}) {
  if (!bridge || typeof bridge.runTurn !== "function") throw new BridgeError("configuration", "bridge is required");
  const server = createServer(async (req, res) => {
    const requestAbort = new AbortController();
    const abortRequest = () => requestAbort.abort(new Error("client disconnected"));
    let streamIdentity = {};
    let lastSequence = -1;
    req.once("aborted", abortRequest);
    res.once("close", () => {
      if (!res.writableEnded) abortRequest();
    });
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      if (req.method === "GET" && url.pathname === "/healthz") return json(res, 200, { ok: true });
      if (req.method === "GET" && url.pathname === "/v1/models") {
        return json(res, 200, { object: "list", data: [{ id: model, object: "model", owned_by: "grok2codex" }] });
      }
      const protocol = url.pathname === "/v1/responses"
        ? "responses"
        : url.pathname === "/v1/chat/completions"
          ? "chat"
          : null;
      if (req.method !== "POST" || !protocol) return json(res, 404, { error: { message: "not found", type: "not_found" } });
      const body = await readBody(req, maxBodyBytes);
      const requestBridge = typeof bridgeForRequest === "function"
        ? await bridgeForRequest(protocol, body)
        : bridge;
      if (!requestBridge || typeof requestBridge.runTurn !== "function") {
        throw new BridgeError("configuration", "bridgeForRequest must return a bridge");
      }
      const options = { protocol, request: { ...body, model: body.model || model }, sessionId: resolveSessionId(req.headers, body), context: typeof context === "function" ? await context(req, body) : context, signal: requestAbort.signal };
      if (body.stream === true && protocol === "responses" && typeof requestBridge.streamTurn === "function") {
        for await (const frame of requestBridge.streamTurn(options)) {
          requestAbort.signal.throwIfAborted();
          if (!res.headersSent) {
            res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no" });
          }
          if (frame.value?.response?.id) streamIdentity = frame.value.response;
          if (Number.isSafeInteger(frame.value?.sequence_number)) lastSequence = Math.max(lastSequence, frame.value.sequence_number);
          if (!res.write(frame.raw)) await once(res, "drain", { signal: requestAbort.signal });
        }
        res.end();
        return;
      }
      const upstreamResult = await requestBridge.runTurn(options);
      const result = protocol === "responses" ? normalizeResponsesBody(upstreamResult) : upstreamResult;
      if (body.stream === true) {
        const stream = responseSse(protocol, result);
        res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive" });
        res.end(stream);
      } else {
        json(res, 200, result);
      }
    } catch (error) {
      const bridgeError = error instanceof BridgeError ? error : new BridgeError("internal_error", String(error));
      const failure = relayHttpError(bridgeError);
      if (!res.destroyed && !requestAbort.signal.aborted) {
        if (res.headersSent) {
          res.write(rewriteSseFrame(null, { type: "error", error: failure.error, sequence_number: ++lastSequence }).raw);
          res.end(failedSseFrame(failure.error, streamIdentity, ++lastSequence).raw);
        } else json(res, failure.status, { error: failure.error }, failure.headers);
      }
    }
  });
  return {
    server,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, resolve);
      });
      const address = server.address();
      return { host, port: typeof address === "object" && address ? address.port : port };
    },
    async close() {
      if (!server.listening) return;
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}
