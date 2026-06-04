import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requestToPrismaInput, serializeRequest } from "@/lib/server/data";
import type { RequestDraft } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const body = (await request.json()) as Partial<RequestDraft> & { collectionId?: string };

  if (!body.collectionId) {
    return NextResponse.json({ error: "collectionId is required" }, { status: 400 });
  }

  const created = await prisma.request.create({
    data: {
      ...requestToPrismaInput({
        name: body.name ?? "New Request",
        method: body.method ?? "GET",
        url: body.url ?? "",
        headers: body.headers ?? [],
        queryParams: body.queryParams ?? [],
        bodyMode: body.bodyMode ?? "none",
        bodyRaw: body.bodyRaw ?? "",
        auth: body.auth ?? { type: "none" },
        collectionId: body.collectionId,
        folderId: body.folderId ?? null
      }),
      collectionId: body.collectionId
    },
    include: { variables: true }
  });

  return NextResponse.json(serializeRequest(created));
}
