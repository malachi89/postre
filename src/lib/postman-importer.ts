import { asArray, asRecord, stringValue } from "@/lib/json";
import { inferIsSecret } from "@/lib/secret-utils";
import type {
  AuthConfig,
  BodyMode,
  HttpMethod,
  ImportKind,
  ImportPreview,
  KeyValueRow,
  VariableValue
} from "@/lib/types";

export interface NormalizedPostmanCollection {
  name: string;
  variables: VariableValue[];
  items: NormalizedPostmanItem[];
  preRequestScript: string;
  postRequestScript: string;
  metadata: Record<string, unknown>;
  warnings: string[];
}

export type NormalizedPostmanItem = NormalizedPostmanFolder | NormalizedPostmanRequestItem;

export interface NormalizedPostmanFolder {
  type: "folder";
  name: string;
  preRequestScript: string;
  postRequestScript: string;
  items: NormalizedPostmanItem[];
  metadata: Record<string, unknown>;
  raw: unknown;
}

export interface NormalizedPostmanRequestItem {
  type: "request";
  name: string;
  request: NormalizedPostmanRequest;
  metadata: Record<string, unknown>;
  raw: unknown;
}

export interface NormalizedPostmanRequest {
  method: HttpMethod;
  url: string;
  headers: KeyValueRow[];
  queryParams: KeyValueRow[];
  bodyMode: BodyMode;
  bodyRaw: string;
  preRequestScript: string;
  postRequestScript: string;
  auth: AuthConfig;
  metadata: Record<string, unknown>;
}

export interface NormalizedPostmanEnvironment {
  name: string;
  variables: VariableValue[];
  metadata: Record<string, unknown>;
  warnings: string[];
}

export function detectPostmanPayload(payload: unknown): ImportKind {
  const root = asRecord(payload);

  if (!root) {
    return "unknown";
  }

  const info = asRecord(root.info);
  const schema = stringValue(info?.schema).toLowerCase();

  if (info && Array.isArray(root.item) && schema.includes("postman") && schema.includes("collection")) {
    return "collection";
  }

  if (info && Array.isArray(root.item) && stringValue(info.name)) {
    return "collection";
  }

  if (Array.isArray(root.values) && (root.name || root.id || root._postman_variable_scope === "environment")) {
    return "environment";
  }

  return "unknown";
}

export function previewPostmanImport(payload: unknown): ImportPreview {
  const type = detectPostmanPayload(payload);

  if (type === "collection") {
    const collection = normalizePostmanCollection(payload);
    const counts = countItems(collection.items);

    return {
      type,
      name: collection.name,
      folderCount: counts.folders,
      requestCount: counts.requests,
      variableCount: collection.variables.length,
      warnings: collection.warnings
    };
  }

  if (type === "environment") {
    const environment = normalizePostmanEnvironment(payload);

    return {
      type,
      name: environment.name,
      folderCount: 0,
      requestCount: 0,
      variableCount: environment.variables.length,
      warnings: environment.warnings
    };
  }

  return {
    type: "unknown",
    name: "Unknown Postman JSON",
    folderCount: 0,
    requestCount: 0,
    variableCount: 0,
    warnings: ["No se pudo detectar una Collection o Environment de Postman."]
  };
}

export function normalizePostmanCollection(payload: unknown): NormalizedPostmanCollection {
  const root = asRecord(payload);

  if (!root) {
    throw new Error("Postman collection must be a JSON object.");
  }

  const info = asRecord(root.info);
  const name = stringValue(info?.name, "Imported Collection");
  const warnings: string[] = [];
  const items = asArray(root.item).map((item) => normalizeItem(item, warnings)).filter(Boolean);
  const scripts = extractPostmanScripts(asArray(root.event));

  const auth = asRecord(root.auth);
  if (auth) {
    const normalizedAuth = normalizeAuth(auth);
    if (normalizedAuth.type === "unsupported") {
      warnings.push(`Collection auth "${normalizedAuth.label ?? "unknown"}" is preserved but not supported yet.`);
    }
  }

  return {
    name,
    variables: normalizeVariables(root.variable, "COLLECTION"),
    items: items as NormalizedPostmanItem[],
    preRequestScript: scripts.preRequestScript,
    postRequestScript: scripts.postRequestScript,
    metadata: {
      info,
      auth: root.auth ?? null,
      event: root.event ?? []
    },
    warnings: dedupe(warnings)
  };
}

export function normalizePostmanEnvironment(payload: unknown): NormalizedPostmanEnvironment {
  const root = asRecord(payload);

  if (!root) {
    throw new Error("Postman environment must be a JSON object.");
  }

  const warnings: string[] = [];
  const name = stringValue(root.name, "Imported Environment");
  const variables = normalizeVariables(root.values, "ENVIRONMENT");

  if (variables.length === 0) {
    warnings.push("No enabled or disabled environment variables were found in the Postman file.");
  }

  return {
    name,
    variables,
    metadata: {
      id: root.id ?? null,
      postmanVariableScope: root._postman_variable_scope ?? null,
      postmanExportedAt: root._postman_exported_at ?? null,
      postmanExportedUsing: root._postman_exported_using ?? null
    },
    warnings
  };
}

