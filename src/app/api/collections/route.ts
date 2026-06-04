import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const body = (await request.json()) as { name?: string };
  const collection = await prisma.collection.create({
    data: {
      name: body.name?.trim() || "New Collection"
    }
  });

  return NextResponse.json({ id: collection.id });
}
