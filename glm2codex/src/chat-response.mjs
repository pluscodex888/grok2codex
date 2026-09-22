import { randomUUID } from "node:crypto";
import { BridgeError } from "../../src/index.mjs";
import { rewriteSseFrame } from "../../src/sse.mjs";

const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const newId = prefix => `${prefix}_${randomUUID().replaceAll("-", "")}`;
const invalid = message => new BridgeError("upstream_invalid_response", message);

function textField(value, name) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw invalid(`GLM ${name} must be a string`);
  return value;
}

function envelope(body, model) {
  if (body.id !== undefined && (typeof body.id !== "string" || !body.id)) throw invalid("GLM response ID is invalid");
  if (body.model !== undefined && typeof body.model !== "string") throw invalid("GLM response model is invalid");
  return { id: body.id ?? newId("resp"), object: "response", created_at: body.created ?? Math.floor(Date.now() / 1000),
    model: body.model ?? model, status: "in_progress", output: [], error: null, incomplete_details: null };
}

function usageToResponses(usage) {
  if (usage == null) return undefined;
  if (!object(usage)) throw invalid("GLM usage must be an object");
  const { prompt_tokens, completion_tokens, total_tokens, prompt_tokens_details, completion_tokens_details, ...extra } = usage;
  return { ...extra, ...(prompt_tokens !== undefined ? { input_tokens: prompt_tokens } : {}),
    ...(completion_tokens !== undefined ? { output_tokens: completion_tokens } : {}),
    ...(total_tokens !== undefined ? { total_tokens } : {}),
    ...(prompt_tokens_details !== undefined ? { input_tokens_details: prompt_tokens_details } : {}),
    ...(completion_tokens_details !== undefined ? { output_tokens_details: completion_tokens_details } : {}) };
}

function outcome(reason) {
  if (reason === "stop" || reason === "tool_calls") return { status: "completed", incomplete_details: null };
  if (reason === "length" || reason === "content_filter") {
    return { status: "incomplete", incomplete_details: { reason: reason === "length" ? "max_output_tokens" : reason } };
  }
  throw invalid("GLM response has a missing or unsupported finish_reason");
}

function validateCalls(calls, complete) {
  const seen = new Set();
  for (const call of calls) {
    if (call.call_id) {
      if (seen.has(call.call_id)) throw invalid("GLM returned duplicate tool call IDs");
      seen.add(call.call_id);
    }
    if (!complete) continue;
    if (!call.call_id || !call.name) throw invalid("GLM returned a tool call without an ID or name");
    try { JSON.parse(call.arguments); } catch { throw new BridgeError("invalid_tool_call", "GLM function arguments are not complete JSON"); }
  }
}

function validateCompleted(response, finishReason) {
  if (response.status !== "completed") return;
  const calls = response.output.filter(item => item.type === "function_call");
  if (finishReason === "tool_calls" && !calls.length) throw invalid("GLM finished with tool_calls but returned no tool calls");
  if (!calls.length && !response.output.some(item => item.type === "message" && item.content.some(part => part.text || part.refusal))) {
    throw new BridgeError("upstream_empty_response", "GLM completed without a message or tool result");
  }
}

function providerError(body) {
  if (body.error === undefined || body.error === null) return undefined;
  if (object(body.error)) return { ...body.error };
  if (typeof body.error === "string") return { ...(body.code !== undefined ? { code: body.code } : {}), message: body.error };
  throw invalid("GLM error payload is invalid");
}

function choiceOf(body, allowUsageOnly = false) {
  if (!Array.isArray(body.choices) || body.choices.length !== 1 && !(allowUsageOnly && body.choices.length === 0 && body.usage != null)) {
    throw invalid("GLM must return exactly one completion choice");
  }
  const choice = body.choices[0];
  if (choice && (!object(choice) || choice.index !== undefined && choice.index !== 0)) throw invalid("GLM returned an unsupported choice index");
  return choice;
}

