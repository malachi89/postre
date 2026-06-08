import type { AuthConfig, BodyMode, HttpMethod, KeyValueRow, RequestDraft } from "@/lib/types";
import { getAutoHeaders } from "@/lib/auto-headers";

const NO_VALUE_FLAGS = new Set([
  "-L",
  "--location",
  "--compressed",
  "--silent",
  "-s",
  "-k",
  "--insecure",
  "--globoff",
  "-i",
  "--include"
]);

const IGNORED_VALUE_FLAGS = new Set([
  "--connect-timeout",
  "--max-time",
  "--retry",
  "--retry-delay",
  "--proxy",
  "--cacert",
  "--cert",
  "--key",
  "--cookie",
  "-b"
]);

const DATA_FLAGS = new Set(["-d", "--data", "--data-raw", "--data-binary", "--data-ascii", "--data-urlencode"]);
const FORM_FLAGS = new Set(["-F", "--form", "--form-string"]);

export class CurlParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CurlParseError";
  }
}

export function requestDraftToCurl(draft: RequestDraft): string {
  const headers = buildEffectiveHeaders(draft);
  const url = buildCurlUrl(draft);
  const lines = ["curl --location", `  --request ${draft.method}`, `  ${quoteShell(url)}`];

  for (const header of headers) {
    lines.push(`  --header ${quoteShell(`${header.key}: ${header.value}`)}`);
  }

  if (draft.auth.type === "basic" && (draft.auth.username || draft.auth.password)) {
    lines.push(`  --user ${quoteShell(`${draft.auth.username ?? ""}:${draft.auth.password ?? ""}`)}`);
  }

  if (draft.bodyRaw && (draft.bodyMode === "raw_json" || draft.bodyMode === "raw_text")) {
    lines.push(`  --data-raw ${quoteShell(draft.bodyRaw)}`);
  }

  return lines.join(" \\\n");
}

export function parseCurlToRequestDraft(curl: string, currentDraft: RequestDraft): RequestDraft {
  const tokens = tokenizeCurl(curl);

  if (tokens.length === 0) {
    throw new CurlParseError("Paste a cURL command first.");
  }

  let index = tokens[0] === "curl" ? 1 : 0;
  let explicitMethod: HttpMethod | null = null;
  let url = "";
  let auth: AuthConfig = { type: "none" };
  const headers: KeyValueRow[] = [];
  const dataParts: string[] = [];

  while (index < tokens.length) {
    const token = tokens[index];

    if (FORM_FLAGS.has(token)) {
      throw new CurlParseError("Multipart/form-data cURL is not supported yet.");
    }

    if (token === "-X" || token === "--request") {
      explicitMethod = normalizeMethod(readValue(tokens, index, token));
      index += 2;
      continue;
    }

    if (token.startsWith("--request=")) {
      explicitMethod = normalizeMethod(token.slice("--request=".length));
      index += 1;
      continue;
    }

    if (token === "--url") {
      url = readValue(tokens, index, token);
      index += 2;
      continue;
    }

    if (token.startsWith("--url=")) {
      url = token.slice("--url=".length);
      index += 1;
      continue;
    }

    if (token === "-H" || token === "--header") {
      headers.push(parseHeader(readValue(tokens, index, token)));
      index += 2;
      continue;
    }

    if (token.startsWith("--header=")) {
      headers.push(parseHeader(token.slice("--header=".length)));
      index += 1;
      continue;
    }

    if (token === "-u" || token === "--user") {
      auth = parseBasicAuth(readValue(tokens, index, token));
      index += 2;
      continue;
    }

    if (token.startsWith("--user=")) {
      auth = parseBasicAuth(token.slice("--user=".length));
      index += 1;
      continue;
    }

    if (DATA_FLAGS.has(token)) {
      dataParts.push(readValue(tokens, index, token));
      index += 2;
      continue;
    }

    const dataPrefix = [...DATA_FLAGS].find((flag) => token.startsWith(`${flag}=`));
    if (dataPrefix) {
      dataParts.push(token.slice(dataPrefix.length + 1));
      index += 1;
      continue;
    }

    if (NO_VALUE_FLAGS.has(token)) {
      index += 1;
      continue;
    }

    if (IGNORED_VALUE_FLAGS.has(token)) {
      index += 2;
      continue;
    }

    const ignoredPrefix = [...IGNORED_VALUE_FLAGS].find((flag) => token.startsWith(`${flag}=`));
    if (ignoredPrefix) {
      index += 1;
      continue;
    }

    if (token.startsWith("-")) {
      index += 1;
      continue;
    }

    if (!url) {
      url = token;
    }

    index += 1;
  }

  if (!url) {
    throw new CurlParseError("Could not find a URL in the cURL command.");
  }

  const bodyRaw = dataParts.join("&");
  const bodyMode = inferBodyMode(bodyRaw);
  const parsedUrl = extractQueryParams(url);

  return {
    ...currentDraft,
    method: explicitMethod ?? (bodyRaw ? "POST" : "GET"),
    url: parsedUrl.url,
    headers,
    queryParams: parsedUrl.queryParams,
    bodyMode,
    bodyRaw,
    auth
  };
}