export function countItems(items: NormalizedPostmanItem[]): { folders: number; requests: number } {
  let folders = 0;
  let requests = 0;

  for (const item of items) {
    if (item.type === "folder") {
      folders += 1;
      const childCounts = countItems(item.items);
      folders += childCounts.folders;
      requests += childCounts.requests;
    } else {
      requests += 1;
    }
  }

  return { folders, requests };
}

function normalizeItem(item: unknown, warnings: string[]): NormalizedPostmanItem | null {
  const record = asRecord(item);

  if (!record) {
    warnings.push("An item was skipped because it is not an object.");
    return null;
  }

  const name = stringValue(record.name, "Untitled");
  const children = asArray(record.item);

  if (children.length > 0) {
    const scripts = extractPostmanScripts(asArray(record.event));

    return {
      type: "folder",
      name,
      preRequestScript: scripts.preRequestScript,
      postRequestScript: scripts.postRequestScript,
      items: children.map((child) => normalizeItem(child, warnings)).filter(Boolean) as NormalizedPostmanItem[],
      metadata: {
        auth: record.auth ?? null,
        event: record.event ?? []
      },
      raw: item
    };
  }

  if (record.request) {
    const itemEvents = asArray(record.event);

    return {
      type: "request",
      name,
      request: normalizeRequest(record.request, warnings, name, itemEvents),
      metadata: {
        event: itemEvents,
        protocolProfileBehavior: record.protocolProfileBehavior ?? null
      },
      raw: item
    };
  }

  warnings.push(`Item "${name}" was skipped because it is neither a folder nor a request.`);
  return null;
}

function normalizeRequest(
  input: unknown,
  warnings: string[],
  itemName: string,
  itemEvents: unknown[] = []
): NormalizedPostmanRequest {
  if (typeof input === "string") {
    const scripts = extractPostmanScripts(itemEvents);

    return {
      method: "GET",
      url: input,
      headers: [],
      queryParams: [],
      bodyMode: "none",
      bodyRaw: "",
      preRequestScript: scripts.preRequestScript,
      postRequestScript: scripts.postRequestScript,
      auth: { type: "none" },
      metadata: {}
    };
  }

  const request = asRecord(input);

  if (!request) {
    warnings.push(`Request "${itemName}" had an invalid request shape and was imported as a blank GET.`);
    const scripts = extractPostmanScripts(itemEvents);

    return {
      method: "GET",
      url: "",
      headers: [],
      queryParams: [],
      bodyMode: "none",
      bodyRaw: "",
      preRequestScript: scripts.preRequestScript,
      postRequestScript: scripts.postRequestScript,
      auth: { type: "none" },
      metadata: { rawRequest: input }
    };
  }

  const method = normalizeMethod(request.method);
  const urlInfo = normalizeUrl(request.url);
  const body = normalizeBody(request.body, warnings, itemName);
  const auth = normalizeAuth(request.auth);
  const requestEvents = asArray(request.event);
  const scripts = extractPostmanScripts([...itemEvents, ...requestEvents]);

  if (auth.type === "unsupported") {
    warnings.push(`Request "${itemName}" uses unsupported auth "${auth.label ?? "unknown"}"; it was preserved.`);
  }

  return {
    method,
    url: urlInfo.url,
    headers: normalizeHeaders(request.header),
    queryParams: urlInfo.queryParams,
    bodyMode: body.bodyMode,
    bodyRaw: body.bodyRaw,
    preRequestScript: scripts.preRequestScript,
    postRequestScript: scripts.postRequestScript,
    auth,
    metadata: {
      description: request.description ?? null,
      certificate: request.certificate ?? null,
      proxy: request.proxy ?? null,
      rawBody: request.body ?? null,
      url: request.url ?? null,
      event: requestEvents
    }
  };
}

function normalizeMethod(value: unknown): HttpMethod {
  const method = stringValue(value, "GET").toUpperCase();

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

  return "GET";
}

function normalizeUrl(value: unknown): { url: string; queryParams: KeyValueRow[] } {
  if (typeof value === "string") {
    return {
      url: value,
      queryParams: []
    };
  }

  const url = asRecord(value);

  if (!url) {
    return {
      url: "",
      queryParams: []
    };
  }

  const raw = stringValue(url.raw);
  const queryParams = asArray(url.query).map((entry) => {
    const query = asRecord(entry) ?? {};
    const key = stringValue(query.key);

    return {
      key,
      value: stringValue(query.value),
      enabled: query.disabled !== true,
      isSecret: inferIsSecret(key)
    };
  });

  if (raw) {
    return {
      url: raw,
      queryParams
    };
  }

  const protocol = stringValue(url.protocol, "https").replace(/:$/, "");
  const host = joinPostmanPath(url.host, ".");
  const path = joinPostmanPath(url.path, "/");
  const base = host ? `${protocol}://${host}` : "";
  const urlPath = path ? `/${path}` : "";

  return {
    url: `${base}${urlPath}`,
    queryParams
  };
}

