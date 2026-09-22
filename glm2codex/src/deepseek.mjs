import { BridgeError } from "../../src/index.mjs";
import { createBridgeServer } from "../../src/server.mjs";
import { streamClientResponses } from "../../src/responses-stream.mjs";
import { createGLMToolCodec } from "./index.mjs";
import { createResponsesFallbackTransport } from "./http.mjs";
import { responsesToGLMChat } from "./chat-request.mjs";

export const DEEPSEEK_DEFAULT_MODEL = "deepseek-flash";
export const DEEPSEEK_MODELS = Object.freeze(["deepseek-flash", "deepseek-v4-pro"]);
export const DEEPSEEK_API_ORIGIN = "https://api.deepseek.com";
export const isDeepSeekModel = model => DEEPSEEK_MODELS.includes(model);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const invalid = message => { throw new BridgeError("invalid_request", message); };
const unsupported = message => { throw new BridgeError("protocol", message, { status: 400 }); };
const identity = (name, namespace) => JSON.stringify([namespace ?? null, name]);

function validateContent(value, { model, images = false, reasoning = false } = {}) {
  if (!reasoning && typeof value === "string") return;
  if (!Array.isArray(value)) invalid("DeepSeek content must be text or a content-part array");
  for (const part of value) {
    if (!object(part)) invalid("Invalid DeepSeek content part");
    if ((reasoning ? ["reasoning_text"] : ["input_text", "output_text"]).includes(part.type) && typeof part.text === "string") continue;
    if (!reasoning && part.type === "input_image") {
      if (!images || model !== "deepseek-flash") unsupported("DeepSeek images require deepseek-flash user messages or tool outputs");
      const hasUrl = typeof part.image_url === "string" && !!part.image_url;
      const hasFile = typeof part.file_id === "string" && !!part.file_id;
      if (hasUrl === hasFile) invalid("DeepSeek input_image requires exactly one image_url or file_id");
      if (hasUrl && !/^(https?:\/\/|data:image\/(?:jpeg|png|gif|webp);base64,)/i.test(part.image_url)) invalid("Unsupported DeepSeek image source");
      if (hasFile && !part.file_id.startsWith("file-api-")) invalid("DeepSeek image file_id must refer to a DeepSeek uploaded image");
      if (part.detail !== undefined && !["low", "high", "original", "auto"].includes(part.detail)) invalid("Invalid DeepSeek image detail");
      continue;
    }
    unsupported(`DeepSeek cannot preserve content part ${part.type ?? "unknown"}`);
  }
}

/** Native Responses is stateless. Keep the complete explicit history on every turn.
 * DeepSeek demotes developer to user; text-only developer items become system
 * items to retain their instruction authority. Developer images are rejected,
 * because converting them to a supported system image would lose that contract.
 */
