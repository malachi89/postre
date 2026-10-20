import { NextResponse } from "next/server";
import type { KeyValueRow } from "@/lib/types";
import { Prisma } from "@prisma/client";

/**
 * Maps known Prisma errors thrown by mutation routes to a proper HTTP response.
 * Returns null when the error is not mapped and should keep propagating.
 */
export function prismaErrorResponse(error: unknown): NextResponse | null {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2025") {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (error.code === "P2003") {
      return NextResponse.json(
        { error: "Referenced record does not exist or is still in use." },
        { status: 400 }
      );
    }
  }
  return null;
}

/** Parses a JSON request body, returning a 400-style NextResponse on invalid JSON. */
export async function parseJsonBody<T>(request: Request): Promise<{ body: T; error: null } | { body: null; error: NextResponse }> {
  try {
    return { body: (await request.json()) as T, error: null };
  } catch {
    return { body: null, error: NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }) };
  }
}

/**
 * Coercion guards for client-provided JSON fields. Untrusted payloads used to
 * reach Prisma or string methods directly and crash with TypeErrors.
 */
export function asString(value: unknown, fallback = ""): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return fallback;
}

export function asNullableString(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  return typeof value === "string" ? value : asString(value);
}

export function asStringObject(value: unknown): Record<string, string> {
  const record: Record<string, string> = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      record[key] = asString(entry);
    }
  }
  return record;
}

export function asRows(value: unknown): KeyValueRow[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
    .map((entry) => ({
      key: asString(entry.key),
      value: asString(entry.value),
      enabled: entry.enabled !== false,
      isSecret: entry.isSecret === true
    }));
}

