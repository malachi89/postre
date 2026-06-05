import type { ApiCollection, ApiEnvironment, ApiFolder, ApiRequest, VariableValue } from "@/lib/types";

export interface PostmanExport {
  collections: unknown[];
  environments: unknown[];
}

export function buildPostmanExport(collections: ApiCollection[], environments: ApiEnvironment[]): PostmanExport {
  return {
    collections: collections.map(collectionToPostman),
    environments: environments.map(environmentToPostman)
  };
}

function collectionToPostman(collection: ApiCollection): unknown {
  const items: unknown[] = [
    ...collection.requests.map((r) => requestToPostmanItem(r)),
    ...collection.folders.map((f) => folderToPostmanItem(f))
  ];

  return {
    info: {
      name: collection.name,
      description: collection.description ?? "",
      schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"
    },
    item: items,
    variable: collection.variables.map(variableToPostman)
  };
}

function folderToPostmanItem(folder: ApiFolder): unknown {
  const items: unknown[] = [
    ...folder.requests.map((r) => requestToPostmanItem(r)),
    ...folder.children.map((f) => folderToPostmanItem(f))
  ];

  return {
    name: folder.name,
    item: items
  };
}

function requestToPostmanItem(request: ApiRequest): unknown {
  return {
    name: request.name,
    request: {
      method: request.method,
      header: request.headers.filter((h) => h.enabled).map(headerToPostman),
      url: urlToPostman(request.url, request.queryParams),
      body: bodyToPostman(request.bodyMode, request.bodyRaw),
      auth: authToPostman(request.auth),
      description: ""
    }
  };
}

function headerToPostman(header: { key: string; value: string; enabled?: boolean }): unknown {
  return {
    key: header.key,
    value: header.value,
    type: "text"
  };
}

function urlToPostman(url: string, queryParams: { key: string; value: string; enabled: boolean }[]): unknown {
  try {
    const parsed = new URL(url);
    return {
      raw: url,
      protocol: parsed.protocol.replace(":", ""),
      host: parsed.hostname.split("."),
      port: parsed.port || undefined,
      path: parsed.pathname.split("/").filter(Boolean),
      query: queryParams.filter((q) => q.enabled).map((q) => ({
        key: q.key,
        value: q.value,
        disabled: !q.enabled
      }))
    };
  } catch {
    return { raw: url };
  }
}

function bodyToPostman(bodyMode: string, bodyRaw: string): unknown {
  if (bodyMode === "none" || !bodyRaw) {
    return undefined;
  }

  if (bodyMode === "raw_json") {
    return {
      mode: "raw",
      raw: bodyRaw,
      options: {
        raw: { language: "json" }
      }
    };
  }

  if (bodyMode === "raw_text") {
    return {
      mode: "raw",
      raw: bodyRaw
    };
  }

  if (bodyMode === "form_urlencoded") {
    return {
      mode: "urlencoded",
      urlencoded: parseBodyEntries(bodyRaw)
    };
  }

  if (bodyMode === "multipart") {
    return {
      mode: "formdata",
      formdata: parseBodyEntries(bodyRaw)
    };
  }

  return undefined;
}

function parseBodyEntries(raw: string): { key: string; value: string; type: string; enabled: boolean }[] {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.map((entry) => ({
        key: entry.key ?? "",
        value: entry.value ?? "",
        type: entry.type ?? "text",
        enabled: entry.enabled !== false
      }));
    }
  } catch {
    // ignore parse errors
  }
  return [];
}

function authToPostman(auth: { type: string; token?: string; username?: string; password?: string; key?: string; value?: string; placement?: string }): unknown {
  if (auth.type === "none") {
    return undefined;
  }

  if (auth.type === "bearer" && auth.token) {
    return {
      type: "bearer",
      bearer: [{ key: "token", value: auth.token, type: "string" }]
    };
  }

  if (auth.type === "basic") {
    const basic: { key: string; value: string; type: string }[] = [];
    if (auth.username) basic.push({ key: "username", value: auth.username, type: "string" });
    if (auth.password) basic.push({ key: "password", value: auth.password, type: "string" });
    if (basic.length > 0) {
      return { type: "basic", basic };
    }
  }

  if (auth.type === "apiKey") {
    const apikey: { key: string; value: string; type: string }[] = [];
    if (auth.key) apikey.push({ key: "key", value: auth.key, type: "string" });
    if (auth.value) apikey.push({ key: "value", value: auth.value, type: "string" });
    if (auth.placement) apikey.push({ key: "in", value: auth.placement, type: "string" });
    if (apikey.length > 0) {
      return { type: "apikey", apikey };
    }
  }

  return undefined;
}

function variableToPostman(variable: VariableValue): unknown {
  return {
    key: variable.key,
    value: variable.initialValue || variable.currentValue,
    type: "string",
    enabled: variable.enabled
  };
}

function environmentToPostman(environment: ApiEnvironment): unknown {
  return {
    name: environment.name,
    values: environment.variables.map((v) => ({
      key: v.key,
      value: v.initialValue || v.currentValue,
      type: "string",
      enabled: v.enabled
    })),
    _postman_variable_scope: "environment",
    _postman_exported_at: new Date().toISOString(),
    _postman_exported_using: "PostRE"
  };
}
