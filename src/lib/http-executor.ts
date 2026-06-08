import type { KeyValueRow, RequestDraft, SendErrorResult, SendResult } from "@/lib/types";
import { getAutoHeaders } from "@/lib/auto-headers";

const DEFAULT_TIMEOUT_MS = 30_000;

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
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const targetUrl = buildTargetUrl(draft);
    const headers = buildHeaders(draft);
    applyCookieHeader(headers, cookieHeader);
    const body = buildBody(draft, headers);

    const response = await fetch(targetUrl, {
      method: draft.method,
      headers,
      body,
      signal: controller.signal,
      redirect: "follow"
    });

    const bytes = new Uint8Array(await response.arrayBuffer());
    const contentType = response.headers.get("content-type") ?? "";
    const bodyText = isBinaryContentType(contentType)
      ? `[Binary content: ${contentType || "unknown"}, ${formatByteLength(bytes.byteLength)}]`
      : new TextDecoder().decode(bytes);
    const bodyBase64 = isBinaryContentType(contentType) ? Buffer.from(bytes).toString("base64") : undefined;
    const durationMs = Math.round(performance.now() - started);

    return {
      status: response.status,
      statusText: response.statusText,
      headers: serializeResponseHeaders(response.headers),
      body: bodyText,
      bodyBase64,
      contentType,
      durationMs,
      sizeBytes: bytes.byteLength
    };
  } catch (error) {
    const durationMs = Math.round(performance.now() - started);
    const message = error instanceof Error ? error.message : "Network request failed";

    return {
      error: message,
      durationMs
    };
  } finally {
    clearTimeout(timeout);
  }
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
      url.searchParams.set(row.key.trim(), row.value);
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

function buildBody(draft: RequestDraft, _headers: Headers): BodyInit | undefined {
  if (draft.method === "GET" || draft.method === "HEAD" || draft.bodyMode === "none") {
    return undefined;
  }

  if (draft.bodyMode === "raw_json" || draft.bodyMode === "raw_text") {
    return draft.bodyRaw;
  }

  if (draft.bodyMode === "form_urlencoded") {
    return new URLSearchParams(draft.bodyRaw);
  }

  return undefined;
}

export function appendApiKeyQuery(url: string, apiKey: KeyValueRow | null): string {
  if (!apiKey?.key) {
    return url;
  }

  const target = new URL(url);
  target.searchParams.set(apiKey.key, apiKey.value);
  return target.toString();
}
