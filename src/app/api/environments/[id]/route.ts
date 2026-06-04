import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const body = (await request.json()) as { name?: string };

  const environment = await prisma.environment.update({
    where: { id },
    data: {
      name: body.name?.trim() || undefined
    }
  });

  return NextResponse.json({ id: environment.id });
}

export async function DELETE(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  await prisma.environment.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
