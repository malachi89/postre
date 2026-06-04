import { describe, expect, it } from "vitest";
import {
  detectPostmanPayload,
  normalizePostmanEnvironment,
  previewPostmanImport
} from "@/lib/postman-importer";

const collection = {
  info: {
    name: "Users API",
    schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"
  },
  variable: [{ key: "baseUrl", value: "https://api.example", enabled: true }],
  item: [
    {
      name: "Users",
      item: [
        {
          name: "Get user",
          request: {
            method: "GET",
            url: {
              raw: "{{baseUrl}}/users/:id?include=profile",
              query: [{ key: "include", value: "profile" }]
            },
            header: [{ key: "Authorization", value: "Bearer {{token}}" }]
          }
        }
      ]
    },
    {
      name: "Create user",
      request: {
        method: "POST",
        url: "{{baseUrl}}/users",
        body: {
          mode: "raw",
          raw: '{"name":"Ada"}',
          options: { raw: { language: "json" } }
        }
      }
    }
  ]
};

const environment = {
  id: "env-1",
  name: "Local",
  _postman_variable_scope: "environment",
  values: [
    { key: "baseUrl", value: "https://api.example", enabled: true },
    { key: "token", value: "secret", enabled: false }
  ]
};

describe("postman importer", () => {
  it("detects Postman Collection v2.1", () => {
    expect(detectPostmanPayload(collection)).toBe("collection");
  });

  it("previews folders, requests, and variables", () => {
    const preview = previewPostmanImport(collection);

    expect(preview).toMatchObject({
      type: "collection",
      name: "Users API",
      folderCount: 1,
      requestCount: 2,
      variableCount: 1
    });
  });

  it("detects and normalizes Postman environments", () => {
    expect(detectPostmanPayload(environment)).toBe("environment");

    const normalized = normalizePostmanEnvironment(environment);
    expect(normalized.name).toBe("Local");
    expect(normalized.variables).toHaveLength(2);
    expect(normalized.variables[0]).toMatchObject({
      key: "baseUrl",
      currentValue: "https://api.example",
      enabled: true,
      scope: "ENVIRONMENT"
    });
    expect(normalized.variables[1]).toMatchObject({
      key: "token",
      enabled: false,
      isSecret: true
    });
  });
});
