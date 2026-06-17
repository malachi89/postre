import { describe, expect, it } from "vitest";
import { bucketVariables, findVariablesInText, resolveRequestDraft, resolveTemplate } from "@/lib/variable-resolver";
import type { RequestDraft, VariableValue } from "@/lib/types";

function variable(key: string, currentValue: string, scope: VariableValue["scope"]): VariableValue {
  return {
    key,
    initialValue: "",
    currentValue,
    enabled: true,
    scope,
    isSecret: false
  };
}

describe("variable resolver", () => {
  it("resolves variables by request, collection, environment, then global priority", () => {
    const buckets = bucketVariables([
      variable("baseUrl", "https://global.example", "GLOBAL"),
      variable("baseUrl", "https://env.example", "ENVIRONMENT"),
      variable("baseUrl", "https://collection.example", "COLLECTION"),
      variable("baseUrl", "https://request.example", "REQUEST")
    ]);

    expect(resolveTemplate("{{baseUrl}}/users", buckets).value).toBe("https://request.example/users");
  });

  it("reports missing variables without replacing the original token", () => {
    const result = resolveTemplate("{{baseUrl}}/users/{{missingId}}", {
      global: [variable("baseUrl", "https://api.example", "GLOBAL")],
      environment: [],
      collection: [],
      request: []
    });

    expect(result.value).toBe("https://api.example/users/{{missingId}}");
    expect(result.missing).toEqual(["missingId"]);
  });

  it("finds unique variable names in text", () => {
    expect(findVariablesInText("{{baseUrl}}/{{userId}}?id={{userId}}")).toEqual([
      "baseUrl",
      "userId"
    ]);
  });

  it("resolves URL, query params, headers, body, and auth temporarily", () => {
    const draft: RequestDraft = {
      name: "Example",
      method: "POST",
      url: "{{baseUrl}}/users",
      headers: [{ key: "Authorization", value: "Bearer {{token}}", enabled: true }],
      queryParams: [{ key: "id", value: "{{userId}}", enabled: true }],
      bodyMode: "raw",
      bodyRawFormat: "json",
      bodyRaw: '{"id":"{{userId}}"}',
      preRequestScript: "",
      postRequestScript: "",
      auth: { type: "bearer", token: "{{token}}" }
    };

    const result = resolveRequestDraft(draft, {
      global: [variable("baseUrl", "https://api.example", "GLOBAL")],
      environment: [variable("token", "env-token", "ENVIRONMENT")],
      collection: [variable("userId", "42", "COLLECTION")],
      request: []
    });

    expect(result.missingVariables).toEqual([]);
    expect(result.draft.url).toBe("https://api.example/users");
    expect(result.draft.queryParams[0].value).toBe("42");
    expect(result.draft.headers[0].value).toBe("Bearer env-token");
    expect(result.draft.bodyRaw).toBe('{"id":"42"}');
    expect(result.draft.auth).toEqual({ type: "bearer", token: "env-token" });
  });
});
