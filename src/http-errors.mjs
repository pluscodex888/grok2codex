// Shared by protocol adapters. No bridge class, credentials, or response bodies
// cross this boundary: only bounded, redacted error text and retry metadata.
export function safeErrorCode(value) {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : undefined;
}

function safeErrorParam(value) {
  return typeof value === "string" && /^[A-Za-z_$/][A-Za-z0-9_.$/\[\]-]{0,191}$/.test(value) ? value : undefined;
}

export function safeRetryAfter(value) {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (/^\d{1,15}$/.test(text) && Number.isSafeInteger(Number(text))) return text;
  if (/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(text)
    && Number.isFinite(Date.parse(text))) return text;
  return undefined;
}

function errorStatus(value) {
  return Number.isInteger(value) && value >= 400 && value <= 599 ? value : undefined;
}

export function safeErrorMessage(value, secrets = []) {
  if (typeof value !== "string") return undefined;
  let text = value;
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length > 0) text = text.split(secret).join("[REDACTED]");
  }
  text = text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\bBearer\s+[^\s"'<>]+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk-|gsk_|AIza)[A-Za-z0-9_-]{12,}/g, "[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replace(/((?:api[_ -]?key|(?:(?:access|refresh|id)[_ -]?)?token|authorization|secret|password|cookie)\s*["']?\s*[:=]\s*["']?)[^\s"',;}\]]+/gi, "$1[REDACTED]")
    .replace(/(https?:\/\/)[^\s/:@]+:[^\s/@]+@/gi, "$1[REDACTED]@")
    .replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 1024) : undefined;
}

export function upstreamHttpError(response, body, { secrets = [] } = {}) {
  const status = errorStatus(response?.status) ?? 502;
  const error = body?.error && typeof body.error === "object" ? body.error : {};
  const code = safeErrorCode(error.code) ?? safeErrorCode(error.type) ?? "upstream_error";
  const type = safeErrorCode(error.type) ?? "upstream";
  const param = safeErrorParam(error.param);
  const retryAfter = safeRetryAfter(response?.headers?.get?.("retry-after"));
  const message = safeErrorMessage(error.message ?? body?.message, secrets);
  return {
    status, code, type,
    message: message ?? `Upstream request failed (HTTP ${status}; ${code}${param ? `; parameter ${param}` : ""}).`,
    ...(param ? { param } : {}), ...(retryAfter ? { retryAfter } : {}),
  };
}

export function relayHttpError(error) {
  const details = error?.details ?? {};
  const localCode = safeErrorCode(error?.code) ?? "internal_error";
  const status = errorStatus(details.status)
    ?? (localCode === "invalid_request" || localCode === "request_too_large" ? 400
      : localCode === "permission_denied" ? 403
        : localCode === "timeout" ? 504
          : localCode.startsWith("upstream") ? 502 : 500);
  const code = safeErrorCode(details.code) ?? localCode;
  const type = safeErrorCode(details.type) ?? localCode;
  const param = safeErrorParam(details.param);
  const retryAfter = safeRetryAfter(details.retryAfter);
  const message = safeErrorMessage(error?.message)
    ?? `Bridge request failed (HTTP ${status}; ${code}${param ? `; parameter ${param}` : ""}).`;
  return {
    status,
    headers: retryAfter ? { "retry-after": retryAfter } : {},
    error: { message, type, code, ...(param ? { param } : {}) },
  };
}
