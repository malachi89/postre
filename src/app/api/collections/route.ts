import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { asNullableString, asString, parseJsonBody } from "@/lib/server/api-error";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const { body, error } = await parseJsonBody<{
    name?: string;
    description?: string | null;
    preRequestScript?: string | null;
    postRequestScript?: string | null;
  }>(request);
  if (error) {
    return error;
  }

  const collection = await prisma.collection.create({
    data: {
      name: asString(body.name, "New Collection").trim() || "New Collection",
      description: asNullableString(body.description),
      preRequestScript: asString(body.preRequestScript),
      postRequestScript: asString(body.postRequestScript)
    }
  });

  return NextResponse.json({ id: collection.id }, { status: 201 });
}
