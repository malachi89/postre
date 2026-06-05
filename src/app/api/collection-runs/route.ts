import { NextRequest, NextResponse } from "next/server";
import { createCollectionRun, listCollectionRunSummaries } from "@/lib/server/collection-runs";
import type { CollectionRunTargetType } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      target?: { type?: CollectionRunTargetType; id?: string };
      activeEnvironmentId?: string | null;
      iterations?: number;
      delayMs?: number;
      requestIds?: string[];
      stopOnError?: boolean;
    };

    if (!body.target?.id || (body.target.type !== "collection" && body.target.type !== "folder")) {
      return NextResponse.json({ error: "target is required" }, { status: 400 });
    }

    const report = await createCollectionRun({
      target: {
        type: body.target.type,
        id: body.target.id
      },
      activeEnvironmentId: body.activeEnvironmentId ?? null,
      iterations: body.iterations,
      delayMs: body.delayMs,
      requestIds: body.requestIds,
      stopOnError: body.stopOnError
    });

    return NextResponse.json(report);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not run collection.";
    const status = /not found|does not belong|Select at least one|has no requests/i.test(message) ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function GET(request: NextRequest) {
  const collectionId = request.nextUrl.searchParams.get("collectionId");
  if (!collectionId) {
    return NextResponse.json({ error: "collectionId is required" }, { status: 400 });
  }

  const take = Number(request.nextUrl.searchParams.get("take") ?? "20");
  const runs = await listCollectionRunSummaries(collectionId, Number.isFinite(take) ? take : 20);
  return NextResponse.json(runs);
}
