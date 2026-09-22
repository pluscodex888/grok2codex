import { BridgeError } from "../../src/index.mjs";
const invalid = message => { throw new BridgeError("invalid_request", message); };
const unsupported = message => { throw new BridgeError("protocol", message, { status: 400 }); };

function content(value, images = false) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) invalid("Message/tool content must be text or content parts");
  const parts = value.map(part => {
    if (["input_text", "output_text", "text"].includes(part?.type) && typeof part.text === "string") return { type: "text", text: part.text };
    if (part?.type === "refusal" && typeof part.refusal === "string") return { type: "text", text: part.refusal };
    if (images && part?.type === "input_image" && typeof part.image_url === "string") return { type: "image_url", image_url: { url: part.image_url, ...(part.detail ? { detail: part.detail } : {}) } };
    unsupported(`Cannot preserve content part ${part?.type ?? "unknown"} in GLM Chat`);
  });
  return parts.every(part => part.type === "text") ? parts.map(part => part.text).join("\n") : parts;
}

/** Receives the shared codec's function-wire request, never the unencoded catalog. */
export function responsesToGLMChat(request, { stream = false, allowImages = false, supportsToolChoice = false } = {}) {
  for (const field of ["previous_response_id", "conversation", "prompt", "context_management"]) {
    if (request[field] !== undefined && request[field] !== null) unsupported(`GLM Chat cannot resolve ${field}; explicit full history is required`);
  }
  if (request.store === true || request.background === true) unsupported("GLM Chat does not implement stored/background Responses");
  if (request.text?.format && request.text.format.type !== "text") unsupported("GLM Chat cannot preserve this structured output format");
  if (request.reasoning?.summary && request.reasoning.summary !== "none") unsupported("GLM Chat cannot generate the requested Responses reasoning summary");
  if (request.text?.verbosity !== undefined || request.max_tool_calls !== undefined) unsupported("GLM Chat cannot preserve verbosity or built-in tool execution limits");
  const tools = (request.tools ?? []).map(tool => {
    if (tool.type !== "function") unsupported(`Cannot preserve built-in tool ${tool.type} in GLM Chat; configure an explicit host adapter`);
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(tool.name)) invalid("GLM tool wire name must fit 64 safe characters");
    return { type: "function", function: { name: tool.name, description: tool.description ?? tool.name,
      parameters: structuredClone(tool.parameters), ...(tool.strict === undefined ? {} : { strict: tool.strict }) } };
  });
  if (tools.length > 128) invalid("GLM supports at most 128 function declarations");
  const choice = request.tool_choice ?? "auto";
  if (choice !== "auto" && choice !== "none" && !supportsToolChoice) unsupported("GLM endpoint only documents automatic tool selection");
  const messages = [];
  if (request.instructions !== undefined && request.instructions !== null) {
    if (typeof request.instructions !== "string") invalid("Instructions must be a string");
    messages.push({ role: "system", content: request.instructions });
  }
  const items = typeof request.input === "string" ? [{ role: "user", content: request.input }] : request.input;
  if (!Array.isArray(items)) invalid("Responses input must be a string or array");
  const pending = new Set(), seen = new Set(), deferred = [];
  let assistant, outputsStarted = false;
  const assistantMessage = () => {
    if (!assistant) { assistant = { role: "assistant", content: "" }; messages.push(assistant); }
    return assistant;
  };
  const appendMessage = item => {
    const role = item.role === "developer" ? "system" : item.role;
    if (!["system", "assistant", "user"].includes(role)) invalid("Invalid message role");
    const text = content(item.content, allowImages && role === "user");
    if (role === "assistant") {
      const target = assistantMessage();
      if (typeof text !== "string") unsupported("Assistant content must be text");
      target.content += (target.content && text ? "\n" : "") + text;
    } else { assistant = undefined; messages.push({ role, content: text }); }
  };
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) invalid("Invalid history item");
    switch (item.type ?? "message") {
      case "function_call": {
        if (outputsStarted) invalid("New call inside an unfinished result batch");
        if (typeof item.call_id !== "string" || !item.call_id || seen.has(item.call_id)) invalid("Missing/duplicate call ID");
        if (typeof item.name !== "string" || !item.name || typeof item.arguments !== "string") invalid("Invalid historical call");
        try { JSON.parse(item.arguments); } catch { invalid("Historical call arguments must be JSON"); }
        seen.add(item.call_id); pending.add(item.call_id);
        (assistantMessage().tool_calls ??= []).push({ id: item.call_id, type: "function", function: { name: item.name, arguments: item.arguments } });
        break;
      }
      case "function_call_output":
        if (!pending.delete(item.call_id)) invalid("Orphan/duplicate tool result");
        outputsStarted = true;
        messages.push({ role: "tool", tool_call_id: item.call_id, content: content(item.output) });
        if (!pending.size) { assistant = undefined; outputsStarted = false; for (const message of deferred.splice(0)) appendMessage(message); }
        break;
      case "reasoning": {
        if (item.encrypted_content) unsupported("Encrypted provider state cannot be converted to GLM Chat");
        if (pending.size && outputsStarted) unsupported("Reasoning inside a partial tool-result batch is ambiguous");
        const parts = item.content ?? [];
        if (item.summary?.length && !parts.length) unsupported("Reasoning summary alone cannot replace original provider reasoning in GLM Chat");
        if (!Array.isArray(parts) || parts.some(part => part?.type !== "reasoning_text" || typeof part.text !== "string")) unsupported("Unsupported reasoning representation");
        if (parts.length) { const target = assistantMessage(); target.reasoning_content = (target.reasoning_content ?? "") + parts.map(part => part.text).join(""); }
        break;
      }
      case "message": if (pending.size) deferred.push(item); else appendMessage(item); break;
      default: unsupported(`Cannot preserve history item ${item.type} in GLM Chat`);
    }
  }
  if (pending.size) invalid("Every historical call must have its matching result");
  if (!messages.length) invalid("GLM request has no messages");
  const result = { model: request.model, messages, stream,
    thinking: { type: "enabled", clear_thinking: false }, reasoning_effort: request.reasoning?.effort ?? "high" };
  for (const field of ["temperature", "top_p", "stop", "request_id", "user_id", "do_sample"]) {
    if (request[field] !== undefined) result[field] = structuredClone(request[field]);
  }
  if (request.max_output_tokens !== undefined) result.max_tokens = request.max_output_tokens;
  if (tools.length && choice !== "none") {
    result.tools = tools;
    result.tool_choice = typeof choice === "object" ? { type: "function", function: { name: choice.name } } : choice;
    if (stream) result.tool_stream = true;
  }
  return result;
}
