import { NextRequest, NextResponse } from "next/server";
import { getCollectionRunReport } from "@/lib/server/collection-runs";

export const dynamic = "force-dynamic";

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const report = await getCollectionRunReport(id);
    return NextResponse.json(report);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Collection run not found.";
    return NextResponse.json({ error: message }, { status: 404 });
  }
}
