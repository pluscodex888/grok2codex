import { createServer } from "node:http";
import { createBridge, BridgeError } from "./index.mjs";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

function json(res, status, body) {
  res.writeHead(status, JSON_HEADERS);
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

function responseModel(body, fallback) {
  return typeof body?.model === "string" ? body.model : fallback;
}

function responseSse(protocol, body) {
  const id = body?.id || `${protocol}-${Date.now()}`;
  const model = responseModel(body, "grok");
  if (protocol === "chat") {
    const message = body?.choices?.[0]?.message || { role: "assistant", content: "" };
    const chunks = [
      { id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
      { id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: message, finish_reason: null }] },
      { id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: {}, finish_reason: body?.choices?.[0]?.finish_reason || "stop" }], usage: body?.usage },
    ];
    return `${chunks.map(item => `data: ${JSON.stringify(item)}\n\n`).join("")}data: [DONE]\n\n`;
  }
  const output = Array.isArray(body?.output) ? body.output : [];
  const events = [];
  events.push({ type: "response.created", response: { ...body, status: "in_progress" } });
  output.forEach((item, index) => events.push({
    type: item?.type === "message" ? "response.output_item.done" : "response.output_item.done",
    output_index: index,
    item,
  }));
  events.push({ type: "response.completed", response: body });
  return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
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
      const result = await requestBridge.runTurn({ protocol, request: { ...body, model: body.model || model }, context: typeof context === "function" ? await context(req, body) : context, signal: requestAbort.signal });
      if (body.stream === true) {
        res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive" });
        res.end(responseSse(protocol, result));
      } else {
        json(res, 200, result);
      }
    } catch (error) {
      const bridgeError = error instanceof BridgeError ? error : new BridgeError("internal_error", String(error));
      const status = bridgeError.code === "invalid_request" || bridgeError.code === "request_too_large" ? 400
        : bridgeError.code === "permission_denied" ? 403
          : bridgeError.code === "upstream" ? 502
            : 500;
      json(res, status, { error: { message: bridgeError.message, type: bridgeError.code, code: bridgeError.code } });
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
