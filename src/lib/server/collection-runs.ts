import { prisma } from "@/lib/db";
import { parseJsonField, stringifyJson } from "@/lib/json";
import {
  getScriptFields,
  serializeCollectionRunReport,
  serializeCollectionRunSummary
} from "@/lib/server/data";
import { executeRequest, RESPONSE_HISTORY_LIMIT, type ScriptSource } from "@/lib/server/request-execution";
import type {
  ApiCollectionRunReport,
  CollectionRunTargetType,
  RequestDraft,
  ScriptExecutionResult
} from "@/lib/types";

interface FolderRecord {
  id: string;
  name: string;
  collectionId: string;
  parentId: string | null;
  preRequestScript: string | null;
  postRequestScript: string | null;
  metadataJson: string;
  createdAt: Date;
  sortOrder: number;
}

interface RequestRecord {
  id: string;
  collectionId: string;
  folderId: string | null;
  name: string;
  method: string;
  url: string;
  headersJson: string;
  queryParamsJson: string;
  bodyMode: string;
  bodyRaw: string | null;
  preRequestScript: string | null;
  postRequestScript: string | null;
  authJson: string;
  createdAt: Date;
}

interface CollectionRecord {
  id: string;
  name: string;
  preRequestScript: string | null;
  postRequestScript: string | null;
  metadataJson: string;
  folders: FolderRecord[];
  requests: RequestRecord[];
}

export interface RunRequestPlan {
  id: string;
  name: string;
  method: string;
  folderId: string | null;
  path: string[];
  draft: RequestDraft;
  preScripts: ScriptSource[];
  postScripts: ScriptSource[];
}

export interface CreateCollectionRunInput {
  target: { type: CollectionRunTargetType; id: string };
  activeEnvironmentId: string | null;
  iterations?: number;
  delayMs?: number;
  requestIds?: string[];
  stopOnError?: boolean;
}

export async function createCollectionRun(input: CreateCollectionRunInput): Promise<ApiCollectionRunReport> {
  const target = await loadRunTarget(input.target);
  const requests = selectRunRequests(
    flattenRunRequests(target.collection, input.target),
    input.requestIds
  );
  const iterations = clamp(input.iterations ?? 1, 1, 100);
  const delayMs = clamp(input.delayMs ?? 0, 0, 60_000);
  const stopOnError = input.stopOnError ?? true;

  const run = await prisma.collectionRun.create({
    data: {
      collectionId: target.collection.id,
      targetType: input.target.type,
      targetId: input.target.id,
      targetName: target.targetName,
      environmentId: input.activeEnvironmentId,
      iterations,
      delayMs,
      stopOnError,
      requestOrderJson: stringifyJson(requests.map((request) => request.id)),
      totalSteps: requests.length * iterations
    }
  });

  let completedSteps = 0;
  let successCount = 0;
  let errorCount = 0;
  let stopped = false;
  let sequence = 0;

  for (let iteration = 1; iteration <= iterations; iteration += 1) {
    for (const request of requests) {
      sequence += 1;
      const outcome = await executeRequest({
        draft: request.draft,
        activeEnvironmentId: input.activeEnvironmentId,
        preScripts: request.preScripts,
        postScripts: request.postScripts,
        persistDraft: false,
        failOnPostScriptError: true,
        persistHistoryOnRuntimeError: true
      });

      completedSteps += 1;
      if (outcome.ok) {
        successCount += 1;
      } else {
        errorCount += 1;
      }

      await prisma.collectionRunStep.create({
        data: buildCollectionRunStepData(run.id, request, iteration, sequence, outcome)
      });

      await prisma.collectionRun.update({
        where: { id: run.id },
        data: {
          completedSteps,
          successCount,
          errorCount
        }
      });

      if (!outcome.ok && stopOnError) {
        stopped = true;
        break;
      }

      if (delayMs > 0 && !(iteration === iterations && request.id === requests.at(-1)?.id)) {
        await sleep(delayMs);
      }
    }

    if (stopped) {
      break;
    }
  }

  await prisma.collectionRun.update({
    where: { id: run.id },
    data: {
      completedSteps,
      successCount,
      errorCount,
      status: stopped
        ? "stopped"
        : errorCount > 0
          ? "completed_with_errors"
          : "completed",
      finishedAt: new Date()
    }
  });

  return getCollectionRunReport(run.id);
}

