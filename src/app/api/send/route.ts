import { NextRequest, NextResponse } from "next/server";
import { executeRequest } from "@/lib/server/request-execution";
import type { RequestDraft } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const body = (await request.json()) as {
    draft?: RequestDraft;
    activeEnvironmentId?: string | null;
    timeoutMs?: number;
  };

  if (!body.draft) {
    return NextResponse.json({ error: "draft is required" }, { status: 400 });
  }

  const outcome = await executeRequest({
    draft: body.draft,
    activeEnvironmentId: body.activeEnvironmentId ?? null,
    timeoutMs: body.timeoutMs
  });

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
