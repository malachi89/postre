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

  const updated = await prisma.request.update({
    where: { id },
    data: requestToPrismaInput(body),
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
