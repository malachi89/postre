import { describe, expect, it } from "vitest";
import {
  detectPostmanPayload,
  normalizePostmanCollection,
  normalizePostmanEnvironment,
  previewPostmanImport
} from "@/lib/postman-importer";

const collection = {
  info: {
    name: "Users API",
    schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"
  },
  event: [
    {
      listen: "prerequest",
      script: { exec: ["pm.collectionVariables.set('tenant', 'main');"] }
    }
  ],
  variable: [{ key: "baseUrl", value: "https://api.example", enabled: true }],
  item: [
    {
      name: "Users",
      event: [
        {
          listen: "test",
          script: { exec: ["pm.collectionVariables.set('lastFolder', 'Users');"] }
        }
      ],
      item: [
        {
          name: "Get user",
          event: [
            {
              listen: "prerequest",
              script: { exec: ["pm.environment.set('token', 'abc');"] }
            },
            {
              listen: "test",
              script: { exec: ["pm.environment.set('lastStatus', pm.response.code);"] }
            }
          ],
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

  it("extracts request-level pre-request and post-request scripts", () => {
    const normalized = normalizePostmanCollection(collection);
    expect(normalized.preRequestScript).toBe("pm.collectionVariables.set('tenant', 'main');");
    const folder = normalized.items[0];
    expect(folder.type).toBe("folder");
    if (folder.type !== "folder") {
      throw new Error("Expected folder");
    }
    expect(folder.postRequestScript).toBe("pm.collectionVariables.set('lastFolder', 'Users');");

    const item = folder.items[0];
    expect(item.type).toBe("request");
    if (item.type !== "request") {
      throw new Error("Expected request");
    }

    expect(item.request.preRequestScript).toBe("pm.environment.set('token', 'abc');");
    expect(item.request.postRequestScript).toBe("pm.environment.set('lastStatus', pm.response.code);");
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
