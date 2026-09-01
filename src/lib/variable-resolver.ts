import type { AuthConfig, KeyValueRow, RequestDraft, VariableScope, VariableValue } from "@/lib/types";

const VARIABLE_PATTERN = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

export interface VariableBuckets {
  global: VariableValue[];
  environment: VariableValue[];
  collection: VariableValue[];
  request: VariableValue[];
}

export interface ResolutionResult {
  value: string;
  missing: string[];
}

export interface ResolvedRequest {
  draft: RequestDraft;
  missingVariables: string[];
}

export function findVariablesInText(text: string): string[] {
  const found = new Set<string>();

  for (const match of text.matchAll(VARIABLE_PATTERN)) {
    found.add(match[1]);
  }

  return [...found];
}

export function resolveTemplate(text: string, buckets: VariableBuckets): ResolutionResult {
  const missing = new Set<string>();
  const value = text.replace(VARIABLE_PATTERN, (_token, key: string) => {
    const resolved = getVariableValue(key, buckets);

    if (resolved === null) {
      missing.add(key);
      return `{{${key}}}`;
    }

    return resolved.trim();
  });

  return {
    value,
    missing: [...missing]
  };
}

export function getVariableValue(key: string, buckets: VariableBuckets): string | null {
  const scopes: VariableValue[][] = [
    buckets.request,
    buckets.collection,
    buckets.environment,
    buckets.global
  ];

  for (const scope of scopes) {
    const variable = scope.find((entry) => entry.enabled && entry.key === key);
    if (variable) {
      return variable.currentValue || variable.initialValue;
    }
  }

  return null;
}

export function bucketVariables(variables: VariableValue[]): VariableBuckets {
  return {
    global: variables.filter((variable) => variable.scope === "GLOBAL"),
    environment: variables.filter((variable) => variable.scope === "ENVIRONMENT"),
    collection: variables.filter((variable) => variable.scope === "COLLECTION"),
    request: variables.filter((variable) => variable.scope === "REQUEST")
  };
}

export function normalizeScope(scope: string): VariableScope {
  if (scope === "ENVIRONMENT" || scope === "COLLECTION" || scope === "REQUEST") {
    return scope;
  }

  return "GLOBAL";
}

export function resolveRequestDraft(draft: RequestDraft, buckets: VariableBuckets): ResolvedRequest {
  const missing = new Set<string>();

  const resolve = (text: string): string => {
    const result = resolveTemplate(text, buckets);
    result.missing.forEach((key) => missing.add(key));
    return result.value;
  };

  const resolvedHeaders = resolveRows(draft.headers, resolve);
  const resolvedQueryParams = resolveRows(draft.queryParams, resolve);
  const resolvedAuth = resolveAuth(draft.auth, resolve);
  const bodyRaw = draft.bodyRaw ? resolve(draft.bodyRaw) : "";

  return {
    draft: {
      ...draft,
      url: resolve(draft.url),
      headers: resolvedHeaders,
      queryParams: resolvedQueryParams,
      bodyRaw,
      auth: resolvedAuth
    },
    missingVariables: [...missing]
  };
}

function resolveRows(rows: KeyValueRow[], resolve: (text: string) => string): KeyValueRow[] {
  return rows.map((row) => {
    if (!row.enabled) return row;
    return {
      ...row,
      key: resolve(row.key),
      value: resolve(row.value)
    };
  });
}

function resolveAuth(auth: AuthConfig, resolve: (text: string) => string): AuthConfig {
  if (auth.type === "bearer") {
    return {
      ...auth,
      token: resolve(auth.token ?? "")
    };
  }

  if (auth.type === "basic") {
    return {
      ...auth,
      username: resolve(auth.username ?? ""),
      password: resolve(auth.password ?? "")
    };
  }

  if (auth.type === "apiKey") {
    return {
      ...auth,
      key: resolve(auth.key ?? ""),
      value: resolve(auth.value ?? "")
    };
  }

  return auth;
}
