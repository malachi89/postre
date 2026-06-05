import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requestToPrismaInput, serializeRequest } from "@/lib/server/data";
import type { RequestDraft } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const body = (await request.json()) as RequestDraft;
  const location = await resolveRequestLocation(id, body);

  if ("error" in location) {
    return NextResponse.json({ error: location.error }, { status: 400 });
  }

  const updated = await prisma.request.update({
    where: { id },
    data: {
      ...requestToPrismaInput(body),
      collectionId: location.collectionId,
      folderId: location.folderId
    },
    include: { variables: true }
  });

  return NextResponse.json(serializeRequest(updated));
}

export async function DELETE(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  await prisma.request.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}

async function resolveRequestLocation(requestId: string, draft: RequestDraft) {
  if (draft.folderId) {
    const folder = await prisma.folder.findUnique({
      where: { id: draft.folderId },
      select: { id: true, collectionId: true }
    });

    if (!folder) {
      return { error: "folderId is invalid" } as const;
    }

    return {
      collectionId: folder.collectionId,
      folderId: folder.id
    };
  }

  if (draft.collectionId) {
    const collection = await prisma.collection.findUnique({
      where: { id: draft.collectionId },
      select: { id: true }
    });

    if (!collection) {
      return { error: "collectionId is invalid" } as const;
    }

    return {
      collectionId: collection.id,
      folderId: null
    };
  }

  const existingRequest = await prisma.request.findUnique({
    where: { id: requestId },
    select: { collectionId: true }
  });

  if (!existingRequest) {
    return { error: "Request not found" } as const;
  }

  return {
    collectionId: existingRequest.collectionId,
    folderId: null
  };
}
