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
    description?: string | null;
    preRequestScript?: string | null;
    postRequestScript?: string | null;
  }>(request);
  if (parsed.error) {
    return parsed.error;
  }
  const body = parsed.body;

  try {
    const collection = await prisma.collection.update({
      where: { id },
      data: {
        name: body.name?.trim() || undefined,
        description: Object.prototype.hasOwnProperty.call(body, "description") ? body.description ?? null : undefined,
        preRequestScript: Object.prototype.hasOwnProperty.call(body, "preRequestScript")
          ? body.preRequestScript ?? ""
          : undefined,
        postRequestScript: Object.prototype.hasOwnProperty.call(body, "postRequestScript")
          ? body.postRequestScript ?? ""
          : undefined
      }
    });

    return NextResponse.json({ id: collection.id });
  } catch (error) {
    return prismaErrorResponse(error) ?? NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not update collection" },
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
    await prisma.collection.delete({ where: { id } });
  } catch (error) {
    return prismaErrorResponse(error) ?? NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not delete collection" },
      { status: 500 }
    );
  }
  return NextResponse.json({ ok: true });
}
