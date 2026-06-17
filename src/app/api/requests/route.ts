import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requestToPrismaInput, serializeRequest } from "@/lib/server/data";
import type { RequestDraft } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as Partial<RequestDraft> & { collectionId?: string };

    if (!body.collectionId) {
      return NextResponse.json({ error: "collectionId is required" }, { status: 400 });
    }

    const folderId = await resolveFolderId(body.collectionId, body.folderId ?? null);

    const created = await prisma.request.create({
      data: {
        ...requestToPrismaInput({
          name: body.name ?? "New Request",
          method: body.method ?? "GET",
          url: body.url ?? "",
          headers: body.headers ?? [],
          queryParams: body.queryParams ?? [],
          bodyMode: body.bodyMode ?? "none",
          bodyRawFormat: body.bodyRawFormat ?? "json",
          bodyRaw: body.bodyRaw ?? "",
          preRequestScript: body.preRequestScript ?? "",
          postRequestScript: body.postRequestScript ?? "",
          auth: body.auth ?? { type: "none" },
          collectionId: body.collectionId,
          folderId
        }),
        collectionId: body.collectionId
      },
      include: { variables: true }
    });

    return NextResponse.json(serializeRequest(created));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not create request.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

async function resolveFolderId(collectionId: string, folderId: string | null) {
  if (!folderId) {
    return null;
  }

  const folder = await prisma.folder.findFirst({
    where: {
      id: folderId,
      collectionId
    },
    select: { id: true }
  });

  return folder?.id ?? null;
}
