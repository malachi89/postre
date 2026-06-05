import { describe, expect, it } from "vitest";
import { parseSetCookie, splitSetCookieHeader } from "@/lib/server/cookies";

describe("cookie jar helpers", () => {
  it("splits combined Set-Cookie headers without breaking Expires dates", () => {
    expect(
      splitSetCookieHeader(
        "sid=abc; Expires=Wed, 21 Oct 2030 07:28:00 GMT; Path=/, theme=dark; Path=/app; HttpOnly"
      )
    ).toEqual([
      "sid=abc; Expires=Wed, 21 Oct 2030 07:28:00 GMT; Path=/",
      "theme=dark; Path=/app; HttpOnly"
    ]);
  });

  it("parses cookie attributes with the response URL as host-only default", () => {
    const cookie = parseSetCookie(
      "sid=abc123; Path=/api; Max-Age=3600; Secure; HttpOnly; SameSite=Lax",
      new URL("https://example.com/api/login")
    );

    expect(cookie).toMatchObject({
      name: "sid",
      value: "abc123",
      domain: "example.com",
      path: "/api",
      hostOnly: true,
      secure: true,
      httpOnly: true,
      sameSite: "Lax"
    });
    expect(cookie?.expiresAt).toBeInstanceOf(Date);
  });

  it("rejects Set-Cookie domains that do not match the response URL", () => {
    expect(parseSetCookie("sid=abc; Domain=elsewhere.test", new URL("https://example.com"))).toBeNull();
  });
});
