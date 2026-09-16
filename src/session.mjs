import { BridgeError } from "./index.mjs";

const headerNames = ["session_id", "session-id", "x-codex-session-id", "x-codex-thread-id", "x-session-id", "x-openai-conversation-id", "openai-conversation-id"];
const bodyNames = ["session_id", "sessionId", "codex_session_id", "codexSessionId", "thread_id", "threadId", "codex_thread_id", "codexThreadId", "conversation_id", "conversationId"];

export function validateSessionId(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > 128 || /[^\x21-\x7e]|[/\\?#]/.test(value)) {
    throw new BridgeError("invalid_request", "Invalid session identifier");
  }
  return value;
}

/** Only explicit conversation identity is eligible; cache keys/content are not IDs. */
export function resolveSessionId(headers, body) {
  const entries = headers instanceof Headers ? [...headers] : Object.entries(headers ?? {});
  for (const name of headerNames) {
    const matches = entries.filter(([key]) => key.toLowerCase() === name).flatMap(([, value]) => Array.isArray(value) ? value : [value]);
    if (matches.length > 1) throw new BridgeError("invalid_request", "Ambiguous session identifier");
    if (matches.length) {
      const id = validateSessionId(matches[0]);
      if (id) return id;
    }
  }
  for (const record of [body, body?.metadata, body?.client_metadata, body?.responsesapiClientMetadata]) {
    if (!record || typeof record !== "object" || Array.isArray(record)) continue;
    for (const name of bodyNames) {
      const id = validateSessionId(record[name]);
      if (id) return id;
    }
  }
  return undefined;
}

/** Return fresh headers on every request; never mutate shared transport options. */
export function sessionHeaders(headers, sessionId, request) {
  const id = validateSessionId(sessionId) ?? resolveSessionId(undefined, request);
  if (!id) return { ...headers };
  const result = Object.fromEntries(Object.entries(headers).filter(([key]) => !headerNames.includes(key.toLowerCase())));
  result.Session_id = id;
  return result;
}