export function prepareDeepSeekRequest(request, { model = DEEPSEEK_DEFAULT_MODEL, reasoningEffort = "high" } = {}) {
  if (!object(request)) invalid("DeepSeek request must be an object");
  const result = structuredClone(request);
  result.model ??= model;
  if (!isDeepSeekModel(result.model)) invalid("DeepSeek requires deepseek-flash or deepseek-v4-pro");
  if (result.user_id !== undefined) {
    if (result.user !== undefined && result.user !== result.user_id) invalid("DeepSeek user and user_id must identify the same user");
    result.user = result.user_id;
    delete result.user_id;
  }
  if (result.user !== undefined && typeof result.user !== "string") invalid("DeepSeek user identity must be text");
  for (const field of ["previous_response_id", "conversation", "prompt", "context_management"]) {
    if (result[field] !== undefined && result[field] !== null) unsupported(`DeepSeek cannot resolve ${field}; send the full explicit history`);
  }
  if (result.store === true || result.background === true) unsupported("DeepSeek does not store responses or run background Responses");
  if (result.include?.length) unsupported("DeepSeek does not implement Responses include fields");
  if (result.truncation !== undefined && result.truncation !== "disabled") unsupported("DeepSeek does not implement automatic context truncation");
  if (result.max_tool_calls !== undefined) unsupported("DeepSeek does not implement max_tool_calls");
  if (result.tool_stream !== undefined) unsupported("DeepSeek Responses uses stream, not Chat tool_stream");
  for (const field of ["service_tier", "safety_identifier", "prompt_cache_key", "prompt_cache_retention", "stream_options"]) {
    if (result[field] !== undefined && result[field] !== null) unsupported(`DeepSeek Responses does not implement ${field}`);
  }
  if (result.reasoning?.summary != null && result.reasoning.summary !== "none") unsupported("DeepSeek does not generate Responses reasoning summaries");
  if (result.text?.verbosity !== undefined) unsupported("DeepSeek does not implement Responses text verbosity");
  if (result.reasoning != null && !object(result.reasoning)) invalid("DeepSeek reasoning must be an object");
  if (result.thinking != null && (!object(result.thinking) || !["enabled", "disabled"].includes(result.thinking.type))) invalid("Invalid DeepSeek thinking option");
  const effort = result.reasoning?.effort ?? result.reasoning_effort ?? (result.thinking?.type === "disabled" ? "none" : reasoningEffort);
  const mapped = { none: "none", minimal: "low", low: "low", medium: "high", high: "high", xhigh: "high", max: "max", ultra: "max" }[effort];
  if (!mapped) invalid("Unsupported DeepSeek reasoning effort");
  if (result.thinking?.type === "disabled" && mapped !== "none") invalid("DeepSeek thinking and reasoning options conflict");
  result.reasoning = { ...result.reasoning, effort: mapped };
  delete result.reasoning_effort;
  delete result.thinking;
  if (result.instructions != null && typeof result.instructions !== "string") invalid("DeepSeek instructions must be text");
  if (result.input === undefined && result.instructions == null) invalid("DeepSeek input or instructions is required");

  const catalog = new Map();
  if (result.tools !== undefined && !Array.isArray(result.tools)) invalid("DeepSeek tools must be an array");
  const visit = (tool, namespace, description) => {
    if (!object(tool)) invalid("Invalid DeepSeek tool declaration");
    if (tool.type === "namespace") {
      if (namespace !== undefined || typeof tool.name !== "string" || !tool.name || !Array.isArray(tool.tools)) invalid("Invalid DeepSeek tool namespace");
      for (const child of tool.tools) visit(child, tool.name, tool.description);
      return;
    }
    if (!["function", "custom"].includes(tool.type)) unsupported(`DeepSeek cannot preserve built-in tool ${tool.type ?? "unknown"}; provide a host function adapter`);
    if (typeof tool.name !== "string" || !tool.name) invalid("DeepSeek tool name must be a nonempty string");
    const key = identity(tool.name, namespace);
    if (catalog.has(key)) invalid("Duplicate DeepSeek tool identity");
    catalog.set(key, tool.type);
    if (tool.type === "function") {
      tool.parameters ??= { type: "object", properties: {}, additionalProperties: false };
      if (!object(tool.parameters)) invalid("Function parameters must be a JSON Schema object");
    }
    if (description) tool.description = `${description}\n\n${tool.description ?? tool.name}`;
  };
  for (const tool of result.tools ?? []) visit(tool);
  const choice = result.tool_choice;
  if (choice !== undefined && choice !== null) {
    if (typeof choice === "string") {
      if (!["auto", "none", "required"].includes(choice)) invalid("Invalid DeepSeek tool_choice");
    } else if (!object(choice) || !["function", "custom"].includes(choice.type)
      || catalog.get(identity(choice.name, choice.namespace)) !== choice.type) invalid("DeepSeek tool_choice must identify a currently advertised tool");
  }

  if (result.input !== undefined && typeof result.input !== "string") {
    if (!Array.isArray(result.input)) invalid("DeepSeek input must be text or full input history");
    const seen = new Set(), pending = new Map();
    for (const item of result.input) {
      if (!object(item)) invalid("Invalid DeepSeek history item");
      if (item.encrypted_content !== undefined && item.encrypted_content !== null) unsupported("DeepSeek cannot preserve encrypted provider state");
      switch (item.type ?? "message") {
        case "message":
          if (!["user", "assistant", "system", "developer"].includes(item.role)) invalid("Invalid DeepSeek message role");
          validateContent(item.content, { model: result.model, images: item.role === "user" });
          if (item.reasoning_content !== undefined) unsupported("Use Responses reasoning.content items to preserve DeepSeek reasoning history");
          if (item.role === "developer") item.role = "system";
          break;
        case "reasoning":
          if (item.summary?.length) unsupported("DeepSeek cannot preserve reasoning summaries; full reasoning_text is required");
          validateContent(item.content ?? [], { reasoning: true });
          break;
        case "function_call":
        case "custom_tool_call": {
          if (typeof item.call_id !== "string" || !item.call_id || seen.has(item.call_id)) invalid("Missing or duplicate DeepSeek historical call ID");
          if (typeof item.name !== "string" || !item.name) invalid("Missing DeepSeek historical tool name");
          if (item.type === "custom_tool_call") {
            if (typeof item.input !== "string") invalid("Historical custom input must remain a string");
          } else {
            if (typeof item.arguments !== "string") invalid("Historical function arguments must remain JSON text");
            try { if (!object(JSON.parse(item.arguments))) invalid("Historical function arguments must be an object"); }
            catch { invalid("Historical function arguments must be a JSON object"); }
          }
          seen.add(item.call_id);
          pending.set(item.call_id, `${item.type}_output`);
          break;
        }
        case "function_call_output":
        case "custom_tool_call_output":
          if (pending.get(item.call_id) !== item.type) invalid("Orphan, duplicate or mismatched DeepSeek historical tool result");
          pending.delete(item.call_id);
          validateContent(item.output, { model: result.model, images: true });
          break;
        default: unsupported(`DeepSeek cannot preserve history item ${item.type}`);
      }
    }
    if (pending.size) invalid("DeepSeek full history requires every historical call's result");
  }
  return result;
}

