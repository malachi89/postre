import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { variableToPrismaInput } from "@/lib/server/data";
import type { VariableScope, VariableValue } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function PUT(request: NextRequest) {
  const body = (await request.json()) as {
    scope?: VariableScope;
    environmentId?: string | null;
    collectionId?: string | null;
    requestId?: string | null;
    variables?: Array<Omit<VariableValue, "id">>;
  };

  if (!body.scope || !body.variables) {
    return NextResponse.json({ error: "scope and variables are required" }, { status: 400 });
  }

  const where =
    body.scope === "GLOBAL"
      ? { scope: "GLOBAL" }
      : body.scope === "ENVIRONMENT"
        ? { scope: "ENVIRONMENT", environmentId: body.environmentId ?? "" }
        : body.scope === "COLLECTION"
          ? { scope: "COLLECTION", collectionId: body.collectionId ?? "" }
          : { scope: "REQUEST", requestId: body.requestId ?? "" };

  await prisma.$transaction([
    prisma.variable.deleteMany({ where }),
    ...body.variables
      .filter((variable) => variable.key.trim())
      .map((variable) =>
        prisma.variable.create({
          data: {
            ...variableToPrismaInput({
              ...variable,
              key: variable.key.trim(),
              scope: body.scope as VariableScope
            }),
            environmentId: body.scope === "ENVIRONMENT" ? body.environmentId ?? null : null,
            collectionId: body.scope === "COLLECTION" ? body.collectionId ?? null : null,
            requestId: body.scope === "REQUEST" ? body.requestId ?? null : null
          }
        })
      )
  ]);

  return NextResponse.json({ ok: true });
}
