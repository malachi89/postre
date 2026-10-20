import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function PATCH(request: NextRequest) {
  const body = (await request.json()) as { environmentId?: string | null };

  await prisma.$transaction([
    prisma.environment.updateMany({ data: { active: false } }),
    // updateMany doesn't throw when the id no longer exists, unlike update (P2025).
    ...(body.environmentId
      ? [prisma.environment.updateMany({
            where: { id: body.environmentId },
            data: { active: true }
          })]
      : [])
  ]);

  const active = body.environmentId
    ? ((await prisma.environment.findFirst({ where: { active: true } }))?.id ?? null)
    : null;

  return NextResponse.json({ activeEnvironmentId: active });
}
