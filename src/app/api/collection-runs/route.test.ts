import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const createCollectionRun = vi.fn();
const listCollectionRunSummaries = vi.fn();

vi.mock("@/lib/server/collection-runs", () => ({
  createCollectionRun,
  listCollectionRunSummaries
}));

async function postRun(body: unknown) {
  const { POST } = await import("@/app/api/collection-runs/route");
  return POST(
    new Request("http://localhost/api/collection-runs", {
      method: "POST",
      body: JSON.stringify(body)
    }) as unknown as NextRequest
  );
}

async function getRuns(url: string) {
  const { GET } = await import("@/app/api/collection-runs/route");
  return GET(new NextRequest(url));
}

describe("collection runs route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a run with the expected payload", async () => {
    createCollectionRun.mockResolvedValue({ run: { id: "run-1" }, steps: [] });

    const response = await postRun({
      target: { type: "collection", id: "col-1" },
      activeEnvironmentId: "env-1",
      iterations: 2,
      delayMs: 150,
      requestIds: ["req-1"],
      stopOnError: false
    });

    expect(response.status).toBe(200);
    expect(createCollectionRun).toHaveBeenCalledWith({
      target: { type: "collection", id: "col-1" },
      activeEnvironmentId: "env-1",
      iterations: 2,
      delayMs: 150,
      requestIds: ["req-1"],
      stopOnError: false
    });
  });

  it("returns 400 when target is missing", async () => {
    const response = await postRun({});
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "target is required" });
  });

  it("lists summaries for a collection", async () => {
    listCollectionRunSummaries.mockResolvedValue([{ id: "run-1" }]);

    const response = await getRuns("http://localhost/api/collection-runs?collectionId=col-1&take=5");

    expect(response.status).toBe(200);
    expect(listCollectionRunSummaries).toHaveBeenCalledWith("col-1", 5);
  });
});
