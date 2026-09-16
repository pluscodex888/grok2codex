import { BridgeError } from "./index.mjs";
import { normalizeResponsesBody } from "./http.mjs";
import { responseSse } from "./response-events.mjs";
import { parseSseFrame, rewriteSseFrame, failedSseFrame } from "./sse.mjs";
import { isDeepStrictEqual } from "node:util";

/** Translate only client tool events. All other provider events pass through. */
export async function* streamClientResponses(frames, codec, onResponse) {
  const tools = new Map();
  const pending = [];
  let response = {};
  let providerError;
  let errorFrame;
  let sequence = -1;
  let pendingBytes = 0;
  let toolProtocolError;
  const emit = (frame, value = frame.value) => {
    if (!value) return frame;
    const next = Math.max(sequence + 1, Number.isSafeInteger(value.sequence_number) ? value.sequence_number : 0);
    sequence = next;
    if (value === frame.value && value.sequence_number === next) return frame;
    return rewriteSseFrame(frame, { ...value, type: value.type ?? frame.event, sequence_number: next });
  };
  const notify = result => {
    // Observability callbacks cannot replace a provider terminal event.
    try {
      onResponse?.({ ...(result.status !== "completed" ? { status: result.status } : {}),
        calls: (result.status === "completed" ? result.output ?? [] : [])
          .filter(item => /^(custom_tool_call|function_call)$/.test(item.type))
          .map(item => ({ type: item.type, name: item.name, namespace: item.namespace, callId: item.call_id })) });
    } catch { /* Response delivery does not depend on the host's observer. */ }
  };
  const defer = frame => {
    pendingBytes += Buffer.byteLength(frame.raw);
    if (pendingBytes > 32 * 1024 * 1024) throw new BridgeError("upstream_invalid_response", "Pending tool completion exceeds limit");
    pending.push(frame);
  };
  try {
    for await (const frame of frames) {
      if (frame.buffered) {
        const result = codec.restore(frame.buffered);
        notify(result);
        for (const raw of responseSse("responses", result).match(/[^]*?\n\n/g) ?? []) yield emit(parseSseFrame(raw));
        return;
      }
      const event = frame.value;
      if (!event) {
        if (frame.data === "[DONE]") break;
        yield frame; // Includes upstream keepalive comments; no fake text.
        continue;
      }
      const type = event.type ?? frame.event;
      if (event.response?.id) response = { id: event.response.id, model: event.response.model, created_at: event.response.created_at };
      if (type === "error" || type === "response.error" || ((!type || type === "message") && event.error)) {
        providerError = event.error ?? event.response?.error ?? { ...event, type: event.error_type ?? "server_error" };
        errorFrame = frame;
        // Preserve the provider's original error frame, including unknown
        // fields, IDs and numeric lexemes, regardless of tool translation.
        if (Number.isSafeInteger(event.sequence_number)) sequence = Math.max(sequence, event.sequence_number);
        yield frame;
        continue;
      }
      if (type === "response.failed" || type === "response.incomplete") {
        notify({ ...event.response, status: type.slice(9) });
        yield emit(frame);
        return;
      }
      if (type === "response.completed") {
        if (providerError) break; // Never turn an earlier error into success.
        const result = codec.restore(normalizeResponsesBody(event.response));
        if (result.status !== "completed") {
          notify(result);
          yield emit(frame, { ...event, type: `response.${result.status}`, response: result });
          return;
        }
        for (const item of result.output) {
          if (item.type === "function_call") {
            try { JSON.parse(item.arguments); } catch { throw new BridgeError("invalid_tool_call", "function arguments are not complete JSON"); }
          }
        }
        if (toolProtocolError) throw toolProtocolError;
        // Validate every held call before releasing any executable completion.
        // Failed/incomplete generations never decode partial custom arguments.
        const completed = new Map(result.output.map(item => [item.id, item]));
        const translated = pending.flatMap(held => {
          const value = held.value;
          const item = completed.get(value.item_id ?? value.item?.id);
          const source = value.item ?? { ...tools.get(value.item_id)?.item,
            arguments: value.arguments ?? tools.get(value.item_id)?.arguments };
          const restored = codec.restoreItem(source);
          if (!item || restored.type !== item.type || restored.call_id !== item.call_id
            || restored.name !== item.name || restored.namespace !== item.namespace
            || (item.type === "custom_tool_call" ? restored.input !== item.input
              : !isDeepStrictEqual(JSON.parse(restored.arguments), JSON.parse(item.arguments)))) {
            throw new BridgeError("invalid_tool_call", "Tool completion differs from the terminal response");
          }
          if (value.type === "response.output_item.done") return [rewriteSseFrame(held, { ...value, item })];
          if (item.type !== "custom_tool_call") return [rewriteSseFrame(held, { ...value, name: item.name })];
          const { arguments: ignored, ...rest } = value;
          return [
            rewriteSseFrame(held, { ...rest, type: "response.custom_tool_call_input.delta", delta: item.input }),
            rewriteSseFrame(held, { ...rest, type: "response.custom_tool_call_input.done", input: item.input, name: item.name }),
          ];
        });
        // Tool completion is held until the whole response is confirmed.
        // Text/reasoning/native-tool progress is never held behind this queue.
        notify(result);
        for (const held of translated) yield emit(held);
        yield emit(frame, { ...event, response: result });
        return;
      }
      if (providerError) continue;
      if (type === "response.output_item.added" && event.item?.type === "function_call") {
        let item;
        try { item = codec.restoreItem(event.item, true); } catch (error) { toolProtocolError ??= error; }
        tools.set(event.item.id, { item: event.item, restored: item, arguments: event.item.arguments ?? "" });
        if (item) yield emit(frame, { ...event, item });
      } else if (/^response.function_call_arguments\.(delta|done)$/.test(type)) {
        const tool = tools.get(event.item_id);
        if (!tool) {
          toolProtocolError ??= new BridgeError("upstream_invalid_response", "Tool arguments arrived before its output item");
          continue;
        }
        if (type.endsWith(".delta")) {
          tool.arguments += event.delta ?? "";
          if (Buffer.byteLength(tool.arguments) > 32 * 1024 * 1024) throw new BridgeError("upstream_invalid_response", "Tool arguments exceed limit");
          if (tool.restored?.type === "function_call") yield emit(frame);
        } else {
          defer(frame);
        }
      } else if (type === "response.output_item.done" && event.item?.type === "function_call") {
        defer(frame);
      } else yield emit(frame);
    }
  } catch (error) {
    // A socket error after a real provider error must not hide that error.
    if (!providerError) throw error;
  }
  if (providerError) {
    const failure = failedSseFrame(providerError, response, sequence + 1, errorFrame);
    notify(failure.value.response);
    yield failure;
    return;
  }
  throw new BridgeError("upstream_stream_incomplete", "Upstream stream closed without a terminal response event");
}
