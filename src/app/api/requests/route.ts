import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { asRows, asString, parseJsonBody } from "@/lib/server/api-error";
import { requestToPrismaInput, serializeRequest } from "@/lib/server/data";
import type { BodyMode, RawFormat, RequestDraft } from "@/lib/types";

export const dynamic = "force-dynamic";

const BODY_MODES = new Set(["none", "formdata", "form_urlencoded", "raw", "binary"]);
const RAW_FORMATS = new Set(["json", "text", "xml", "javascript", "html"]);

export async function POST(request: NextRequest) {
  const parsed = await parseJsonBody<Partial<RequestDraft> & { collectionId?: string }>(request);
  if (parsed.error) {
    return parsed.error;
  }
  const body = parsed.body;

  try {
    if (!body.collectionId) {
      return NextResponse.json({ error: "collectionId is required" }, { status: 400 });
    }

    const folderId = await resolveFolderId(body.collectionId, body.folderId ?? null);

    const method = asString(body.method, "GET").toUpperCase();
    const bodyMode = asString(body.bodyMode, "none");
    const bodyRawFormat = asString(body.bodyRawFormat, "json");

    const created = await prisma.request.create({
      data: {
        ...requestToPrismaInput({
          name: asString(body.name, "New Request"),
          method: (
            method === "GET" || method === "POST" || method === "PUT" || method === "PATCH" ||
            method === "DELETE" || method === "HEAD" || method === "OPTIONS"
              ? method
              : "GET"
          ) as RequestDraft["method"],
          url: asString(body.url),
          headers: asRows(body.headers),
          queryParams: asRows(body.queryParams),
          bodyMode: (BODY_MODES.has(bodyMode) ? bodyMode : "none") as BodyMode,
          bodyRawFormat: (RAW_FORMATS.has(bodyRawFormat) ? bodyRawFormat : "json") as RawFormat,
          bodyRaw: asString(body.bodyRaw),
          preRequestScript: asString(body.preRequestScript),
          postRequestScript: asString(body.postRequestScript),
          auth: normalizeAuth(body.auth),
          collectionId: body.collectionId,
          folderId
        }),
        collectionId: body.collectionId
      },
      include: { variables: true }
    });

    return NextResponse.json(serializeRequest(created), { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not create request.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

async function resolveFolderId(collectionId: string, folderId: string | null) {
  if (!folderId) {
    return null;
  }

  const folder = await prisma.folder.findFirst({
    where: {
      id: folderId,
      collectionId
    },
    select: { id: true }
  });

  return folder?.id ?? null;
}

function normalizeAuth(value: unknown): RequestDraft["auth"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { type: "none" };
  }
  const record = value as Record<string, unknown>;
  const type = asString(record.type, "none");

  if (type === "bearer" || type === "basic" || type === "apiKey") {
    return {
      type,
      token: asString(record.token),
      username: asString(record.username),
      password: asString(record.password),
      key: asString(record.key),
      value: asString(record.value),
      placement: record.placement === "query" ? "query" : "header"
    };
  }

  return { type: "none" };
}