export async function listCollectionRunSummaries(collectionId: string, take = 20) {
  const runs = await prisma.collectionRun.findMany({
    where: { collectionId },
    orderBy: { createdAt: "desc" },
    take: clamp(take, 1, 100)
  });

  return runs.map((run) => ({
    ...serializeCollectionRunSummary(run)
  }));
}

export async function getCollectionRunReport(runId: string): Promise<ApiCollectionRunReport> {
  const run = await prisma.collectionRun.findUnique({
    where: { id: runId },
    include: {
      steps: {
        orderBy: { sequence: "asc" }
      }
    }
  });

  if (!run) {
    throw new Error("Collection run not found.");
  }

  return serializeCollectionRunReport(run);
}

export function flattenRunRequests(
  collection: CollectionRecord,
  target: { type: CollectionRunTargetType; id: string }
): RunRequestPlan[] {
  const collectionScripts = getScriptFields(collection);
  const foldersById = new Map(collection.folders.map((folder) => [folder.id, folder]));
  const childrenByParent = new Map<string | null, FolderRecord[]>();
  const requestsByFolder = new Map<string | null, RequestRecord[]>();

  for (const folder of collection.folders) {
    const siblings = childrenByParent.get(folder.parentId) ?? [];
    siblings.push(folder);
    childrenByParent.set(folder.parentId, siblings);
  }

  for (const request of collection.requests) {
    const siblings = requestsByFolder.get(request.folderId) ?? [];
    siblings.push(request);
    requestsByFolder.set(request.folderId, siblings);
  }

  for (const siblings of childrenByParent.values()) {
    siblings.sort((left, right) =>
      left.sortOrder === right.sortOrder
        ? left.createdAt.getTime() - right.createdAt.getTime()
        : left.sortOrder - right.sortOrder
    );
  }

  for (const siblings of requestsByFolder.values()) {
    siblings.sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
  }

  const result: RunRequestPlan[] = [];

  const visitFolder = (folder: FolderRecord, ancestors: FolderRecord[]) => {
    const lineage = [...ancestors, folder];
    for (const child of childrenByParent.get(folder.id) ?? []) {
      visitFolder(child, lineage);
    }

    for (const request of requestsByFolder.get(folder.id) ?? []) {
      result.push(toRunRequestPlan(collectionScripts, request, lineage));
    }
  };

  if (target.type === "folder") {
    const folder = foldersById.get(target.id);
    if (!folder) {
      throw new Error("Folder not found.");
    }
    visitFolder(folder, []);
    return result;
  }

  for (const folder of childrenByParent.get(null) ?? []) {
    visitFolder(folder, []);
  }
  for (const request of requestsByFolder.get(null) ?? []) {
    result.push(toRunRequestPlan(collectionScripts, request, []));
  }
  return result;
}

export function selectRunRequests(requests: RunRequestPlan[], requestIds?: string[]) {
  if (!requestIds || requestIds.length === 0) {
    if (requests.length === 0) {
      throw new Error("The selected target has no requests to run.");
    }
    return requests;
  }

  const requestsById = new Map(requests.map((request) => [request.id, request]));
  const selected: RunRequestPlan[] = [];
  const seen = new Set<string>();

  for (const requestId of requestIds) {
    if (seen.has(requestId)) {
      continue;
    }
    const request = requestsById.get(requestId);
    if (!request) {
      throw new Error(`Request "${requestId}" does not belong to the selected target.`);
    }
    seen.add(requestId);
    selected.push(request);
  }

  if (selected.length === 0) {
    throw new Error("Select at least one request to run.");
  }

  return selected;
}

async function loadRunTarget(target: { type: CollectionRunTargetType; id: string }) {
  if (target.type === "folder") {
    const folder = await prisma.folder.findUnique({
      where: { id: target.id },
      include: {
        collection: {
          include: {
            folders: {
              orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }]
            },
            requests: {
              orderBy: { createdAt: "asc" }
            }
          }
        }
      }
    });

    if (!folder) {
      throw new Error("Folder not found.");
    }

    return {
      collection: folder.collection as CollectionRecord,
      targetName: folder.name
    };
  }

  const collection = await prisma.collection.findUnique({
    where: { id: target.id },
    include: {
      folders: {
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }]
      },
      requests: {
        orderBy: { createdAt: "asc" }
      }
    }
  });

  if (!collection) {
    throw new Error("Collection not found.");
  }

  return {
    collection: collection as CollectionRecord,
    targetName: collection.name
  };
}

