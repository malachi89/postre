import { NextRequest, NextResponse } from "next/server";
import { clearCookies, deleteCookie, listCookies } from "@/lib/server/cookies";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await listCookies());
}

export async function DELETE(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");

  if (id) {
    await deleteCookie(id);
  } else {
    await clearCookies();
  }

  return NextResponse.json({ ok: true });
}