/** Convert one terminal Chat completion, retaining provider call IDs and raw reasoning. */
export function chatCompletionToResponses(body, { model } = {}) {
  if (!object(body)) throw invalid("GLM completion must be an object");
  const response = envelope(body, model);
  const error = providerError(body);
  if (error) return { ...response, status: "failed", error };
  const choice = choiceOf(body);
  const message = choice.message;
  if (!object(message) || message.role !== undefined && message.role !== "assistant") throw invalid("GLM completion has no assistant message");
  Object.assign(response, outcome(choice.finish_reason));
  const reasoning = textField(message.reasoning_content, "reasoning_content");
  const text = textField(message.content, "content");
  const refusal = textField(message.refusal, "refusal");
  if (reasoning) response.output.push({ id: newId("rs"), type: "reasoning", status: response.status,
    content: [{ type: "reasoning_text", text: reasoning }], summary: [] });
  if (text || refusal) response.output.push({ id: message.id ?? newId("msg"), type: "message", role: "assistant", status: response.status,
    content: [...(text ? [{ type: "output_text", text, annotations: [] }] : []), ...(refusal ? [{ type: "refusal", refusal }] : [])] });
  if (message.function_call !== undefined) throw invalid("Legacy GLM function_call responses are unsupported");
  if (message.tool_calls !== undefined && !Array.isArray(message.tool_calls)) throw invalid("GLM tool_calls must be an array");
  const calls = (message.tool_calls ?? []).map(call => {
    if (!object(call) || call.type !== "function" || !object(call.function)) throw invalid("GLM returned an unsupported tool call");
    return { id: newId("fc"), type: "function_call", call_id: textField(call.id, "tool call ID"),
      name: textField(call.function.name, "function name"), arguments: textField(call.function.arguments, "function arguments"), status: response.status };
  });
  validateCalls(calls, response.status === "completed");
  response.output.push(...calls);
  const usage = usageToResponses(body.usage);
  if (usage !== undefined) response.usage = usage;
  validateCompleted(response, choice.finish_reason);
  return response;
}

/**
 * Text/reasoning stream immediately. Tool names and arguments are held because
 * GLM may fragment either field and interleave indexes. Every tool is validated
 * before releasing any tool event, after BOTH finish_reason and the real [DONE].
 * EOF, provider errors and incomplete responses never release executable tools.
 */
