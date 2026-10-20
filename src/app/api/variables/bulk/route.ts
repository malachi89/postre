import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { parseJsonBody } from "@/lib/server/api-error";
import { variableToPrismaInput } from "@/lib/server/data";
import type { VariableScope, VariableValue } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function PUT(request: NextRequest) {
  const { body, error } = await parseJsonBody<{
    scope?: VariableScope;
    environmentId?: string | null;
    collectionId?: string | null;
    requestId?: string | null;
    variables?: Array<Omit<VariableValue, "id">>;
  }>(request);

  if (error) {
    return error;
  }

  if (!body.scope || !body.variables) {
    return NextResponse.json({ error: "scope and variables are required" }, { status: 400 });
  }

  const parentId =
    body.scope === "ENVIRONMENT"
      ? body.environmentId
      : body.scope === "COLLECTION"
        ? body.collectionId
        : body.scope === "REQUEST"
          ? body.requestId
          : null;

  // Without this guard the delete would target id "" (no rows) while creates
  // would write orphan rows that nothing can ever resolve.
  if (body.scope !== "GLOBAL" && !parentId) {
    return NextResponse.json(
      { error: `${String(body.scope).toLowerCase()} id is required for scope ${body.scope}` },
      { status: 400 }
    );
  }

  const where =
    body.scope === "GLOBAL"
      ? { scope: "GLOBAL" }
      : body.scope === "ENVIRONMENT"
        ? { scope: "ENVIRONMENT", environmentId: parentId }
        : body.scope === "COLLECTION"
          ? { scope: "COLLECTION", collectionId: parentId }
          : { scope: "REQUEST", requestId: parentId };

  const rows = body.variables.filter(
    (variable) => typeof variable.key === "string" && variable.key.trim()
  );

  await prisma.$transaction([
    prisma.variable.deleteMany({ where }),
    ...rows.map((variable) =>
      prisma.variable.create({
        data: {
          ...variableToPrismaInput({
            ...variable,
            key: variable.key.trim(),
            scope: body.scope as VariableScope
          }),
          environmentId: body.scope === "ENVIRONMENT" ? parentId : null,
          collectionId: body.scope === "COLLECTION" ? parentId : null,
          requestId: body.scope === "REQUEST" ? parentId : null
        }
      })
    )
  ]);

  return NextResponse.json({ ok: true });
}
