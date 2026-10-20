import { NextRequest, NextResponse } from "next/server";
import { parseJsonBody } from "@/lib/server/api-error";
import { importPostmanPayload } from "@/lib/server/import";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const { body, error } = await parseJsonBody<unknown>(request);
  if (error) {
    return error;
  }

  let result;
  try {
    result = await importPostmanPayload(body);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "Invalid Postman payload.";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  return NextResponse.json(result);
}
