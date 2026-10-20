import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const body = (await request.json()) as {
    name?: string;
    collectionId?: string;
    parentId?: string | null;
    preRequestScript?: string | null;
    postRequestScript?: string | null;
  };

  if (!body.collectionId) {
    return NextResponse.json({ error: "collectionId is required" }, { status: 400 });
  }

  if (body.parentId) {
    const parent = await prisma.folder.findFirst({
      where: { id: body.parentId, collectionId: body.collectionId },
      select: { id: true }
    });
    if (!parent) {
      return NextResponse.json({ error: "parentId must be a folder of the same collection" }, { status: 400 });
    }
  }

  const folder = await prisma.folder.create({
    data: {
      name: body.name?.trim() || "New Folder",
      collectionId: body.collectionId,
      parentId: body.parentId ?? null,
      preRequestScript: body.preRequestScript ?? "",
      postRequestScript: body.postRequestScript ?? ""
    }
  });

  return NextResponse.json({ id: folder.id });
}
