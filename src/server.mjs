import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
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
  const output = body.output.map(item => ({
    ...item,
    id: item.id || `item_${randomUUID().replaceAll("-", "")}`,
    ...(item.type === "message" || item.type === "function_call" || item.type === "custom_tool_call"
      ? { status: item.status ?? (body.status === "completed" ? "completed" : "incomplete") } : {}),
  }));
  const response = { ...body, output };
  const events = [];
  const emit = (type, details) => events.push({ type, sequence_number: events.length, ...details });
  const pending = { ...response, status: "in_progress", output: [], error: null, incomplete_details: null };
  emit("response.created", { response: pending });
  emit("response.in_progress", { response: pending });
  output.forEach((item, output_index) => {
    const location = { response_id: id, item_id: item.id, output_index };
    const added = { ...item };
    if (item.type === "message") { added.content = []; added.status = "in_progress"; }
    if (item.type === "function_call") { added.arguments = ""; added.status = "in_progress"; }
    if (item.type === "custom_tool_call") { added.input = ""; added.status = "in_progress"; }
    emit("response.output_item.added", { response_id: id, output_index, item: added });
    if (item.type === "message") {
      for (const [content_index, part] of (item.content ?? []).entries()) {
        const contentLocation = { ...location, content_index };
        const initialPart = { ...part };
        if (part.type === "output_text") { initialPart.text = ""; initialPart.annotations = []; }
        if (part.type === "refusal") initialPart.refusal = "";
        emit("response.content_part.added", { ...contentLocation, part: initialPart });
        if (part.type === "output_text") {
          emit("response.output_text.delta", { ...contentLocation, delta: part.text ?? "", logprobs: part.logprobs ?? [] });
          for (const [annotation_index, annotation] of (part.annotations ?? []).entries()) {
            emit("response.output_text.annotation.added", { ...contentLocation, annotation_index, annotation });
          }
          emit("response.output_text.done", { ...contentLocation, text: part.text ?? "", logprobs: part.logprobs ?? [] });
        } else if (part.type === "refusal") {
          emit("response.refusal.delta", { ...contentLocation, delta: part.refusal ?? "" });
          emit("response.refusal.done", { ...contentLocation, refusal: part.refusal ?? "" });
        }
        emit("response.content_part.done", { ...contentLocation, part });
      }
    } else if (item.type === "function_call" || item.type === "custom_tool_call") {
      const custom = item.type === "custom_tool_call";
      const event = custom ? "response.custom_tool_call_input" : "response.function_call_arguments";
      const field = custom ? "input" : "arguments";
      if (typeof item[field] === "string") emit(`${event}.delta`, { ...location, delta: item[field] });
      // Never turn a partial or failed generation into an executable tool call.
      if (body.status !== "completed") return;
      emit(`${event}.done`, { ...location, [field]: item[field], name: item.name });
    }
    emit("response.output_item.done", { response_id: id, output_index, item });
  });
  emit(`response.${body.status}`, { response });
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
      const upstreamResult = await requestBridge.runTurn({ protocol, request: { ...body, model: body.model || model }, context: typeof context === "function" ? await context(req, body) : context, signal: requestAbort.signal });
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
      if (!res.destroyed) json(res, failure.status, { error: failure.error }, failure.headers);
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