function tokenizeCurl(input: string): string[] {
  const normalized = input.replace(/\\\r?\n/g, " ").trim();
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const next = normalized[index + 1];

    if (quote === "'") {
      if (char === "'") {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (quote === "\"") {
      if (char === "\"") {
        quote = null;
      } else if (char === "\\" && next !== undefined) {
        current += next;
        index += 1;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    if (char === "\\" && next !== undefined) {
      current += next;
      index += 1;
      continue;
    }

    current += char;
  }

  if (quote) {
    throw new CurlParseError("The cURL command has an unclosed quote.");
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}

function buildEffectiveHeaders(draft: RequestDraft): KeyValueRow[] {
  const headers = new Map<string, KeyValueRow>();

  // Auto-generated headers first (lowest priority)
  for (const auto of getAutoHeaders(draft)) {
    headers.set(auto.key.toLowerCase(), {
      key: auto.key,
      value: auto.value,
      enabled: true
    });
  }

  // User-defined headers override auto headers
  for (const row of draft.headers) {
    if (row.enabled && row.key.trim()) {
      headers.set(row.key.trim().toLowerCase(), {
        key: row.key.trim(),
        value: row.value,
        enabled: true
      });
    }
  }

  if (draft.auth.type === "bearer" && draft.auth.token) {
    headers.set("authorization", {
      key: "Authorization",
      value: `Bearer ${draft.auth.token}`,
      enabled: true
    });
  }

  if (draft.auth.type === "apiKey" && draft.auth.placement === "header" && draft.auth.key) {
    headers.set(draft.auth.key.trim().toLowerCase(), {
      key: draft.auth.key,
      value: draft.auth.value ?? "",
      enabled: true
    });
  }

  return [...headers.values()];
}

function buildCurlUrl(draft: RequestDraft): string {
  const params = draft.queryParams
    .filter((row) => row.enabled && row.key.trim())
    .map((row) => [row.key.trim(), row.value] as const);

  if (draft.auth.type === "apiKey" && draft.auth.placement === "query" && draft.auth.key) {
    params.push([draft.auth.key, draft.auth.value ?? ""]);
  }

  if (params.length === 0) {
    return draft.url;
  }

  const [baseAndSearch, hash = ""] = splitOnce(draft.url, "#");
  const separator = baseAndSearch.includes("?") ? "&" : "?";
  const query = params
    .map(([key, value]) => `${encodeQueryComponent(key)}=${encodeQueryComponent(value)}`)
    .join("&");

  return `${baseAndSearch}${separator}${query}${hash ? `#${hash}` : ""}`;
}

function extractQueryParams(url: string): { url: string; queryParams: KeyValueRow[] } {
  const [baseAndSearch, hash = ""] = splitOnce(url, "#");
  const [base, query = ""] = splitOnce(baseAndSearch, "?");

  if (!query) {
    return {
      url,
      queryParams: []
    };
  }

  return {
    url: `${base}${hash ? `#${hash}` : ""}`,
    queryParams: query
      .split("&")
      .filter(Boolean)
      .map((part) => {
        const [key, value = ""] = splitOnce(part, "=");
        return {
          key: decodeQueryComponent(key),
          value: decodeQueryComponent(value),
          enabled: true
        };
      })
  };
}

function quoteShell(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function encodeQueryComponent(value: string): string {
  return encodeURIComponent(value)
    .replace(/%7B%7B/g, "{{")
    .replace(/%7D%7D/g, "}}");
}

function decodeQueryComponent(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return value;
  }
}

function parseHeader(value: string): KeyValueRow {
  const separatorIndex = value.indexOf(":");

  if (separatorIndex === -1) {
    throw new CurlParseError(`Header "${value}" must use "Name: value" format.`);
  }

  return {
    key: value.slice(0, separatorIndex).trim(),
    value: value.slice(separatorIndex + 1).trimStart(),
    enabled: true
  };
}

function parseBasicAuth(value: string): AuthConfig {
  const [username, password = ""] = splitOnce(value, ":");

  return {
    type: "basic",
    username,
    password
  };
}

function inferBodyMode(bodyRaw: string): BodyMode {
  if (!bodyRaw) {
    return "none";
  }

  return looksLikeJson(bodyRaw) ? "raw_json" : "raw_text";
}

function looksLikeJson(value: string): boolean {
  const trimmed = value.trim();
  return (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  );
}

function normalizeMethod(value: string): HttpMethod {
  const method = value.toUpperCase();

  if (
    method === "GET" ||
    method === "POST" ||
    method === "PUT" ||
    method === "PATCH" ||
    method === "DELETE" ||
    method === "HEAD" ||
    method === "OPTIONS"
  ) {
    return method;
  }

  throw new CurlParseError(`Unsupported HTTP method "${value}".`);
}

function readValue(tokens: string[], index: number, flag: string): string {
  const value = tokens[index + 1];

  if (value === undefined || value.startsWith("-")) {
    throw new CurlParseError(`Missing value for ${flag}.`);
  }

  return value;
}

function splitOnce(value: string, delimiter: string): [string, string?] {
  const index = value.indexOf(delimiter);

  if (index === -1) {
    return [value];
  }

  return [value.slice(0, index), value.slice(index + delimiter.length)];
}
