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
