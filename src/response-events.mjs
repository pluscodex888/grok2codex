import { randomUUID } from "node:crypto";

function responseModel(body, fallback) {
  return typeof body?.model === "string" ? body.model : fallback;
}

export function responseSse(protocol, body) {
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

