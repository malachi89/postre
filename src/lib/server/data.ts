import { prisma } from "@/lib/db";
import { parseJsonField, stringifyJson } from "@/lib/json";
import type {
  ApiCollection,
  ApiEnvironment,
  ApiFolder,
  ApiHistoryEntry,
  ApiRequest,
  AppData,
  AuthConfig,
  BodyMode,
  HttpMethod,
  KeyValueRow,
  RequestDraft,
  VariableValue
} from "@/lib/types";
import { inferIsSecret } from "@/lib/secret-utils";
import { normalizeScope } from "@/lib/variable-resolver";

const DEFAULT_AUTH: AuthConfig = { type: "none" };

export async function getAppData(): Promise<AppData> {
  const [collections, environments, globalVariables, history] = await Promise.all([
    prisma.collection.findMany({
      orderBy: { createdAt: "asc" },
      include: {
        folders: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
        requests: {
          orderBy: { createdAt: "asc" },
          include: { variables: { orderBy: { createdAt: "asc" } } }
        },
        variables: { orderBy: { createdAt: "asc" } }
      }
    }),
    prisma.environment.findMany({
      orderBy: { createdAt: "asc" },
      include: { variables: { orderBy: { createdAt: "asc" } } }
    }),
    prisma.variable.findMany({
      where: { scope: "GLOBAL" },
      orderBy: { createdAt: "asc" }
    }),
    prisma.historyEntry.findMany({
      orderBy: { createdAt: "desc" },
      take: 30
    })
  ]);

  return {
    collections: collections.map((collection) => serializeCollection(collection)),
    environments: environments.map((environment) => serializeEnvironment(environment)),
    activeEnvironmentId: environments.find((environment) => environment.active)?.id ?? null,
    globalVariables: globalVariables.map(serializeVariable),
    history: history.map(serializeHistoryEntry)
  };
}

export async function getVariablesForDraft(draft: RequestDraft, environmentId: string | null) {
  const requestId = draft.id;
  const collectionId = draft.collectionId;

  const [globals, environmentVariables, collectionVariables, requestVariables] = await Promise.all([
    prisma.variable.findMany({ where: { scope: "GLOBAL" } }),
    environmentId
      ? prisma.variable.findMany({ where: { scope: "ENVIRONMENT", environmentId } })
      : Promise.resolve([]),
    collectionId
      ? prisma.variable.findMany({ where: { scope: "COLLECTION", collectionId } })
      : Promise.resolve([]),
    requestId
      ? prisma.variable.findMany({ where: { scope: "REQUEST", requestId } })
      : Promise.resolve([])
  ]);

  return {
    global: globals.map(serializeVariable),
    environment: environmentVariables.map(serializeVariable),
    collection: collectionVariables.map(serializeVariable),
    request: requestVariables.map(serializeVariable)
  };
}

export function serializeRequest(request: {
  id: string;
  name: string;
  method: string;
  url: string;
  headersJson: string;
  queryParamsJson: string;
  bodyMode: string;
  bodyRaw: string | null;
  authJson: string;
  collectionId: string;
  folderId: string | null;
  createdAt: Date;
  updatedAt: Date;
  variables?: Array<Parameters<typeof serializeVariable>[0]>;
}): ApiRequest {
  return {
    id: request.id,
    collectionId: request.collectionId,
    folderId: request.folderId,
    name: request.name,
    method: normalizeMethod(request.method),
    url: request.url,
    headers: parseJsonField<KeyValueRow[]>(request.headersJson, []),
    queryParams: parseJsonField<KeyValueRow[]>(request.queryParamsJson, []),
    bodyMode: normalizeBodyMode(request.bodyMode),
    bodyRaw: request.bodyRaw ?? "",
    auth: parseJsonField<AuthConfig>(request.authJson, DEFAULT_AUTH),
    variables: (request.variables ?? []).map(serializeVariable),
    createdAt: request.createdAt.toISOString(),
    updatedAt: request.updatedAt.toISOString()
  };
}

export function serializeVariable(variable: {
  id: string;
  key: string;
  initialValue: string;
  currentValue: string;
  enabled: boolean;
  scope: string;
  isSecret: boolean;
}): VariableValue {
  return {
    id: variable.id,
    key: variable.key,
    initialValue: variable.initialValue,
    currentValue: variable.currentValue,
    enabled: variable.enabled,
    scope: normalizeScope(variable.scope),
    isSecret: variable.isSecret
  };
}

