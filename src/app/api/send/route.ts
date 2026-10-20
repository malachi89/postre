import { NextRequest, NextResponse } from "next/server";
import { executeRequest } from "@/lib/server/request-execution";
import { parseJsonBody } from "@/lib/server/api-error";
import type { RequestDraft } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const { body, error } = await parseJsonBody<{
    draft?: RequestDraft;
    activeEnvironmentId?: string | null;
    timeoutMs?: number;
  }>(request);

  if (error) {
    return error;
  }

  if (!body.draft) {
    return NextResponse.json({ error: "draft is required" }, { status: 400 });
  }

  let outcome;
  try {
    outcome = await executeRequest({
      draft: body.draft,
      activeEnvironmentId: body.activeEnvironmentId ?? null,
      timeoutMs: body.timeoutMs
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "Failed to execute request";
    return NextResponse.json({ error: message }, { status: 500 });
  }

  if (!outcome.ok) {
    return NextResponse.json(
      {
        error: outcome.error,
        missingVariables: outcome.missingVariables,
        resolvedDraft: outcome.resolvedDraft,
        durationMs: outcome.durationMs,
        scriptResults: outcome.scriptResults
      },
      { status: outcome.status }
    );
  }

  return NextResponse.json({
    ...outcome.result,
    resolvedDraft: outcome.resolvedDraft,
    scriptResults: outcome.scriptResults
  });
}
