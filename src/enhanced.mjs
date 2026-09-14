import { createGrokCodexRelay } from "./integration.mjs";

/** Thin host adapter for Codex汉化增强版. It owns no process, credentials, or approvals. */
export function createEnhancedDesktopRelay({ upstream, codex, grok, registry, tools, invoke, onResult, onStateChange, policy, server, bridgeVersion } = {}) {
  return createGrokCodexRelay({ upstream, codex, grok, registry, tools, invoke, onResult, policy: { ...policy, onStateChange }, server, bridgeVersion });
}
