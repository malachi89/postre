import { prisma } from "@/lib/db";
import type { ApiCookie } from "@/lib/types";

type CookieRecord = {
  id: string;
  name: string;
  value: string;
  domain: string;
  path: string;
  hostOnly: boolean;
  secure: boolean;
  httpOnly: boolean;
  sameSite: string | null;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  lastAccessedAt: Date | null;
};

export type ParsedSetCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  hostOnly: boolean;
  secure: boolean;
  httpOnly: boolean;
  sameSite: string | null;
  expiresAt: Date | null;
};

export function serializeCookie(cookie: CookieRecord): ApiCookie {
  return {
    id: cookie.id,
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    hostOnly: cookie.hostOnly,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite,
    expiresAt: cookie.expiresAt?.toISOString() ?? null,
    createdAt: cookie.createdAt.toISOString(),
    updatedAt: cookie.updatedAt.toISOString(),
    lastAccessedAt: cookie.lastAccessedAt?.toISOString() ?? null
  };
}

export async function listCookies(): Promise<ApiCookie[]> {
  await deleteExpiredCookies();
  const cookies = await prisma.cookie.findMany({
    orderBy: [{ domain: "asc" }, { path: "asc" }, { name: "asc" }]
  });
  return cookies.map(serializeCookie);
}

export async function deleteCookie(id: string) {
  await prisma.cookie.deleteMany({ where: { id } });
}

export async function clearCookies() {
  await prisma.cookie.deleteMany();
}

export async function getCookieHeaderForUrl(url: string): Promise<string> {
  const target = new URL(url);
  const now = new Date();
  await deleteExpiredCookies(now);

  const cookies = await prisma.cookie.findMany();
  const matching = cookies.filter((cookie) => cookieMatchesUrl(cookie, target, now));

  if (!matching.length) {
    return "";
  }

  await prisma.cookie.updateMany({
    where: { id: { in: matching.map((cookie) => cookie.id) } },
    data: { lastAccessedAt: now }
  });

  return matching
    .sort((left, right) => right.path.length - left.path.length)
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}

export async function storeResponseCookies(url: string, setCookieHeaders: string[]) {
  if (!setCookieHeaders.length) {
    return;
  }

  const target = new URL(url);
  const parsedCookies = setCookieHeaders
    .flatMap(splitSetCookieHeader)
    .map((header) => parseSetCookie(header, target))
    .filter((cookie): cookie is ParsedSetCookie => cookie !== null);

  for (const cookie of parsedCookies) {
    if (cookie.expiresAt && cookie.expiresAt.getTime() <= Date.now()) {
      await prisma.cookie.deleteMany({
        where: {
          domain: cookie.domain,
          path: cookie.path,
          name: cookie.name
        }
      });
      continue;
    }

    await prisma.cookie.upsert({
      where: {
        domain_path_name: {
          domain: cookie.domain,
          path: cookie.path,
          name: cookie.name
        }
      },
      update: {
        value: cookie.value,
        hostOnly: cookie.hostOnly,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        sameSite: cookie.sameSite,
        expiresAt: cookie.expiresAt
      },
      create: cookie
    });
  }
}

export function parseSetCookie(header: string, target: URL): ParsedSetCookie | null {
  const parts = header.split(";").map((part) => part.trim()).filter(Boolean);
  const [nameValue, ...attributes] = parts;
  const equalsIndex = nameValue?.indexOf("=") ?? -1;
  if (!nameValue || equalsIndex <= 0) {
    return null;
  }

  const cookie: ParsedSetCookie = {
    name: nameValue.slice(0, equalsIndex).trim(),
    value: nameValue.slice(equalsIndex + 1),
    domain: target.hostname.toLowerCase(),
    path: defaultCookiePath(target.pathname),
    hostOnly: true,
    secure: false,
    httpOnly: false,
    sameSite: null,
    expiresAt: null
  };

  for (const attribute of attributes) {
    const [rawKey, ...rawValue] = attribute.split("=");
    const key = rawKey.trim().toLowerCase();
    const value = rawValue.join("=").trim();

    if (key === "domain" && value) {
      cookie.domain = value.replace(/^\./, "").toLowerCase();
      cookie.hostOnly = false;
    } else if (key === "path" && value.startsWith("/")) {
      cookie.path = value;
    } else if (key === "expires" && value) {
      const expires = new Date(value);
      if (!Number.isNaN(expires.getTime())) {
        cookie.expiresAt = expires;
      }
    } else if (key === "max-age" && value) {
      const seconds = Number(value);
      if (Number.isFinite(seconds)) {
        cookie.expiresAt = new Date(Date.now() + seconds * 1000);
      }
    } else if (key === "secure") {
      cookie.secure = true;
    } else if (key === "httponly") {
      cookie.httpOnly = true;
    } else if (key === "samesite" && value) {
      cookie.sameSite = value;
    }
  }

  if (!cookie.name || !domainMatches(target.hostname, cookie.domain, cookie.hostOnly)) {
    return null;
  }

  return cookie;
}

export function splitSetCookieHeader(header: string): string[] {
  const cookies: string[] = [];
  let start = 0;
  let inExpires = false;

  for (let index = 0; index < header.length; index += 1) {
    const char = header[index];
    const segment = header.slice(Math.max(start, index - 8), index + 1).toLowerCase();

    if (segment.endsWith("expires=")) {
      inExpires = true;
    }

    if (inExpires && char === ";") {
      inExpires = false;
    }

    if (char === "," && !inExpires && looksLikeCookieStart(header.slice(index + 1))) {
      cookies.push(header.slice(start, index).trim());
      start = index + 1;
    }
  }

  cookies.push(header.slice(start).trim());
  return cookies.filter(Boolean);
}

function cookieMatchesUrl(cookie: CookieRecord, target: URL, now: Date) {
  if (cookie.expiresAt && cookie.expiresAt <= now) {
    return false;
  }

  if (cookie.secure && target.protocol !== "https:") {
    return false;
  }

  return domainMatches(target.hostname, cookie.domain, cookie.hostOnly) && pathMatches(target.pathname, cookie.path);
}

function domainMatches(hostname: string, domain: string, hostOnly: boolean) {
  const host = hostname.toLowerCase();
  const normalizedDomain = domain.toLowerCase();

  if (hostOnly) {
    return host === normalizedDomain;
  }

  return host === normalizedDomain || host.endsWith(`.${normalizedDomain}`);
}

function pathMatches(requestPath: string, cookiePath: string) {
  if (requestPath === cookiePath) {
    return true;
  }

  if (!requestPath.startsWith(cookiePath)) {
    return false;
  }

  return cookiePath.endsWith("/") || requestPath[cookiePath.length] === "/";
}

function defaultCookiePath(pathname: string) {
  if (!pathname || !pathname.startsWith("/") || pathname === "/") {
    return "/";
  }

  const lastSlash = pathname.lastIndexOf("/");
  return lastSlash <= 0 ? "/" : pathname.slice(0, lastSlash);
}

function looksLikeCookieStart(value: string) {
  return /^\s*[^=;,\s]+=/.test(value);
}

async function deleteExpiredCookies(now = new Date()) {
  await prisma.cookie.deleteMany({
    where: {
      expiresAt: {
        lte: now
      }
    }
  });
}
