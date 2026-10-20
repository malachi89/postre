import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCollectionsWithDetails, serializeCollection, serializeEnvironment } from "@/lib/server/data";
import { buildPostmanExport } from "@/lib/postman-exporter";

export const dynamic = "force-dynamic";

export async function GET() {
  const [collections, environments] = await Promise.all([
    getCollectionsWithDetails(),
    prisma.environment.findMany({
      orderBy: { createdAt: "asc" },
      include: { variables: { orderBy: { createdAt: "asc" } } }
    })
  ]);

  const exportData = buildPostmanExport(
    collections.map((c) => serializeCollection(c)),
    environments.map((e) => serializeEnvironment(e))
  );

  return NextResponse.json(exportData);
}
