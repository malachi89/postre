import { prisma } from "@/lib/db";
import { stringifyJson } from "@/lib/json";
import { applyScriptMutations, runRequestScript } from "@/lib/request-scripts";
import { getScriptFields, getVariablesForDraft, requestToPrismaInput } from "@/lib/server/data";
import { executeHttpRequest } from "@/lib/http-executor";
import { getCookieHeaderForUrl, storeResponseCookies } from "@/lib/server/cookies";
import { resolveEffectiveScriptSources } from "@/lib/server/script-inheritance";
import { resolveRequestDraft } from "@/lib/variable-resolver";
import type { RequestDraft, ScriptExecutionResult, SendResult } from "@/lib/types";

export const RESPONSE_HISTORY_LIMIT = 120_000;

export interface ScriptSource {
  script: string;
  source?: string;
}

export interface ExecuteRequestInput {
  draft: RequestDraft;
  activeEnvironmentId: string | null;
  timeoutMs?: number;
  preScripts?: ScriptSource[];
  postScripts?: ScriptSource[];
  persistDraft?: boolean;
  failOnPostScriptError?: boolean;
  persistHistoryOnRuntimeError?: boolean;
}

export interface ExecuteRequestSuccess {
  ok: true;
  result: SendResult;
  resolvedDraft: RequestDraft;
  scriptResults: ScriptExecutionResult[];
}

export interface ExecuteRequestFailure {
  ok: false;
  status: number;
  error: string;
  scriptResults: ScriptExecutionResult[];
  resolvedDraft?: RequestDraft;
  missingVariables?: string[];
  durationMs?: number;
  response?: SendResult;
}

export type ExecuteRequestOutcome = ExecuteRequestSuccess | ExecuteRequestFailure;

