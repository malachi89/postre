import type { RequestDraft } from "@/lib/types";

export interface AutoHeader {
  key: string;
  value: string;
}

/**
 * Returns the list of auto-generated headers for a request draft.
 * These mirror the default headers that Postman sends automatically.
 * User-defined headers with the same key should take precedence.
 */
export function getAutoHeaders(draft: RequestDraft): AutoHeader[] {
  // Only include headers that are safe to set explicitly.
  // Accept-Encoding and Connection are handled automatically by the fetch runtime
  // — setting them manually can break decompression or connection handling.
  const headers: AutoHeader[] = [
    { key: "User-Agent", value: "Postre/1.0" },
    { key: "Accept", value: "*/*" }
  ];

  const contentType = getAutoContentType(draft);
  if (contentType) {
    headers.push({ key: "Content-Type", value: contentType });
  }

  return headers;
}

const RAW_FORMAT_CONTENT_TYPES: Record<string, string> = {
  json: "application/json",
  text: "text/plain",
  xml: "application/xml",
  javascript: "application/javascript",
  html: "text/html"
};

function getAutoContentType(draft: RequestDraft): string | null {
  if (draft.method === "GET" || draft.method === "HEAD" || draft.bodyMode === "none") {
    return null;
  }

  if (!draft.bodyRaw.trim() && draft.bodyMode !== "formdata") {
    return null;
  }

  switch (draft.bodyMode) {
    case "raw":
      return RAW_FORMAT_CONTENT_TYPES[draft.bodyRawFormat] ?? "text/plain";
    case "form_urlencoded":
      return "application/x-www-form-urlencoded";
    case "binary":
      return "application/octet-stream";
    default:
      return null;
  }
}

/**
 * Returns only the auto headers that are NOT overridden by user-defined headers.
 * Used by the UI to display which auto headers will actually be sent.
 */
export function getEffectiveAutoHeaders(draft: RequestDraft): AutoHeader[] {
  const userKeys = new Set(
    draft.headers
      .filter((row) => row.enabled && row.key.trim())
      .map((row) => row.key.trim().toLowerCase())
  );

  return getAutoHeaders(draft).filter((h) => !userKeys.has(h.key.toLowerCase()));
}
