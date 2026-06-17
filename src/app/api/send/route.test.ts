import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestDraft, SendResult } from "@/lib/types";

const executeRequest = vi.fn();

vi.mock("@/lib/server/request-execution", () => ({
  executeRequest
}));

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

function sendResult(patch: Partial<SendResult> = {}): SendResult {
  return {
    status: 200,
    statusText: "OK",
    headers: [],
    body: "{}",
    contentType: "application/json",
    durationMs: 12,
    sizeBytes: 2,
    ...patch
  };
}

async function postSend(body: unknown) {
  const { POST } = await import("@/app/api/send/route");
  return POST(
    new Request("http://localhost/api/send", {
      method: "POST",
      body: JSON.stringify(body)
    }) as unknown as NextRequest
  );
}

describe("send route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the shared execution result on success", async () => {
    executeRequest.mockResolvedValue({
      ok: true,
      result: sendResult(),
      resolvedDraft: draft({ url: "https://api.test/users" }),
      scriptResults: [{ phase: "pre-request", ok: true, logs: ["done"] }]
    });

    const response = await postSend({ draft: draft(), activeEnvironmentId: "env-1" });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(executeRequest).toHaveBeenCalledWith({
      draft: draft(),
      activeEnvironmentId: "env-1",
      timeoutMs: undefined
    });
    expect(payload.resolvedDraft.url).toBe("https://api.test/users");
  });

  it("returns a validation error payload from the shared executor", async () => {
    executeRequest.mockResolvedValue({
      ok: false,
      status: 400,
      error: "Missing variables",
      missingVariables: ["baseUrl"],
      resolvedDraft: draft(),
      scriptResults: []
    });

    const response = await postSend({ draft: draft() });
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error).toBe("Missing variables");
    expect(payload.missingVariables).toEqual(["baseUrl"]);
  });

  it("rejects requests without a draft", async () => {
    const response = await postSend({});
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "draft is required" });
  });
});