export async function* streamGLMChatResponses(frames, { model, maxResponseBytes = DEFAULT_MAX_BYTES } = {}) {
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) throw new BridgeError("configuration", "maxResponseBytes must be a positive integer");
  let response, finishReason, sequence = 0, bytes = 0, source;
  const calls = new Map();
  const parts = new Map();
  const numbers = new Map();
  const emit = (type, details, frame = source) => rewriteSseFrame({ ...frame, numbers }, { type, sequence_number: sequence++, ...details });
  const itemLocation = part => ({ response_id: response.id, item_id: part.item.id, output_index: part.index });

  for await (const frame of frames) {
    source = frame;
    bytes += Buffer.byteLength(frame.raw ?? frame.data ?? JSON.stringify(frame.value ?? {}));
    if (bytes > maxResponseBytes) throw invalid("GLM streamed response exceeds limit");
    for (const [key, value] of frame.numbers ?? []) numbers.set(key, value);
    if (frame.data === "[DONE]") {
      if (!response || finishReason === undefined) throw new BridgeError("upstream_stream_incomplete", "GLM sent [DONE] without a finish_reason");
      const terminal = { ...response, ...outcome(finishReason), output: response.output.map(item => ({ ...item, status: outcome(finishReason).status })) };
      const toolItems = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => ({ ...call, status: terminal.status }));
      validateCalls(toolItems, terminal.status === "completed");
      terminal.output.push(...toolItems);
      validateCompleted(terminal, finishReason);
      // Validate all parallel calls before emitting even the first completion.
      for (const part of parts.values()) {
        const location = { ...itemLocation(part), content_index: part.contentIndex };
        const content = part.item.content[part.contentIndex];
        const kind = content.type === "reasoning_text" ? "reasoning_text" : content.type === "refusal" ? "refusal" : "output_text";
        yield emit(`response.${kind}.done`, { ...location, [kind === "refusal" ? "refusal" : "text"]: content.text ?? content.refusal });
        yield emit("response.content_part.done", { ...location, part: { ...content } });
      }
      for (const [output_index, item] of terminal.output.entries()) {
        if (item.type === "function_call") {
          if (terminal.status !== "completed") continue;
          const location = { response_id: response.id, item_id: item.id, output_index };
          yield emit("response.output_item.added", { response_id: response.id, output_index, item: { ...item, arguments: "", status: "in_progress" } });
          yield emit("response.function_call_arguments.delta", { ...location, delta: item.arguments });
          yield emit("response.function_call_arguments.done", { ...location, arguments: item.arguments, name: item.name });
        }
        yield emit("response.output_item.done", { response_id: response.id, output_index, item });
      }
      yield emit(`response.${terminal.status}`, { response: terminal });
      return;
    }
    const body = frame.value;
    if (!body) { yield frame; continue; }
    if (!object(body)) throw invalid("GLM stream chunk must be an object");
    const error = providerError(body);
    if (error || body.type === "error" || frame.event === "error") {
      const failure = error ?? { ...body };
      response ??= envelope(body, model);
      yield emit("error", { error: failure });
      yield emit("response.failed", { response: { ...response, status: "failed", output: response.output.map(item => ({ ...item, status: "incomplete" })), error: failure } });
      return;
    }
    const choice = choiceOf(body, true);
    if (!response) {
      response = envelope(body, model);
      yield emit("response.created", { response: { ...response, output: [] } });
      yield emit("response.in_progress", { response: { ...response, output: [] } });
    } else if (body.id !== undefined && body.id !== response.id || body.model !== undefined && body.model !== response.model) {
      throw invalid("GLM response identity changed during streaming");
    }
    const usage = usageToResponses(body.usage);
    if (usage !== undefined) response.usage = usage;
    if (!choice) continue;
    if (finishReason !== undefined) throw invalid("GLM sent a choice after finish_reason");
    const delta = choice.delta;
    // DeepSeek's documented terminal delta carries role:null: this means no
    // role update, just like an omitted role, not a non-assistant message.
    if (!object(delta) || delta.role != null && delta.role !== "assistant") throw invalid("GLM stream chunk has no assistant delta");
    if (delta.function_call !== undefined) throw invalid("Legacy GLM function_call deltas are unsupported");
    if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
      outcome(choice.finish_reason);
      finishReason = choice.finish_reason;
    }
    for (const [field, type, kind] of [["reasoning_content", "reasoning_text", "reasoning"], ["content", "output_text", "message"], ["refusal", "refusal", "message"]]) {
      const chunk = textField(delta[field], field);
      if (!chunk) continue;
      let part = parts.get(field);
      if (!part) {
        let item = response.output.find(value => value.type === kind);
        if (!item) {
          item = { id: newId(kind === "reasoning" ? "rs" : "msg"), type: kind, status: "in_progress", content: [],
            ...(kind === "reasoning" ? { summary: [] } : { role: "assistant" }) };
          response.output.push(item);
          yield emit("response.output_item.added", { response_id: response.id, output_index: response.output.length - 1, item: { ...item, content: [] } });
        }
        const content = { type, ...(type === "refusal" ? { refusal: "" } : { text: "" }), ...(type === "output_text" ? { annotations: [] } : {}) };
        part = { item, index: response.output.indexOf(item), contentIndex: item.content.length };
        item.content.push(content);
        parts.set(field, part);
        yield emit("response.content_part.added", { ...itemLocation(part), content_index: part.contentIndex, part: { ...content } });
      }
      part.item.content[part.contentIndex][type === "refusal" ? "refusal" : "text"] += chunk;
      yield emit(`response.${type}.delta`, { ...itemLocation(part), content_index: part.contentIndex, delta: chunk });
    }
    if (delta.tool_calls !== undefined && !Array.isArray(delta.tool_calls)) throw invalid("GLM tool_calls delta must be an array");
    for (const fragment of delta.tool_calls ?? []) {
      if (!object(fragment) || !Number.isSafeInteger(fragment.index) || fragment.index < 0
        || fragment.type !== undefined && fragment.type !== "function" || fragment.function !== undefined && !object(fragment.function)) {
        throw invalid("GLM returned an invalid indexed tool delta");
      }
      let call = calls.get(fragment.index);
      if (!call) {
        call = { id: newId("fc"), type: "function_call", call_id: "", name: "", arguments: "" };
        calls.set(fragment.index, call);
      }
      const id = textField(fragment.id, "tool call ID");
      if (id) {
        if (call.call_id && call.call_id !== id) throw invalid("GLM tool call ID changed during streaming");
        call.call_id = id;
      }
      call.name += textField(fragment.function?.name, "function name");
      call.arguments += textField(fragment.function?.arguments, "function arguments");
    }
  }
  throw new BridgeError("upstream_stream_incomplete", "GLM stream closed without finish_reason and [DONE]");
}
