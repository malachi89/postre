import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const body = (await request.json()) as { name?: string; description?: string | null };

  const collection = await prisma.collection.update({
    where: { id },
    data: {
      name: body.name?.trim() || undefined,
      description: body.description ?? undefined
    }
  });

  return NextResponse.json({ id: collection.id });
}

export async function DELETE(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  await prisma.collection.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
