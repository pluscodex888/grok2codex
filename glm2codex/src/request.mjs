import { BridgeError } from "../../src/index.mjs";

export const GLM_DEFAULT_MODEL = "glm-5.3";
export const GLM_MODELS = Object.freeze(["glm-5.3", "glm-5.3-flash"]);
export const isGLMModel = model => typeof model === "string" && /^glm-[a-z0-9][a-z0-9._-]*$/i.test(model);
const invalid = message => { throw new BridgeError("invalid_request", message); };
const object = value => value && typeof value === "object" && !Array.isArray(value);

/** Preserve every message, role, tool result and opaque state before protocol selection. */
export function prepareGLMRequest(request, { model = GLM_DEFAULT_MODEL, reasoningEffort = "high" } = {}) {
  if (!object(request)) invalid("GLM request must be an object");
  const result = structuredClone(request);
  result.model ??= model;
  if (!isGLMModel(result.model)) invalid("GLM bridge requires an explicit GLM model");
  const effort = result.reasoning?.effort ?? result.reasoning_effort ?? reasoningEffort;
  const mapped = { low: "low", medium: "high", high: "high", xhigh: "max", max: "max" }[effort];
  if (!mapped) invalid("GLM reasoning effort must be low, medium, high, xhigh or max");
  if (result.thinking?.type === "disabled") invalid("Native GLM Responses uses reasoning.effort, not disabled Chat thinking");
  result.reasoning = { ...result.reasoning, effort: mapped };
  delete result.reasoning_effort;
  delete result.thinking;
  if (result.tool_stream !== undefined) invalid("tool_stream is a Chat option; use native Responses stream");
  if (result.tools !== undefined && !Array.isArray(result.tools)) invalid("Tools must be an array");
  const names = new Map();
  const visit = (tool, namespace, namespaceDescription) => {
    if (!object(tool)) invalid("Tool declarations must be objects");
    if (tool.type === "namespace") {
      if (namespace !== undefined || typeof tool.name !== "string" || !tool.name || !Array.isArray(tool.tools)) invalid("Invalid tool namespace");
      for (const child of tool.tools) visit(child, tool.name, tool.description);
    } else if (["function", "custom"].includes(tool.type)) {
      if (typeof tool.name !== "string" || !tool.name) invalid("Tool name must be a nonempty string");
      const key = JSON.stringify([namespace ?? null, tool.name]);
      if (names.has(key)) invalid("Duplicate tool identity in current catalog");
      names.set(key, tool.type);
      if (tool.type === "function" && !object(tool.parameters)) invalid("Function parameters must be a JSON Schema object");
      if (namespaceDescription) tool.description = `${namespaceDescription}\n\n${tool.description ?? tool.name}`;
    } else if (typeof tool.type !== "string") invalid("Tool type is required");
  };
  for (const tool of result.tools ?? []) visit(tool);
  if (["function", "custom"].includes(result.tool_choice?.type)) {
    const choice = result.tool_choice;
    if (typeof choice.name !== "string" || !choice.name || names.get(JSON.stringify([choice.namespace ?? null, choice.name])) !== choice.type) {
      invalid("Selected tool must identify an advertised tool in its original namespace");
    }
  }
  return result;
}
