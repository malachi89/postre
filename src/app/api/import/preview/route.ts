import { NextRequest, NextResponse } from "next/server";
import { previewPostmanImport } from "@/lib/postman-importer";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const payload = await request.json();
  return NextResponse.json(previewPostmanImport(payload));
}