export async function executeRequest(input: ExecuteRequestInput): Promise<ExecuteRequestOutcome> {
  const activeEnvironmentId = input.activeEnvironmentId ?? null;
  const draft = input.persistDraft === false ? input.draft : await saveDraftBeforeSend(input.draft);
  const scriptResults: ScriptExecutionResult[] = [];
  const inheritedScripts =
    input.preScripts === undefined || input.postScripts === undefined
      ? await loadEffectiveScriptSourcesForDraft(draft)
      : null;
  const preScripts = normalizeScriptSources(input.preScripts, inheritedScripts?.preScripts ?? []);
  const postScripts = normalizeScriptSources(input.postScripts, inheritedScripts?.postScripts ?? []);

  for (const scriptSource of preScripts) {
    const run = await runRequestScript({
      phase: "pre-request",
      script: scriptSource.script,
      draft,
      variables: await getVariablesForDraft(draft, activeEnvironmentId),
      activeEnvironmentId
    });
    const result = withScriptSource(run.result, scriptSource.source);
    if (scriptSource.script.trim()) {
      scriptResults.push(result);
    }

    if (!result.ok) {
      if (input.persistHistoryOnRuntimeError) {
        await saveErrorHistory(draft, draft.url, result.error ?? "Pre-request script failed");
      }
      return {
        ok: false,
        status: 400,
        error: "Pre-request script failed",
        scriptResults
      };
    }

    try {
      await applyScriptMutations(run.mutations, draft, activeEnvironmentId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not apply pre-request script variables.";
      const lastResult = scriptResults.at(-1);
      if (lastResult?.phase === "pre-request") {
        lastResult.ok = false;
        lastResult.error = message;
      }
      if (input.persistHistoryOnRuntimeError) {
        await saveErrorHistory(draft, draft.url, message);
      }
      return {
        ok: false,
        status: 400,
        error: "Pre-request script failed",
        scriptResults
      };
    }
  }

  const variables = await getVariablesForDraft(draft, activeEnvironmentId);
  const resolved = resolveRequestDraft(draft, variables);

  if (resolved.missingVariables.length > 0) {
    if (input.persistHistoryOnRuntimeError) {
      await saveErrorHistory(draft, resolved.draft.url, `Missing variables: ${resolved.missingVariables.join(", ")}`);
    }
    return {
      ok: false,
      status: 400,
      error: "Missing variables",
      missingVariables: resolved.missingVariables,
      resolvedDraft: resolved.draft,
      scriptResults
    };
  }

  const cookieHeader = await getCookieHeaderForUrl(resolved.draft.url);
  const httpResult = await executeHttpRequest(resolved.draft, input.timeoutMs, cookieHeader);
  if ("error" in httpResult) {
    await saveErrorHistory(draft, resolved.draft.url, httpResult.error, httpResult.durationMs);
    return {
      ok: false,
      status: 502,
      error: httpResult.error,
      durationMs: httpResult.durationMs,
      resolvedDraft: resolved.draft,
      scriptResults
    };
  }

  await storeResponseCookies(resolved.draft.url, getSetCookieHeaders(httpResult.headers));

  for (const scriptSource of postScripts) {
    const run = await runRequestScript({
      phase: "post-request",
      script: scriptSource.script,
      draft: resolved.draft,
      variables: await getVariablesForDraft(draft, activeEnvironmentId),
      activeEnvironmentId,
      response: httpResult
    });
    const result = withScriptSource(run.result, scriptSource.source);
    if (scriptSource.script.trim()) {
      scriptResults.push(result);
    }

    if (!result.ok) {
      if (input.failOnPostScriptError) {
        await saveHistory(draft, resolved.draft.url, httpResult);
        return {
          ok: false,
          status: 400,
          error: "Post-request script failed",
          resolvedDraft: resolved.draft,
          scriptResults,
          response: httpResult
        };
      }
      continue;
    }

    try {
      await applyScriptMutations(run.mutations, draft, activeEnvironmentId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not apply post-request script variables.";
      const lastResult = scriptResults.at(-1);
      if (lastResult?.phase === "post-request") {
        lastResult.ok = false;
        lastResult.error = message;
      }
      if (input.failOnPostScriptError) {
        await saveHistory(draft, resolved.draft.url, httpResult);
        return {
          ok: false,
          status: 400,
          error: "Post-request script failed",
          resolvedDraft: resolved.draft,
          scriptResults,
          response: httpResult
        };
      }
    }
  }

  await saveHistory(draft, resolved.draft.url, httpResult);

  return {
    ok: true,
    result: httpResult,
    resolvedDraft: resolved.draft,
    scriptResults
  };
}

function getSetCookieHeaders(headers: SendResult["headers"]): string[] {
  return headers
    .filter((header) => header.key.toLowerCase() === "set-cookie")
    .map((header) => header.value);
}

async function saveDraftBeforeSend(draft: RequestDraft): Promise<RequestDraft> {
  if (!draft.id) {
    return draft;
  }

  await prisma.request.update({
    where: { id: draft.id },
    data: requestToPrismaInput(draft)
  });

  return draft;
}

async function saveErrorHistory(
  originalDraft: RequestDraft,
  resolvedUrl: string,
  error: string,
  durationMs?: number
) {
  await prisma.historyEntry.create({
    data: {
      requestId: originalDraft.id ?? null,
      method: originalDraft.method,
      url: resolvedUrl,
      error,
      durationMs: durationMs ?? null
    }
  });
}

async function saveHistory(originalDraft: RequestDraft, resolvedUrl: string, result: SendResult) {
  const truncated = result.body.length > RESPONSE_HISTORY_LIMIT;

  await prisma.historyEntry.create({
    data: {
      requestId: originalDraft.id ?? null,
      method: originalDraft.method,
      url: resolvedUrl,
      status: result.status,
      statusText: result.statusText,
      durationMs: result.durationMs,
      sizeBytes: result.sizeBytes,
      responseHeadersJson: stringifyJson(result.headers),
      responseBodyPreview: truncated ? result.body.slice(0, RESPONSE_HISTORY_LIMIT) : result.body,
      responseBodyTruncated: truncated
    }
  });
}

async function loadEffectiveScriptSourcesForDraft(draft: RequestDraft): Promise<{
  preScripts: ScriptSource[];
  postScripts: ScriptSource[];
}> {
  if (!draft.id) {
    return resolveEffectiveScriptSources({
      collection: {},
      folders: [],
      request: {
        name: draft.name || "Untitled Request",
        preRequestScript: draft.preRequestScript,
        postRequestScript: draft.postRequestScript
      }
    });
  }

  const request = await prisma.request.findUnique({
    where: { id: draft.id },
    select: {
      id: true,
      name: true,
      collectionId: true,
      folderId: true,
      preRequestScript: true,
      postRequestScript: true,
      metadataJson: true,
      collection: {
        select: {
          preRequestScript: true,
          postRequestScript: true,
          metadataJson: true
        }
      }
    }
  });

  if (!request) {
    return resolveEffectiveScriptSources({
      collection: {},
      folders: [],
      request: {
        name: draft.name || "Untitled Request",
        preRequestScript: draft.preRequestScript,
        postRequestScript: draft.postRequestScript
      }
    });
  }

  const folders = request.folderId
    ? await prisma.folder.findMany({
        where: { collectionId: request.collectionId },
        select: {
          id: true,
          name: true,
          parentId: true,
          preRequestScript: true,
          postRequestScript: true,
          metadataJson: true
        }
      })
    : [];

  return resolveEffectiveScriptSources({
    collection: getScriptFields(request.collection),
    folders: getFolderLineage(folders, request.folderId).map((folder) => ({
      name: folder.name,
      ...getScriptFields(folder)
    })),
    request: {
      name: request.name,
      ...getScriptFields(request)
    }
  });
}

function getFolderLineage<T extends { id: string; parentId: string | null }>(
  folders: T[],
  folderId: string | null
): T[] {
  const foldersById = new Map(folders.map((folder) => [folder.id, folder]));
  const lineage: T[] = [];
  let currentId = folderId;

  while (currentId) {
    const folder = foldersById.get(currentId);
    if (!folder) {
      break;
    }
    lineage.unshift(folder);
    currentId = folder.parentId;
  }

  return lineage;
}

function normalizeScriptSources(sources: ScriptSource[] | undefined, fallbackSources: ScriptSource[]): ScriptSource[] {
  if (sources !== undefined) {
    return sources;
  }

  return fallbackSources;
}

function withScriptSource(result: ScriptExecutionResult, source: string | undefined): ScriptExecutionResult {
  return source ? { ...result, source } : result;
}
