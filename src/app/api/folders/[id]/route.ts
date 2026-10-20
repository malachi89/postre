import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { parseJsonBody, prismaErrorResponse } from "@/lib/server/api-error";

export const dynamic = "force-dynamic";

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const parsed = await parseJsonBody<{
    name?: string;
    preRequestScript?: string | null;
    postRequestScript?: string | null;
  }>(request);
  if (parsed.error) {
    return parsed.error;
  }
  const body = parsed.body;

  try {
    const folder = await prisma.folder.update({
      where: { id },
      data: {
        name: body.name?.trim() || undefined,
        preRequestScript: Object.prototype.hasOwnProperty.call(body, "preRequestScript")
          ? body.preRequestScript ?? ""
          : undefined,
        postRequestScript: Object.prototype.hasOwnProperty.call(body, "postRequestScript")
          ? body.postRequestScript ?? ""
          : undefined
      }
    });

    return NextResponse.json({ id: folder.id });
  } catch (error) {
    return prismaErrorResponse(error) ?? NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not update folder" },
      { status: 500 }
    );
  }
}

export async function DELETE(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;

  try {
    const folderIds = await collectFolderIds(id);

    await prisma.$transaction([
      prisma.request.deleteMany({ where: { folderId: { in: folderIds } } }),
      prisma.folder.deleteMany({ where: { id: { in: folderIds } } })
    ]);
  } catch (error) {
    return prismaErrorResponse(error) ?? NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not delete folder" },
      { status: 500 }
    );
  }

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
