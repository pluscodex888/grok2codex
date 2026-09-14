import { BridgeError } from "./index.mjs";

function socketSend(socket, value) {
  if (typeof socket.write === "function") socket.write(value);
  else if (typeof socket.send === "function") socket.send(value);
  else throw new BridgeError("configuration", "socket must provide write() or send()");
}

function socketClose(socket) {
  if (typeof socket.end === "function") socket.end();
  else if (typeof socket.close === "function") socket.close();
}

/**
 * JSON-RPC 2.0 over newline-delimited socket frames. A caller may inject an
 * already connected socket (TCP, Unix socket, or WebSocket-like adapter) or
 * provide `connect()`; the bridge never owns the Codex process lifecycle.
 */
export function createJsonRpcSocketClient({ socket, connect, timeoutMs = 30_000, onNotification } = {}) {
  if (!socket && typeof connect !== "function") throw new BridgeError("configuration", "socket or connect is required");
  let activeSocket;
  let connectPromise;
  let buffer = "";
  let sequence = 0;
  const pending = new Map();

  const rejectAll = (error) => {
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  };
  const handleFrame = (frame) => {
    if (!frame.trim()) return;
    let message;
    try { message = JSON.parse(frame); } catch { return; }
    if (message.id !== undefined && pending.has(String(message.id))) {
      const entry = pending.get(String(message.id));
      pending.delete(String(message.id));
      if (message.error) entry.reject(new BridgeError("socket_remote", message.error.message || "socket RPC failed", { error: message.error }));
      else entry.resolve(message.result);
      return;
    }
    onNotification?.(message);
  };
  const attach = (value) => {
    activeSocket = value;
    if (!value || typeof value.on !== "function") throw new BridgeError("configuration", "connected socket must provide on()");
    value.on("data", chunk => {
      buffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const frame = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        handleFrame(frame);
      }
    });
    value.on("message", chunk => handleFrame(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk)));
    value.on("error", error => rejectAll(new BridgeError("socket", String(error))));
    value.on("close", () => rejectAll(new BridgeError("socket", "socket closed")));
    return value;
  };
  const ensureConnected = async () => {
    if (activeSocket) return activeSocket;
    connectPromise ??= Promise.resolve(connect()).then(attach).catch(error => {
      connectPromise = undefined;
      throw error;
    });
    return connectPromise;
  };
  if (socket) attach(socket);
  return {
    async request(method, params = {}, signal) {
      const value = await ensureConnected();
      const id = `rpc_${Date.now().toString(36)}_${(++sequence).toString(36)}`;
      const key = String(id);
      const timeout = setTimeout(() => {
        const entry = pending.get(key);
        if (!entry) return;
        pending.delete(key);
        entry.reject(new BridgeError("socket_timeout", `socket request timed out: ${method}`));
      }, timeoutMs);
      return new Promise((resolve, reject) => {
        const onAbort = () => {
          clearTimeout(timeout);
          pending.delete(key);
          reject(new BridgeError("cancelled", `socket request cancelled: ${method}`));
        };
        pending.set(key, {
          resolve: value => { clearTimeout(timeout); signal?.removeEventListener("abort", onAbort); resolve(value); },
          reject: error => { clearTimeout(timeout); signal?.removeEventListener("abort", onAbort); reject(error); },
        });
        signal?.addEventListener("abort", onAbort, { once: true });
        try { socketSend(value, `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`); }
        catch (error) { clearTimeout(timeout); pending.delete(key); reject(error); }
      });
    },
    close() {
      if (activeSocket) socketClose(activeSocket);
      activeSocket = undefined;
      rejectAll(new BridgeError("socket", "socket closed"));
    },
  };
}

export function createSocketExecutor({ rpc, method = "codex/tool/execute" } = {}) {
  if (!rpc || typeof rpc.request !== "function") throw new BridgeError("configuration", "rpc.request is required");
  return {
    async execute(tool, argumentsValue, context = {}) {
      const result = await rpc.request(method, {
        stableId: tool.stableId,
        wireName: tool.wireName,
        arguments: argumentsValue,
        correlation: {
          callId: context.callId ?? null,
          bridgeCallId: context.bridgeCallId ?? null,
          threadId: context.threadId ?? null,
          turnId: context.turnId ?? null,
        },
      }, context.signal);
      return result?.output ?? result;
    },
  };
}