export function serializeHistoryEntry(entry: {
  id: string;
  requestId: string | null;
  method: string;
  url: string;
  status: number | null;
  statusText: string | null;
  durationMs: number | null;
  sizeBytes: number | null;
  responseHeadersJson: string;
  responseBodyPreview: string | null;
  responseBodyTruncated: boolean;
  error: string | null;
  createdAt: Date;
}): ApiHistoryEntry {
  return {
    id: entry.id,
    requestId: entry.requestId,
    method: normalizeMethod(entry.method),
    url: entry.url,
    status: entry.status,
    statusText: entry.statusText,
    durationMs: entry.durationMs,
    sizeBytes: entry.sizeBytes,
    responseHeaders: parseJsonField<KeyValueRow[]>(entry.responseHeadersJson, []),
    responseBodyPreview: entry.responseBodyPreview,
    responseBodyTruncated: entry.responseBodyTruncated,
    error: entry.error,
    createdAt: entry.createdAt.toISOString()
  };
}

export function requestToPrismaInput(draft: RequestDraft) {
  return {
    name: draft.name || "Untitled Request",
    method: draft.method,
    url: draft.url,
    headersJson: stringifyJson(markSecretRows(draft.headers)),
    queryParamsJson: stringifyJson(markSecretRows(draft.queryParams)),
    bodyMode: draft.bodyMode,
    bodyRaw: draft.bodyRaw,
    authJson: stringifyJson(draft.auth ?? DEFAULT_AUTH),
    folderId: draft.folderId ?? null
  };
}

export function variableToPrismaInput(variable: Omit<VariableValue, "id">) {
  return {
    key: variable.key,
    initialValue: variable.initialValue,
    currentValue: variable.currentValue,
    enabled: variable.enabled,
    scope: variable.scope,
    isSecret: variable.isSecret || inferIsSecret(variable.key)
  };
}

function serializeCollection(collection: {
  id: string;
  name: string;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
  folders: Array<{
    id: string;
    name: string;
    collectionId: string;
    parentId: string | null;
  }>;
  requests: Array<Parameters<typeof serializeRequest>[0]>;
  variables: Array<Parameters<typeof serializeVariable>[0]>;
}): ApiCollection {
  const requestsByFolder = new Map<string | null, ApiRequest[]>();
  for (const request of collection.requests.map(serializeRequest)) {
    const key = request.folderId ?? null;
    requestsByFolder.set(key, [...(requestsByFolder.get(key) ?? []), request]);
  }

  const foldersById = new Map<string, ApiFolder>();
  for (const folder of collection.folders) {
    foldersById.set(folder.id, {
      id: folder.id,
      name: folder.name,
      collectionId: folder.collectionId,
      parentId: folder.parentId,
      children: [],
      requests: requestsByFolder.get(folder.id) ?? []
    });
  }

  const rootFolders: ApiFolder[] = [];
  for (const folder of foldersById.values()) {
    if (folder.parentId && foldersById.has(folder.parentId)) {
      foldersById.get(folder.parentId)?.children.push(folder);
    } else {
      rootFolders.push(folder);
    }
  }

  return {
    id: collection.id,
    name: collection.name,
    description: collection.description,
    folders: rootFolders,
    requests: requestsByFolder.get(null) ?? [],
    variables: collection.variables.map(serializeVariable),
    createdAt: collection.createdAt.toISOString(),
    updatedAt: collection.updatedAt.toISOString()
  };
}

function serializeEnvironment(environment: {
  id: string;
  name: string;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
  variables: Array<Parameters<typeof serializeVariable>[0]>;
}): ApiEnvironment {
  return {
    id: environment.id,
    name: environment.name,
    active: environment.active,
    variables: environment.variables.map(serializeVariable),
    createdAt: environment.createdAt.toISOString(),
    updatedAt: environment.updatedAt.toISOString()
  };
}

function normalizeMethod(method: string): HttpMethod {
  const upper = method.toUpperCase();

  if (
    upper === "GET" ||
    upper === "POST" ||
    upper === "PUT" ||
    upper === "PATCH" ||
    upper === "DELETE" ||
    upper === "HEAD" ||
    upper === "OPTIONS"
  ) {
    return upper;
  }

  return "GET";
}

function normalizeBodyMode(mode: string): BodyMode {
  if (
    mode === "raw_json" ||
    mode === "raw_text" ||
    mode === "form_urlencoded" ||
    mode === "multipart"
  ) {
    return mode;
  }

  return "none";
}

function markSecretRows(rows: KeyValueRow[]): KeyValueRow[] {
  return rows.map((row) => ({
    ...row,
    isSecret: row.isSecret || inferIsSecret(row.key)
  }));
}
