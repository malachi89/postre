import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { serializeHistoryEntry } from "@/lib/server/data";

export const dynamic = "force-dynamic";

export async function GET() {
  const history = await prisma.historyEntry.findMany({
    orderBy: { createdAt: "desc" },
    take: 50
  });

  return NextResponse.json(history.map(serializeHistoryEntry));
}
