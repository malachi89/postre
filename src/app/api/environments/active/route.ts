import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function PATCH(request: NextRequest) {
  const body = (await request.json()) as { environmentId?: string | null };

  await prisma.$transaction([
    prisma.environment.updateMany({ data: { active: false } }),
    ...(body.environmentId
      ? [
          prisma.environment.update({
            where: { id: body.environmentId },
            data: { active: true }
          })
        ]
      : [])
  ]);

  return NextResponse.json({ activeEnvironmentId: body.environmentId ?? null });
}
