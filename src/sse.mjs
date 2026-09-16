import { randomUUID } from "node:crypto";
import { BridgeError } from "./index.mjs";

// Keep the original wire bytes for untouched events. Protect large numeric
// metadata when a tool event needs rewriting (JSON.parse would round it).
export function parseSseFrame(raw) {
  let event;
  const data = [];
  for (const line of raw.split(/\r\n|\r|\n/)) {
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") event = value;
    if (field === "data") data.push(value);
  }
  const text = data.join("\n");
  const numbers = new Map();
  let value;
  if (text && text !== "[DONE]") {
    const prefix = `__wire_number_${randomUUID()}_`;
    const protectedJson = text.replace(/"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, token => {
      if (token.startsWith('"') || (Number.isFinite(Number(token)) && (!Number.isInteger(Number(token)) || Number.isSafeInteger(Number(token))))) return token;
      const key = prefix + numbers.size;
      numbers.set(key, token);
      return JSON.stringify(key);
    });
    try { value = JSON.parse(protectedJson); } catch {
      throw new BridgeError("upstream_invalid_response", "Upstream sent invalid SSE JSON");
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new BridgeError("upstream_invalid_response", "Upstream SSE data must be an object");
    }
  }
  return { raw, event, data: text, value, numbers };
}

export function rewriteSseFrame(frame, value) {
  let data = JSON.stringify(value);
  for (const [key, literal] of frame?.numbers ?? []) data = data.replaceAll(JSON.stringify(key), literal);
  const extra = (frame?.raw ?? "").split(/\r\n|\r|\n/)
    .filter(line => line && !/^(?:event|data)(?::|$)/.test(line));
  const raw = [...extra, `event: ${value.type}`, `data: ${data}`, "", ""].join("\n");
  return { ...frame, raw, data, value, event: value.type };
}

export function failedSseFrame(error, response = {}, sequence = 0, source) {
  return rewriteSseFrame(source, { type: "response.failed", sequence_number: sequence,
    response: { id: response.id || `resp_${randomUUID().replaceAll("-", "")}`, object: "response",
      created_at: response.created_at ?? Math.floor(Date.now() / 1000), model: response.model,
      status: "failed", output: [], error, incomplete_details: null } });
}

/** Incremental UTF-8/SSE parser. Memory is bounded per frame, not per response. */
export async function* readSseFrames(body, maxFrameBytes = 32 * 1024 * 1024) {
  if (!body?.getReader) throw new BridgeError("upstream_invalid_response", "Upstream stream has no body");
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let scan = 0;
  let lineStart = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      while (scan < buffer.length) {
        const char = buffer[scan];
        if (char !== "\r" && char !== "\n") { scan++; continue; }
        // A CR at a chunk boundary may be the first byte of CRLF.
        if (char === "\r" && scan === buffer.length - 1 && !done) break;
        const end = scan + (char === "\r" && buffer[scan + 1] === "\n" ? 2 : 1);
        if (scan !== lineStart) { scan = lineStart = end; continue; }
        const raw = buffer.slice(0, end);
        buffer = buffer.slice(end);
        scan = lineStart = 0;
        if (Buffer.byteLength(raw) > maxFrameBytes) throw new BridgeError("upstream_invalid_response", "Upstream SSE frame exceeds limit");
        yield parseSseFrame(raw);
      }
      if (Buffer.byteLength(buffer) > maxFrameBytes) throw new BridgeError("upstream_invalid_response", "Upstream SSE frame exceeds limit");
      if (done) {
        if (buffer.trim()) throw new BridgeError("upstream_stream_incomplete", "Upstream closed inside an SSE frame");
        return;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
