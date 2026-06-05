import type { KeyValueRow, RequestDraft, SendErrorResult, SendResult } from "@/lib/types";

const DEFAULT_TIMEOUT_MS = 30_000;

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
    const bodyText = new TextDecoder().decode(bytes);
    const durationMs = Math.round(performance.now() - started);

    return {
      status: response.status,
      statusText: response.statusText,
      headers: serializeResponseHeaders(response.headers),
      body: bodyText,
      contentType: response.headers.get("content-type") ?? "",
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

  for (const row of draft.headers) {
    if (row.enabled && row.key.trim()) {
      headers.set(row.key.trim(), row.value);
    }
  }

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

  if (draft.bodyMode === "raw_json" && draft.bodyRaw.trim() && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
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
    const form = new URLSearchParams();
    for (const row of draft.queryParams) {
      if (row.enabled && row.key.trim()) {
        form.set(row.key.trim(), row.value);
      }
    }
    return form;
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
