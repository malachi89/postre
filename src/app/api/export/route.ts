import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { serializeCollection, serializeEnvironment } from "@/lib/server/data";
import { buildPostmanExport } from "@/lib/postman-exporter";

export const dynamic = "force-dynamic";

export async function GET() {
  const [collections, environments] = await Promise.all([
    prisma.collection.findMany({
      orderBy: { createdAt: "asc" },
      include: {
        folders: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
        requests: {
          orderBy: { createdAt: "asc" },
          include: { variables: { orderBy: { createdAt: "asc" } } }
        },
        variables: { orderBy: { createdAt: "asc" } }
      }
    }),
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
