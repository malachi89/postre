import { NextRequest, NextResponse } from "next/server";
import { executeHttpRequest } from "@/lib/http-executor";
import { prisma } from "@/lib/db";
import { stringifyJson } from "@/lib/json";
import { getVariablesForDraft } from "@/lib/server/data";
import { resolveRequestDraft } from "@/lib/variable-resolver";
import type { RequestDraft, SendResult } from "@/lib/types";

export const dynamic = "force-dynamic";

const RESPONSE_HISTORY_LIMIT = 120_000;

export async function POST(request: NextRequest) {
  const body = (await request.json()) as {
    draft?: RequestDraft;
    activeEnvironmentId?: string | null;
    timeoutMs?: number;
  };

  if (!body.draft) {
    return NextResponse.json({ error: "draft is required" }, { status: 400 });
  }

  const variables = await getVariablesForDraft(body.draft, body.activeEnvironmentId ?? null);
  const resolved = resolveRequestDraft(body.draft, variables);

  if (resolved.missingVariables.length > 0) {
    return NextResponse.json(
      {
        error: "Missing variables",
        missingVariables: resolved.missingVariables,
        resolvedDraft: resolved.draft
      },
      { status: 400 }
    );
  }

  const result = await executeHttpRequest(resolved.draft, body.timeoutMs);

  if ("error" in result) {
    await prisma.historyEntry.create({
      data: {
        requestId: body.draft.id ?? null,
        method: body.draft.method,
        url: resolved.draft.url,
        error: result.error,
        durationMs: result.durationMs ?? null
      }
    });

    return NextResponse.json(result, { status: 502 });
  }

  await saveHistory(body.draft, resolved.draft.url, result);

  return NextResponse.json({
    ...result,
    resolvedDraft: resolved.draft
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
