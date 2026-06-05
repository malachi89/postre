import { describe, expect, it } from "vitest";
import { CurlParseError, parseCurlToRequestDraft, requestDraftToCurl } from "@/lib/curl";
import type { RequestDraft } from "@/lib/types";

function draft(patch: Partial<RequestDraft> = {}): RequestDraft {
  return {
    id: "req-1",
    collectionId: "col-1",
    folderId: "folder-1",
    name: "Example",
    method: "GET",
    url: "{{baseUrl}}/users",
    headers: [],
    queryParams: [],
    bodyMode: "none",
    bodyRaw: "",
    preRequestScript: "",
    postRequestScript: "",
    auth: { type: "none" },
    ...patch
  };
}

describe("curl utilities", () => {
  it("generates a GET cURL with variables and query params preserved", () => {
    const result = requestDraftToCurl(
      draft({
        queryParams: [
          { key: "include", value: "profile", enabled: true },
          { key: "token", value: "{{token}}", enabled: true }
        ]
      })
    );

    expect(result).toContain("curl --location");
    expect(result).toContain("--request GET");
    expect(result).toContain("'{{baseUrl}}/users?include=profile&token={{token}}'");
  });

  it("generates a POST JSON cURL with headers and shell-safe body quoting", () => {
    const result = requestDraftToCurl(
      draft({
        method: "POST",
        url: "https://api.example/users",
        headers: [{ key: "Content-Type", value: "application/json", enabled: true }],
        bodyMode: "raw_json",
        bodyRaw: "{\n  \"name\": \"Ada's laptop\"\n}"
      })
    );

    expect(result).toContain("--header 'Content-Type: application/json'");
    expect(result).toContain("--data-raw '{\n  \"name\": \"Ada'\\''s laptop\"\n}'");
  });

  it("generates auth from bearer, basic, and api key configs without resolving variables", () => {
    expect(
      requestDraftToCurl(
        draft({
          auth: { type: "bearer", token: "{{token}}" }
        })
      )
    ).toContain("--header 'Authorization: Bearer {{token}}'");

    expect(
      requestDraftToCurl(
        draft({
          auth: { type: "basic", username: "{{user}}", password: "{{password}}" }
        })
      )
    ).toContain("--user '{{user}}:{{password}}'");

    expect(
      requestDraftToCurl(
        draft({
          auth: { type: "apiKey", key: "x-api-key", value: "{{apiKey}}", placement: "header" }
        })
      )
    ).toContain("--header 'x-api-key: {{apiKey}}'");

    expect(
      requestDraftToCurl(
        draft({
          auth: { type: "apiKey", key: "api_key", value: "{{apiKey}}", placement: "query" }
        })
      )
    ).toContain("api_key={{apiKey}}");
  });

  it("parses Postman-style cURL with headers and raw JSON data", () => {
    const result = parseCurlToRequestDraft(
      `curl --location 'https://api.example/users?include=profile' \\
        --header 'Authorization: Bearer {{token}}' \\
        --data-raw '{"name":"Ada"}'`,
      draft()
    );

    expect(result).toMatchObject({
      id: "req-1",
      name: "Example",
      collectionId: "col-1",
      folderId: "folder-1",
      method: "POST",
      url: "https://api.example/users",
      bodyMode: "raw_json",
      bodyRaw: '{"name":"Ada"}',
      auth: { type: "none" }
    });
    expect(result.headers).toEqual([
      { key: "Authorization", value: "Bearer {{token}}", enabled: true }
    ]);
    expect(result.queryParams).toEqual([{ key: "include", value: "profile", enabled: true }]);
  });

  it("parses explicit methods, duplicate query params, and basic auth", () => {
    const result = parseCurlToRequestDraft(
      "curl -X PUT --url 'https://api.example/search?tag=a&tag=b' -u '{{user}}:{{password}}' -H 'Accept: application/json'",
      draft()
    );

    expect(result.method).toBe("PUT");
    expect(result.url).toBe("https://api.example/search");
    expect(result.queryParams).toEqual([
      { key: "tag", value: "a", enabled: true },
      { key: "tag", value: "b", enabled: true }
    ]);
    expect(result.auth).toEqual({
      type: "basic",
      username: "{{user}}",
      password: "{{password}}"
    });
    expect(result.headers).toEqual([{ key: "Accept", value: "application/json", enabled: true }]);
  });

  it("parses text data and infers POST when no method is provided", () => {
    const result = parseCurlToRequestDraft(
      "curl 'https://api.example/messages' --data 'hello world'",
      draft()
    );

    expect(result.method).toBe("POST");
    expect(result.bodyMode).toBe("raw_text");
    expect(result.bodyRaw).toBe("hello world");
  });

  it("returns a clear error for unsupported multipart cURL", () => {
    expect(() =>
      parseCurlToRequestDraft("curl 'https://api.example/upload' --form 'file=@photo.png'", draft())
    ).toThrow(CurlParseError);
  });
});
