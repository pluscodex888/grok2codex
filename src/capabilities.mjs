import { createHash } from "node:crypto";
import { BridgeError } from "./index.mjs";

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}

export function fingerprint(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex")}`;
}

export function createHandshake({ bridgeVersion = "0.4.1", codex = {}, grok = {} } = {}) {
  if (!codex.fingerprint || typeof codex.fingerprint !== "string") {
    throw new BridgeError("handshake", "codex fingerprint is required");
  }
  return {
    bridgeVersion,
    codex: {
      appServerProtocol: codex.appServerProtocol || "unknown",
      cliVersion: codex.cliVersion || "unknown",
      fingerprint: codex.fingerprint,
      supportsDynamicToolNamespaces: codex.supportsDynamicToolNamespaces === true,
      supportsInputSchema: codex.supportsInputSchema === true,
      supportsParallelToolCalls: codex.supportsParallelToolCalls === true,
    },
    grok: {
      protocol: grok.protocol || "responses",
      model: grok.model || "unknown",
      supportsClientFunctionCalls: grok.supportsClientFunctionCalls === true,
      supportsParallelToolCalls: grok.supportsParallelToolCalls === true,
    },
  };
}

/**
 * Unknown Codex fingerprints fail closed for tools. Text requests may still
 * proceed, which keeps the bridge optional for an enhanced desktop client.
 */
export function negotiateCapabilities(handshake, registry = []) {
  const fingerprintValue = handshake?.codex?.fingerprint;
  const exact = registry.find(item => item?.fingerprint === fingerprintValue);
  if (!exact) return { enabled: false, mode: "text-only", reason: "unknown_codex_fingerprint" };
  if (!handshake?.grok?.supportsClientFunctionCalls) {
    return { enabled: false, mode: "text-only", reason: "grok_client_tools_unsupported", adapter: exact.adapter };
  }
  const required = exact.requiredCapabilities || {};
  for (const [key, expected] of Object.entries(required)) {
    if (handshake.codex[key] !== expected) {
      return { enabled: false, mode: "text-only", reason: `missing_${key}`, adapter: exact.adapter };
    }
  }
  return { enabled: true, mode: "tools", adapter: exact.adapter, fingerprint: fingerprintValue };
}
