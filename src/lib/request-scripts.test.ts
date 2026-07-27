import { describe, expect, it } from "vitest";
import { runRequestScript } from "@/lib/request-scripts";
import type { RequestDraft, SendResult, VariableValue } from "@/lib/types";
import type { VariableBuckets } from "@/lib/variable-resolver";

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

function draft(patch: Partial<RequestDraft> = {}): RequestDraft {
  return {
    id: "req-1",
    collectionId: "col-1",
    folderId: null,
    name: "Example",
    method: "GET",
    url: "{{baseUrl}}/users",
    headers: [],
    queryParams: [],
    bodyMode: "none",
    bodyRawFormat: "json",
    bodyRaw: "",
    preRequestScript: "",
    postRequestScript: "",
    auth: { type: "none" },
    ...patch
  };
}

function buckets(patch: Partial<VariableBuckets> = {}): VariableBuckets {
  return {
    global: [],
    environment: [],
    collection: [],
    request: [],
    ...patch
  };
}

describe("request script runtime", () => {
  it("sets, gets, and unsets environment variables with logs", async () => {
    const run = await runRequestScript({
      phase: "pre-request",
      script: `
        pm.environment.set("token", "abc");
        console.log(pm.environment.get("token"));
        pm.environment.unset("stale");
      `,
      draft: draft(),
      variables: buckets({ environment: [variable("stale", "old", "ENVIRONMENT")] }),
      activeEnvironmentId: "env-1"
    });

    expect(run.result).toMatchObject({
      phase: "pre-request",
      ok: true,
      logs: ["abc"]
    });
    expect(run.mutations).toEqual([
      { scope: "ENVIRONMENT", action: "set", key: "token", value: "abc" },
      { scope: "ENVIRONMENT", action: "unset", key: "stale" }
    ]);
  });

  it("resolves pm.variables.get by request, collection, environment, then global", async () => {
    const run = await runRequestScript({
      phase: "pre-request",
      script: `
        console.log(pm.variables.get("baseUrl"));
        pm.variables.set("requestOnly", "value");
      `,
      draft: draft(),
      variables: buckets({
        global: [variable("baseUrl", "global", "GLOBAL")],
        environment: [variable("baseUrl", "environment", "ENVIRONMENT")],
        collection: [variable("baseUrl", "collection", "COLLECTION")],
        request: [variable("baseUrl", "request", "REQUEST")]
      }),
      activeEnvironmentId: "env-1"
    });

    expect(run.result.logs).toEqual(["request"]);
    expect(run.mutations).toEqual([
      { scope: "REQUEST", action: "set", key: "requestOnly", value: "value" }
    ]);
  });

  it("exposes response helpers to post-request scripts", async () => {
    const response: SendResult = {
      status: 201,
      statusText: "Created",
      headers: [{ key: "content-type", value: "application/json", enabled: true }],
      body: '{"token":"xyz"}',
      contentType: "application/json",
      durationMs: 42,
      sizeBytes: 15
    };

    const run = await runRequestScript({
      phase: "post-request",
      script: `
        console.log(pm.response.code, pm.response.headers.get("Content-Type"));
        pm.environment.set("token", pm.response.json().token);
      `,
      draft: draft(),
      variables: buckets(),
      activeEnvironmentId: "env-1",
      response
    });

    expect(run.result.logs).toEqual(["201 application/json"]);
    expect(run.mutations).toEqual([
      { scope: "ENVIRONMENT", action: "set", key: "token", value: "xyz" }
    ]);
  });

  it("loads crypto-js via require() and exposes CryptoJS", async () => {
    const run = await runRequestScript({
      phase: "pre-request",
      script: `
        const crypto = require('crypto-js');
        console.log(typeof crypto.SHA256);
      `,
      draft: draft(),
      variables: buckets(),
      activeEnvironmentId: "env-1"
    });

    expect(run.result).toMatchObject({ ok: true, logs: ["function"] });
  });

  it("loads moment via require()", async () => {
    const run = await runRequestScript({
      phase: "pre-request",
      script: `
        const moment = require('moment');
        console.log(typeof moment().format);
      `,
      draft: draft(),
      variables: buckets(),
      activeEnvironmentId: "env-1"
    });

    expect(run.result).toMatchObject({ ok: true, logs: ["function"] });
  });

  it("loads underscore via require()", async () => {
    const run = await runRequestScript({
      phase: "pre-request",
      script: `
        const _ = require('underscore');
        console.log(typeof _.map);
      `,
      draft: draft(),
      variables: buckets(),
      activeEnvironmentId: "env-1"
    });

    expect(run.result).toMatchObject({ ok: true, logs: ["function"] });
  });

  it("loads tv4 via require()", async () => {
    const run = await runRequestScript({
      phase: "pre-request",
      script: `
        const tv4 = require('tv4');
        console.log(typeof tv4.validate);
      `,
      draft: draft(),
      variables: buckets(),
      activeEnvironmentId: "env-1"
    });

    expect(run.result).toMatchObject({ ok: true, logs: ["function"] });
  });

  it("loads chai via require()", async () => {
    const run = await runRequestScript({
      phase: "pre-request",
      script: `
        const chai = require('chai');
        console.log(typeof chai.expect);
      `,
      draft: draft(),
      variables: buckets(),
      activeEnvironmentId: "env-1"
    });

    console.log("CHAI ERROR", run.result.error);
    expect(run.result).toMatchObject({ ok: true, logs: ["function"] });
  });

  it("fails scripts that exceed the timeout", async () => {
    const run = await runRequestScript({
      phase: "pre-request",
      script: "while (true) {}",
      draft: draft(),
      variables: buckets(),
      activeEnvironmentId: "env-1",
      timeoutMs: 10
    });

    expect(run.result.ok).toBe(false);
    expect(run.result.error).toBeTruthy();
    expect(run.mutations).toEqual([]);
  });
});
