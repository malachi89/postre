import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { asString, parseJsonBody } from "@/lib/server/api-error";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const { body, error } = await parseJsonBody<{ name?: string }>(request);
  if (error) {
    return error;
  }

  // Transaction so two concurrent creates can't both observe "no active env".
  const environment = await prisma.$transaction(async (tx) => {
    const hasActive = await tx.environment.findFirst({ where: { active: true } });
    return tx.environment.create({
      data: {
        name: asString(body.name, "New Environment").trim() || "New Environment",
        active: hasActive === null
      }
    });
  });

  return NextResponse.json({ id: environment.id }, { status: 201 });
}
