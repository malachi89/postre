import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const findFolder = vi.fn();
const findCollection = vi.fn();
const findRequest = vi.fn();
const updateRequest = vi.fn();
const deleteRequest = vi.fn();
const requestToPrismaInput = vi.fn();
const serializeRequest = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    folder: { findUnique: findFolder },
    collection: { findUnique: findCollection },
    request: {
      findUnique: findRequest,
      update: updateRequest,
      delete: deleteRequest
    }
  }
}));

vi.mock("@/lib/server/data", () => ({
  requestToPrismaInput,
  serializeRequest
}));

async function patchRequest(body: unknown) {
  const { PATCH } = await import("@/app/api/requests/[id]/route");
  return PATCH(
    new Request("http://localhost/api/requests/req-1", {
      method: "PATCH",
      body: JSON.stringify(body)
    }) as unknown as NextRequest,
    { params: Promise.resolve({ id: "req-1" }) }
  );
}

async function removeRequest() {
  const { DELETE } = await import("@/app/api/requests/[id]/route");
  return DELETE(new NextRequest("http://localhost/api/requests/req-1"), {
    params: Promise.resolve({ id: "req-1" })
  });
}

describe("requests [id] route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requestToPrismaInput.mockReturnValue({
      name: "Moved request",
      method: "GET",
      folderId: "folder-target"
    });
    serializeRequest.mockImplementation((value) => value);
  });

  it("moves a request into the target folder collection", async () => {
    findFolder.mockResolvedValue({ id: "folder-target", collectionId: "col-2" });
    updateRequest.mockResolvedValue({ id: "req-1", folderId: "folder-target", collectionId: "col-2" });

    const response = await patchRequest({
      id: "req-1",
      name: "Moved request",
      method: "GET",
      url: "",
      headers: [],
      queryParams: [],
      bodyMode: "none",
      bodyRawFormat: "json",
      bodyRaw: "",
      preRequestScript: "",
      postRequestScript: "",
      auth: { type: "none" },
      collectionId: "col-1",
      folderId: "folder-target"
    });

    expect(response.status).toBe(200);
    expect(updateRequest).toHaveBeenCalledWith({
      where: { id: "req-1" },
      data: {
        name: "Moved request",
        method: "GET",
        folderId: "folder-target",
        collectionId: "col-2"
      },
      include: { variables: true }
    });
  });

  it("rejects an invalid folder target", async () => {
    findFolder.mockResolvedValue(null);

    const response = await patchRequest({
      id: "req-1",
      name: "Moved request",
      method: "GET",
      url: "",
      headers: [],
      queryParams: [],
      bodyMode: "none",
      bodyRawFormat: "json",
      bodyRaw: "",
      preRequestScript: "",
      postRequestScript: "",
      auth: { type: "none" },
      collectionId: "col-1",
      folderId: "missing-folder"
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "folderId is invalid" });
    expect(updateRequest).not.toHaveBeenCalled();
  });

  it("deletes a request by id", async () => {
    const response = await removeRequest();

    expect(response.status).toBe(200);
    expect(deleteRequest).toHaveBeenCalledWith({ where: { id: "req-1" } });
  });
});
