import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const body = (await request.json()) as { name?: string };

  const folder = await prisma.folder.update({
    where: { id },
    data: {
      name: body.name?.trim() || undefined
    }
  });

  return NextResponse.json({ id: folder.id });
}

export async function DELETE(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const folderIds = await collectFolderIds(id);

  await prisma.$transaction([
    prisma.request.deleteMany({ where: { folderId: { in: folderIds } } }),
    prisma.folder.deleteMany({ where: { id: { in: folderIds } } })
  ]);

  return NextResponse.json({ ok: true });
}

async function collectFolderIds(folderId: string): Promise<string[]> {
  const children = await prisma.folder.findMany({
    where: { parentId: folderId },
    select: { id: true }
  });

  const nested = await Promise.all(children.map((child) => collectFolderIds(child.id)));

  return [folderId, ...nested.flat()];
}
