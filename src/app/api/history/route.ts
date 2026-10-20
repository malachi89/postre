import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { HISTORY_LIST_ENTRIES, serializeHistoryEntry } from "@/lib/server/data";

export const dynamic = "force-dynamic";

export async function GET() {
  const history = await prisma.historyEntry.findMany({
    orderBy: { createdAt: "desc" },
    take: HISTORY_LIST_ENTRIES
  });

  return NextResponse.json(history.map(serializeHistoryEntry));
}