function resolveEndpoint({ baseUrl = DEEPSEEK_API_ORIGIN, responsesPath, chatPath }) {
  let url;
  try { url = new URL(baseUrl); } catch { throw new BridgeError("configuration", "Invalid DeepSeek baseUrl"); }
  if (url.username || url.password || url.search || url.hash || !["http:", "https:"].includes(url.protocol)) {
    throw new BridgeError("configuration", "DeepSeek baseUrl must be HTTP(S) without credentials, query or fragment");
  }
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new BridgeError("configuration", "Non-loopback DeepSeek endpoints require HTTPS");
  const path = url.pathname.replace(/\/+$/, "").replace(/\/responses$/, "");
  const checked = (value, suffix) => {
    if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || /[?#\\\s]/.test(value)
      || value.split("/").includes("..") || !value.endsWith(suffix)) throw new BridgeError("configuration", `DeepSeek endpoint path must stay on the configured host and end in ${suffix}`);
    return value;
  };
  return { baseUrl: url.origin, responsesPath: checked(responsesPath ?? `${path}/responses`, "/responses"),
    chatPath: checked(chatPath ?? `${path}/chat/completions`, "/chat/completions") };
}

/** Chat is used only when the same authority explicitly lacks Responses. */
function responsesToDeepSeekChat(request, options) {
  if (request.top_logprobs !== undefined || request.logprobs === true) unsupported("DeepSeek Chat log probabilities cannot yet be restored to Responses output");
  const effort = request.reasoning?.effort ?? "high";
  if (!["none", "low", "high", "max"].includes(effort)) invalid("DeepSeek Chat requires normalized reasoning effort");
  const forced = request.tool_choice === "required" || object(request.tool_choice);
  if (forced && effort !== "none") unsupported("DeepSeek Chat only supports required or named tool_choice with thinking disabled");
  const choice = request.tool_choice ?? "auto";
  const chat = responsesToGLMChat({ ...request, input: request.input ?? [], tool_choice: choice === "none" ? "auto" : choice },
    { ...options, allowImages: (options.allowImages ?? true) && request.model === "deepseek-flash", supportsToolChoice: effort === "none" });
  delete chat.tool_stream;
  chat.thinking = { type: effort === "none" ? "disabled" : "enabled" };
  if (effort === "none") delete chat.reasoning_effort;
  else chat.reasoning_effort = effort;
  if (choice === "none" && chat.tools?.length) chat.tool_choice = "none";
  if (request.user !== undefined) {
    if (request.user_id !== undefined && request.user_id !== request.user) invalid("DeepSeek user and user_id must identify the same user");
    chat.user_id = structuredClone(request.user);
  }
  return chat;
}

