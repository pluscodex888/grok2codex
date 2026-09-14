import { createGrokCodexRelay } from "./integration.mjs";

export function isGrokModel(model) {
  return typeof model === "string" && /^grok(?:[-_:./]|$)/i.test(model.trim());
}

/** Thin host adapter for Codex汉化增强版. It owns no process, credentials, or approvals. */
export function createEnhancedDesktopRelay({ upstream, codex, grok = {}, registry, tools, invoke, onResult, onStateChange, policy, server, bridgeVersion, enabled = true } = {}) {
  const modelEnabled = typeof enabled === "function" ? enabled(grok.model) : enabled === true;
  const active = modelEnabled && isGrokModel(grok.model);
  const relay = createGrokCodexRelay({
    upstream, codex, grok: { ...grok, supportsClientFunctionCalls: active && grok.supportsClientFunctionCalls === true },
    registry: active ? registry : [], tools: active ? tools : [], invoke, onResult,
    policy: { ...policy, onStateChange }, server, bridgeVersion,
  });
  return { ...relay, enabled: active, disabledReason: active ? undefined : (modelEnabled ? "non_grok_model" : "disabled_in_settings") };
}