function normalizeHeaders(value: unknown): KeyValueRow[] {
  return asArray(value).map((entry) => {
    const header = asRecord(entry) ?? {};
    const key = stringValue(header.key);

    return {
      key,
      value: stringValue(header.value),
      enabled: header.disabled !== true,
      isSecret: inferIsSecret(key)
    };
  });
}

function normalizeBody(
  value: unknown,
  warnings: string[],
  itemName: string
): { bodyMode: BodyMode; bodyRaw: string } {
  const body = asRecord(value);

  if (!body) {
    return {
      bodyMode: "none",
      bodyRaw: ""
    };
  }

  const mode = stringValue(body.mode);

  if (mode === "raw") {
    const raw = stringValue(body.raw);
    const rawOptions = asRecord(body.options);
    const rawLanguage = stringValue(asRecord(rawOptions?.raw)?.language).toLowerCase();

    return {
      bodyMode: rawLanguage.includes("json") || looksLikeJson(raw) ? "raw_json" : "raw_text",
      bodyRaw: raw
    };
  }

  if (mode === "urlencoded") {
    const form = new URLSearchParams();
    for (const entry of asArray(body.urlencoded)) {
      const record = asRecord(entry) ?? {};
      if (record.disabled !== true) {
        form.append(stringValue(record.key), stringValue(record.value));
      }
    }
    return {
      bodyMode: "form_urlencoded",
      bodyRaw: form.toString()
    };
  }

  if (mode === "formdata") {
    warnings.push(`Request "${itemName}" uses multipart/form-data; it was preserved as metadata for a later version.`);
    return {
      bodyMode: "multipart",
      bodyRaw: JSON.stringify(body.formdata ?? [], null, 2)
    };
  }

  if (mode) {
    warnings.push(`Request "${itemName}" uses unsupported body mode "${mode}"; it was preserved as metadata.`);
  }

  return {
    bodyMode: "none",
    bodyRaw: ""
  };
}

function normalizeAuth(value: unknown): AuthConfig {
  const auth = asRecord(value);

  if (!auth) {
    return { type: "none" };
  }

  const type = stringValue(auth.type);

  if (type === "noauth" || type === "") {
    return { type: "none", raw: auth };
  }

  if (type === "bearer") {
    return {
      type: "bearer",
      token: readAuthValue(auth.bearer, "token"),
      raw: auth
    };
  }

  if (type === "basic") {
    return {
      type: "basic",
      username: readAuthValue(auth.basic, "username"),
      password: readAuthValue(auth.basic, "password"),
      raw: auth
    };
  }

  if (type === "apikey") {
    const inValue = readAuthValue(auth.apikey, "in");
    return {
      type: "apiKey",
      key: readAuthValue(auth.apikey, "key"),
      value: readAuthValue(auth.apikey, "value"),
      placement: inValue === "query" ? "query" : "header",
      raw: auth
    };
  }

  return {
    type: "unsupported",
    label: type || "unknown",
    raw: auth
  };
}

function readAuthValue(value: unknown, key: string): string {
  const list = asArray(value);

  for (const item of list) {
    const record = asRecord(item);
    if (record && stringValue(record.key) === key) {
      return stringValue(record.value);
    }
  }

  return "";
}

function normalizeVariables(value: unknown, scope: VariableValue["scope"]): VariableValue[] {
  return asArray(value)
    .map((entry) => {
      const variable = asRecord(entry) ?? {};
      const key = stringValue(variable.key);
      const currentValue = stringValue(variable.currentValue, stringValue(variable.value));
      const initialValue = stringValue(variable.initialValue, stringValue(variable.value));

      if (!key) {
        return null;
      }

      return {
        key,
        initialValue,
        currentValue,
        enabled: variable.enabled !== false && variable.disabled !== true,
        scope,
        isSecret: inferIsSecret(key)
      };
    })
    .filter(Boolean) as VariableValue[];
}

export function extractPostmanScripts(events: unknown[]): {
  preRequestScript: string;
  postRequestScript: string;
} {
  const preRequestScripts: string[] = [];
  const postRequestScripts: string[] = [];

  for (const event of events) {
    const record = asRecord(event);
    if (!record) {
      continue;
    }

    const listen = stringValue(record.listen).toLowerCase();
    const script = readPostmanScript(record.script);
    if (!script) {
      continue;
    }

    if (listen === "prerequest") {
      preRequestScripts.push(script);
    } else if (listen === "test") {
      postRequestScripts.push(script);
    }
  }

  return {
    preRequestScript: preRequestScripts.join("\n\n"),
    postRequestScript: postRequestScripts.join("\n\n")
  };
}

function readPostmanScript(value: unknown): string {
  const script = asRecord(value);
  if (!script) {
    return "";
  }

  const exec = script.exec;
  if (Array.isArray(exec)) {
    return exec.map((line) => stringValue(line)).join("\n").trim();
  }

  return stringValue(exec).trim();
}

function joinPostmanPath(value: unknown, delimiter: string): string {
  if (Array.isArray(value)) {
    return value.map((part) => stringValue(part)).filter(Boolean).join(delimiter);
  }

  return stringValue(value);
}

function looksLikeJson(value: string): boolean {
  const trimmed = value.trim();
  return (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  );
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
