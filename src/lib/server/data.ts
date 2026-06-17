import { prisma } from "@/lib/db";
import { parseJsonField, stringifyJson } from "@/lib/json";
import { extractPostmanScripts } from "@/lib/postman-importer";
import type {
  ApiCollection,
  ApiCollectionRunReport,
  ApiCollectionRunStep,
  ApiCollectionRunSummary,
  ApiEnvironment,
  ApiFolder,
  ApiHistoryEntry,
  ApiRequest,
  AppData,
  AuthConfig,
  BodyMode,
  RawFormat,
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
  bodyRawFormat?: string | null;
  bodyRaw: string | null;
  preRequestScript?: string | null;
  postRequestScript?: string | null;
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
    bodyRawFormat: normalizeRawFormat(request.bodyRawFormat),
    bodyRaw: request.bodyRaw ?? "",
    preRequestScript: request.preRequestScript ?? "",
    postRequestScript: request.postRequestScript ?? "",
    auth: parseJsonField<AuthConfig>(request.authJson, DEFAULT_AUTH),
    variables: (request.variables ?? []).map(serializeVariable),
    createdAt: request.createdAt.toISOString(),
    updatedAt: request.updatedAt.toISOString()
  };
}

export function getScriptFields(record: {
  preRequestScript?: string | null;
  postRequestScript?: string | null;
  metadataJson?: string | null;
}) {
  const savedPreRequestScript = record.preRequestScript ?? "";
  const savedPostRequestScript = record.postRequestScript ?? "";

  if (savedPreRequestScript.trim() || savedPostRequestScript.trim()) {
    return {
      preRequestScript: savedPreRequestScript,
      postRequestScript: savedPostRequestScript
    };
  }

  const metadata = parseJsonField<Record<string, unknown>>(record.metadataJson, {});
  const fallback = extractPostmanScripts(Array.isArray(metadata.event) ? metadata.event : []);

  return {
    preRequestScript: fallback.preRequestScript,
    postRequestScript: fallback.postRequestScript
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
    bodyRawFormat: draft.bodyRawFormat,
    bodyRaw: draft.bodyRaw,
    preRequestScript: draft.preRequestScript ?? "",
    postRequestScript: draft.postRequestScript ?? "",
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

export function serializeCollection(collection: {
  id: string;
  name: string;
  description: string | null;
  preRequestScript?: string | null;
  postRequestScript?: string | null;
  metadataJson?: string;
  createdAt: Date;
  updatedAt: Date;
  folders: Array<{
    id: string;
    name: string;
    collectionId: string;
    parentId: string | null;
    preRequestScript?: string | null;
    postRequestScript?: string | null;
    metadataJson?: string;
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
    const folderScripts = getScriptFields(folder);
    foldersById.set(folder.id, {
      id: folder.id,
      name: folder.name,
      collectionId: folder.collectionId,
      parentId: folder.parentId,
      preRequestScript: folderScripts.preRequestScript,
      postRequestScript: folderScripts.postRequestScript,
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

  const collectionScripts = getScriptFields(collection);

  return {
    id: collection.id,
    name: collection.name,
    description: collection.description,
    preRequestScript: collectionScripts.preRequestScript,
    postRequestScript: collectionScripts.postRequestScript,
    folders: rootFolders,
    requests: requestsByFolder.get(null) ?? [],
    variables: collection.variables.map(serializeVariable),
    createdAt: collection.createdAt.toISOString(),
    updatedAt: collection.updatedAt.toISOString()
  };
}

export function serializeCollectionRunSummary(run: {
  id: string;
  collectionId: string;
  targetType: string;
  targetId: string;
  targetName: string;
  environmentId: string | null;
  iterations: number;
  delayMs: number;
  stopOnError: boolean;
  status: string;
  requestOrderJson: string;
  totalSteps: number;
  completedSteps: number;
  successCount: number;
  errorCount: number;
  createdAt: Date;
  finishedAt: Date | null;
}): ApiCollectionRunSummary {
  return {
    id: run.id,
    collectionId: run.collectionId,
    targetType: run.targetType === "folder" ? "folder" : "collection",
    targetId: run.targetId,
    targetName: run.targetName,
    environmentId: run.environmentId,
    iterations: run.iterations,
    delayMs: run.delayMs,
    stopOnError: run.stopOnError,
    status:
      run.status === "running" ||
      run.status === "completed" ||
      run.status === "completed_with_errors" ||
      run.status === "stopped"
        ? run.status
        : "completed",
    requestOrder: parseJsonField<string[]>(run.requestOrderJson, []),
    totalSteps: run.totalSteps,
    completedSteps: run.completedSteps,
    successCount: run.successCount,
    errorCount: run.errorCount,
    createdAt: run.createdAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null
  };
}

export function serializeCollectionRunStep(step: {
  id: string;
  requestId: string | null;
  iteration: number;
  sequence: number;
  requestName: string;
  method: string;
  resolvedUrl: string | null;
  status: number | null;
  statusText: string | null;
  durationMs: number | null;
  sizeBytes: number | null;
  responseHeadersJson: string;
  responseBodyPreview: string | null;
  responseBodyTruncated: boolean;
  error: string | null;
  missingVariablesJson: string;
  scriptResultsJson: string;
  createdAt: Date;
}): ApiCollectionRunStep {
  return {
    id: step.id,
    requestId: step.requestId,
    iteration: step.iteration,
    sequence: step.sequence,
    requestName: step.requestName,
    method: normalizeMethod(step.method),
    resolvedUrl: step.resolvedUrl,
    status: step.status,
    statusText: step.statusText,
    durationMs: step.durationMs,
    sizeBytes: step.sizeBytes,
    responseHeaders: parseJsonField<KeyValueRow[]>(step.responseHeadersJson, []),
    responseBodyPreview: step.responseBodyPreview,
    responseBodyTruncated: step.responseBodyTruncated,
    error: step.error,
    missingVariables: parseJsonField<string[]>(step.missingVariablesJson, []),
    scriptResults: parseJsonField<ApiCollectionRunStep["scriptResults"]>(step.scriptResultsJson, []),
    createdAt: step.createdAt.toISOString()
  };
}

export function serializeCollectionRunReport(run: {
  id: string;
  collectionId: string;
  targetType: string;
  targetId: string;
  targetName: string;
  environmentId: string | null;
  iterations: number;
  delayMs: number;
  stopOnError: boolean;
  status: string;
  requestOrderJson: string;
  totalSteps: number;
  completedSteps: number;
  successCount: number;
  errorCount: number;
  createdAt: Date;
  finishedAt: Date | null;
  steps: Array<Parameters<typeof serializeCollectionRunStep>[0]>;
}): ApiCollectionRunReport {
  return {
    run: serializeCollectionRunSummary(run),
    steps: run.steps.map(serializeCollectionRunStep)
  };
}

export function serializeEnvironment(environment: {
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
    mode === "raw" ||
    mode === "formdata" ||
    mode === "form_urlencoded" ||
    mode === "binary"
  ) {
    return mode;
  }

  // Migrate legacy modes
  if (mode === "raw_json" || mode === "raw_text") return "raw";
  if (mode === "multipart") return "formdata";

  return "none";
}

function normalizeRawFormat(format: string | null | undefined): RawFormat {
  if (
    format === "json" ||
    format === "text" ||
    format === "xml" ||
    format === "javascript" ||
    format === "html"
  ) {
    return format;
  }
  return "json";
}

function markSecretRows(rows: KeyValueRow[]): KeyValueRow[] {
  return rows.map((row) => ({
    ...row,
    isSecret: row.isSecret || inferIsSecret(row.key)
  }));
}