/** Runtime credentials only; fallback shares one deadline and never crosses hosts. */
export function createDeepSeekTransport(options = {}) {
  return createResponsesFallbackTransport(options, { endpoint: resolveEndpoint(options), toChat: responsesToDeepSeekChat });
}

export function createDeepSeekToolPassthrough({ transport, model = DEEPSEEK_DEFAULT_MODEL, reasoningEffort = "high", nativeTools = [], validateCustomInput, onResponse } = {}) {
  if (typeof transport?.complete !== "function" || !isDeepSeekModel(model)) throw new BridgeError("configuration", "DeepSeek transport.complete and a supported default model are required");
  if (nativeTools.length) throw new BridgeError("configuration", "DeepSeek built-in tools require explicit host function adapters");
  const prepare = options => {
    if (options.protocol !== undefined && options.protocol !== "responses") unsupported("DeepSeek client tool bridge requires Responses");
    return createGLMToolCodec(prepareDeepSeekRequest(options.request, { model, reasoningEffort }), { validateCustomInput });
  };
  return {
    async runTurn(options) {
      const codec = prepare(options);
      const result = codec.restore(await transport.complete({ protocol: "responses", request: codec.request, sessionId: options.sessionId }, options.signal));
      try { onResponse?.({ ...(result.status === "failed" || result.status === "incomplete" ? { status: result.status } : {}),
        calls: result.status === "failed" || result.status === "incomplete" || result.error || result.incomplete_details ? []
          : (result.output ?? []).filter(item => ["function_call", "custom_tool_call"].includes(item.type))
            .map(item => ({ type: item.type, name: item.name, namespace: item.namespace, callId: item.call_id })) }); } catch { /* observer only */ }
      return result;
    },
    ...(typeof transport.stream === "function" ? { streamTurn(options) {
      const codec = prepare(options);
      return streamClientResponses(transport.stream({ protocol: "responses", request: codec.request, sessionId: options.sessionId }, options.signal), codec, onResponse);
    } } : {}),
  };
}

export function createDeepSeekCodexRelay({ upstream, model = DEEPSEEK_DEFAULT_MODEL, reasoningEffort = "high", nativeTools = [], validateCustomInput, onResponse, server = {} } = {}) {
  const bridge = createDeepSeekToolPassthrough({ transport: createDeepSeekTransport(upstream), model, reasoningEffort, nativeTools, validateCustomInput, onResponse });
  const relay = createBridgeServer({ ...server, model, bridge, bridgeForRequest(_protocol, request) {
    prepareDeepSeekRequest(request, { model, reasoningEffort });
    return bridge;
  } });
  return { bridge, server: relay, model, protocol: "responses", listen: () => relay.listen(), close: () => relay.close() };
}