function toRunRequestPlan(
  collectionScripts: { preRequestScript: string; postRequestScript: string },
  request: RequestRecord,
  ancestors: FolderRecord[]
): RunRequestPlan {
  const folderScripts = ancestors.map((folder) => ({
    name: folder.name,
    ...getScriptFields(folder)
  }));
  const requestDraft = toRequestDraft(request);

  return {
    id: request.id,
    name: request.name,
    method: request.method,
    folderId: request.folderId,
    path: ancestors.map((folder) => folder.name),
    draft: requestDraft,
    preScripts: [
      { script: collectionScripts.preRequestScript, source: "Collection pre-request" },
      ...folderScripts.map((folder) => ({
        script: folder.preRequestScript,
        source: `Folder pre-request: ${folder.name}`
      })),
      { script: requestDraft.preRequestScript, source: `Request pre-request: ${request.name}` }
    ],
    postScripts: [
      { script: collectionScripts.postRequestScript, source: "Collection post-request" },
      ...folderScripts.map((folder) => ({
        script: folder.postRequestScript,
        source: `Folder post-request: ${folder.name}`
      })),
      { script: requestDraft.postRequestScript, source: `Request post-request: ${request.name}` }
    ]
  };
}

function toRequestDraft(request: RequestRecord): RequestDraft {
  return {
    id: request.id,
    collectionId: request.collectionId,
    folderId: request.folderId,
    name: request.name,
    method: normalizeMethod(request.method),
    url: request.url,
    headers: parseJsonField(request.headersJson, []),
    queryParams: parseJsonField(request.queryParamsJson, []),
    bodyMode: normalizeBodyMode(request.bodyMode),
    bodyRaw: request.bodyRaw ?? "",
    preRequestScript: request.preRequestScript ?? "",
    postRequestScript: request.postRequestScript ?? "",
    auth: parseJsonField(request.authJson, { type: "none" })
  };
}

function buildCollectionRunStepData(
  runId: string,
  request: RunRequestPlan,
  iteration: number,
  sequence: number,
  outcome: Awaited<ReturnType<typeof executeRequest>>
) {
  const response = outcome.ok ? outcome.result : outcome.response;
  const responseBody = response?.body ?? "";
  const truncated = responseBody.length > RESPONSE_HISTORY_LIMIT;

  return {
    runId,
    requestId: request.id,
    iteration,
    sequence,
    requestName: request.name,
    method: request.method,
    resolvedUrl: outcome.ok ? outcome.resolvedDraft.url : outcome.resolvedDraft?.url ?? null,
    status: response?.status ?? null,
    statusText: response?.statusText ?? null,
    durationMs: response?.durationMs ?? (outcome.ok ? null : outcome.durationMs ?? null),
    sizeBytes: response?.sizeBytes ?? null,
    responseHeadersJson: stringifyJson(response?.headers ?? []),
    responseBodyPreview: truncated ? responseBody.slice(0, RESPONSE_HISTORY_LIMIT) : responseBody || null,
    responseBodyTruncated: truncated,
    error: outcome.ok ? null : outcome.error,
    missingVariablesJson: stringifyJson(outcome.ok ? [] : outcome.missingVariables ?? []),
    scriptResultsJson: stringifyJson(outcome.scriptResults as ScriptExecutionResult[])
  };
}

function normalizeMethod(method: string): RequestDraft["method"] {
  return method === "POST" ||
    method === "PUT" ||
    method === "PATCH" ||
    method === "DELETE" ||
    method === "HEAD" ||
    method === "OPTIONS"
    ? method
    : "GET";
}

function normalizeBodyMode(mode: string): RequestDraft["bodyMode"] {
  return mode === "raw_json" ||
    mode === "raw_text" ||
    mode === "form_urlencoded" ||
    mode === "multipart"
    ? mode
    : "none";
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function sleep(delayMs: number) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
