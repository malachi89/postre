import type { KeyValueRow, RequestDraft, SendErrorResult, SendResult } from "@/lib/types";
import { getAutoHeaders } from "@/lib/auto-headers";

const DEFAULT_TIMEOUT_MS = 30_000;
// Responses larger than this are cut off (the connection is aborted) instead of
// buffering the whole body in memory; history/run steps only keep 120 KB anyway.
const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;

function isBinaryContentType(contentType: string): boolean {
  const lower = contentType.toLowerCase();
  return (
    lower.includes("pdf") ||
    lower.includes("image/") ||
    lower.includes("audio/") ||
    lower.includes("video/") ||
    lower.includes("zip") ||
    lower.includes("gzip") ||
    lower.includes("compress") ||
    lower.includes("octet-stream") ||
    lower.includes("excel") ||
    lower.includes("word") ||
    lower.includes("powerpoint") ||
    lower.includes("font") ||
    lower.includes("application/vnd") ||
    (!lower.includes("text") &&
      !lower.includes("json") &&
      !lower.includes("xml") &&
      !lower.includes("html") &&
      !lower.includes("javascript") &&
      !lower.includes("urlencoded") &&
      !lower.includes("form-data") &&
      lower.startsWith("application/"))
  );
}

function formatByteLength(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export async function executeHttpRequest(
  draft: RequestDraft,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  cookieHeader = ""
): Promise<SendResult | SendErrorResult> {
  const started = performance.now();
  const controller = new AbortController();
  const safeTimeoutMs =
    typeof timeoutMs === "number" && Number.isFinite(timeoutMs)
      ? Math.min(Math.max(timeoutMs, 1_000), 300_000)
      : DEFAULT_TIMEOUT_MS;
  const timeout = setTimeout(() => controller.abort(), safeTimeoutMs);

  try {
    const targetUrl = buildTargetUrl(draft);
    const headers = buildHeaders(draft);
    applyCookieHeader(headers, cookieHeader);
    const body = buildBody(draft);

    const response = await fetch(targetUrl, {
      method: draft.method,
      headers,
      body,
      signal: controller.signal,
      redirect: "follow"
    });

    const { bytes, truncated } = await readBodyWithCap(response, controller);
    const contentType = response.headers.get("content-type") ?? "";
    const binary = isBinaryContentType(contentType);
    const bodyText = binary
      ? `[Binary content: ${contentType || "unknown"}, ${formatByteLength(bytes.byteLength)}]`
      : decodeBodyText(bytes, contentType);
    const bodyBase64 = binary ? Buffer.from(bytes).toString("base64") : undefined;
    const durationMs = Math.round(performance.now() - started);

    return {
      status: response.status,
      statusText: response.statusText,
      headers: serializeResponseHeaders(response.headers),
      body: bodyText,
      bodyBase64,
      contentType,
      durationMs,
      sizeBytes: bytes.byteLength,
      bodyTruncated: truncated
    };
  } catch (error) {
    const durationMs = Math.round(performance.now() - started);
    let message = error instanceof Error ? error.message : "Network request failed";
    if (error instanceof DOMException && error.name === "AbortError") {
      message = `Request timed out after ${Math.round(safeTimeoutMs / 1000)}s`;
    }

    return {
      error: message,
      durationMs
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function readBodyWithCap(
  response: Response,
  controller: AbortController
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!response.body) {
    return { bytes: new Uint8Array(0), truncated: false };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }
      chunks.push(value);
      total += value.byteLength;
      if (total >= MAX_RESPONSE_BYTES) {
        truncated = true;
        // Stop draining a huge download; abort cancels the connection.
        controller.abort();
        break;
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // already cancelled or closed
    }
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { bytes, truncated };
}

function decodeBodyText(bytes: Uint8Array, contentType: string): string {
  const charset = /charset=([^;]+)/i.exec(contentType)?.[1]?.trim().replace(/^"|"$/g, "");
  if (charset) {
    try {
      return new TextDecoder(charset).decode(bytes);
    } catch {
      // Unknown charset label — fall through to UTF-8.
    }
  }
  return new TextDecoder("utf-8").decode(bytes);
}

function serializeResponseHeaders(headers: Headers): KeyValueRow[] {
  const rows = [...headers.entries()].map(([key, value]) => ({
    key,
    value,
    enabled: true
  }));
  const setCookies = readSetCookieHeaders(headers);

  if (setCookies.length) {
    return [
      ...rows.filter((row) => row.key.toLowerCase() !== "set-cookie"),
      ...setCookies.map((value) => ({ key: "set-cookie", value, enabled: true }))
    ];
  }

  return rows;
}

function readSetCookieHeaders(headers: Headers): string[] {
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  if (typeof getSetCookie === "function") {
    return getSetCookie.call(headers);
  }

  const combined = headers.get("set-cookie");
  return combined ? [combined] : [];
}

export function buildTargetUrl(draft: RequestDraft): string {
  const url = new URL(draft.url);

  for (const row of draft.queryParams) {
    if (row.enabled && row.key.trim()) {
      url.searchParams.append(row.key.trim(), row.value);
    }
  }

  if (draft.auth.type === "apiKey" && draft.auth.placement === "query" && draft.auth.key) {
    url.searchParams.set(draft.auth.key, draft.auth.value ?? "");
  }

  return url.toString();
}

function buildHeaders(draft: RequestDraft): Headers {
  const headers = new Headers();

  // Apply auto-generated default headers first (lowest priority)
  for (const auto of getAutoHeaders(draft)) {
    headers.set(auto.key, auto.value);
  }

  // User-defined headers override auto headers
  for (const row of draft.headers) {
    if (row.enabled && row.key.trim()) {
      headers.set(row.key.trim(), row.value);
    }
  }

  // Auth headers
  if (draft.auth.type === "bearer" && draft.auth.token) {
    headers.set("Authorization", `Bearer ${draft.auth.token}`);
  }

  if (draft.auth.type === "basic") {
    const username = draft.auth.username ?? "";
    const password = draft.auth.password ?? "";
    headers.set("Authorization", `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`);
  }

  if (draft.auth.type === "apiKey" && draft.auth.placement === "header" && draft.auth.key) {
    headers.set(draft.auth.key, draft.auth.value ?? "");
  }

  return headers;
}

function applyCookieHeader(headers: Headers, cookieHeader: string) {
  const jarCookie = cookieHeader.trim();
  if (!jarCookie) {
    return;
  }

  const manualCookie = headers.get("Cookie");
  if (!manualCookie) {
    headers.set("Cookie", jarCookie);
    return;
  }

  const manualNames = new Set(
    manualCookie
      .split(";")
      .map((part) => part.trim().split("=")[0]?.trim())
      .filter(Boolean)
  );
  const jarParts = jarCookie
    .split(";")
    .map((part) => part.trim())
    .filter((part) => {
      const name = part.split("=")[0]?.trim();
      return name && !manualNames.has(name);
    });

  if (jarParts.length) {
    headers.set("Cookie", `${manualCookie}; ${jarParts.join("; ")}`);
  }
}

function buildBody(draft: RequestDraft): BodyInit | undefined {
  if (draft.method === "GET" || draft.method === "HEAD" || draft.bodyMode === "none") {
    return undefined;
  }

  if (draft.bodyMode === "raw") {
    return draft.bodyRaw;
  }

  if (draft.bodyMode === "form_urlencoded") {
    return new URLSearchParams(draft.bodyRaw);
  }

  if (draft.bodyMode === "binary") {
    // The body field stores text for now; selecting a real file is not
    // implemented end to end yet.
    return draft.bodyRaw;
  }

  if (draft.bodyMode === "formdata") {
    // Imported Postman requests keep their form-data rows JSON-serialised in
    // bodyRaw. Without a real editor, at least make those rows sendable.
    const form = buildFormDataBody(draft.bodyRaw);
    return form && form[Symbol.iterator]().next().done !== true ? form : undefined;
  }

  return undefined;
}

function buildFormDataBody(bodyRaw: string): FormData | undefined {
  let rows: unknown;
  try {
    rows = JSON.parse(bodyRaw);
  } catch {
    return undefined;
  }

  if (!Array.isArray(rows) || rows.length === 0) {
    return undefined;
  }

  const form = new FormData();
  for (const entry of rows.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object")) {
    const key = typeof entry.key === "string" ? entry.key : "";
    if (!key) {
      continue;
    }
    // File uploads are not supported (no file content is stored), so file rows
    // are skipped silently.
    if (entry.type === "file") {
      continue;
    }
    if (entry.disabled !== true) {
      form.append(key, typeof entry.value === "string" ? entry.value : "");
    }
  }

  return form;
}

