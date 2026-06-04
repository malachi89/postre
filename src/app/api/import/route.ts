import { NextRequest, NextResponse } from "next/server";
import { importPostmanPayload } from "@/lib/server/import";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const payload = await request.json();
  const result = await importPostmanPayload(payload);
  return NextResponse.json(result);
}
