import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const body = (await request.json()) as { name?: string };
  const hasActive = await prisma.environment.findFirst({ where: { active: true } });
  const environment = await prisma.environment.create({
    data: {
      name: body.name?.trim() || "New Environment",
      active: hasActive === null
    }
  });

  return NextResponse.json({ id: environment.id });
}
