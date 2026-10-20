import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { parseJsonBody, prismaErrorResponse } from "@/lib/server/api-error";

export const dynamic = "force-dynamic";

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const parsed = await parseJsonBody<{ name?: string }>(request);
  if (parsed.error) {
    return parsed.error;
  }
  const body = parsed.body;

  try {
    const environment = await prisma.environment.update({
      where: { id },
      data: {
        name: body.name?.trim() || undefined
      }
    });

    return NextResponse.json({ id: environment.id });
  } catch (error) {
    return prismaErrorResponse(error) ?? NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not update environment" },
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
    await prisma.environment.delete({ where: { id } });
  } catch (error) {
    return prismaErrorResponse(error) ?? NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not delete environment" },
      { status: 500 }
    );
  }
  return NextResponse.json({ ok: true });
}
