import { describe, expect, it } from "vitest";
import { flattenRunRequests, selectRunRequests } from "@/lib/server/collection-runs";

const collection = {
  id: "col-1",
  name: "Collection",
  preRequestScript: "pm.collectionVariables.set('fromCollection', 'yes')",
  postRequestScript: "",
  metadataJson: "{}",
  folders: [
    {
      id: "folder-parent",
      name: "Parent",
      collectionId: "col-1",
      parentId: null,
      preRequestScript: "",
      postRequestScript: "",
      metadataJson: "{}",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      sortOrder: 0
    },
    {
      id: "folder-child",
      name: "Child",
      collectionId: "col-1",
      parentId: "folder-parent",
      preRequestScript: "",
      postRequestScript: "",
      metadataJson: "{}",
      createdAt: new Date("2026-01-01T00:01:00.000Z"),
      sortOrder: 0
    }
  ],
  requests: [
    {
      id: "req-root",
      collectionId: "col-1",
      folderId: null,
      name: "Root",
      method: "GET",
      url: "https://api.test/root",
      headersJson: "[]",
      queryParamsJson: "[]",
      bodyMode: "none",
      bodyRaw: "",
      preRequestScript: "",
      postRequestScript: "",
      authJson: "{\"type\":\"none\"}",
      createdAt: new Date("2026-01-01T00:03:00.000Z")
    },
    {
      id: "req-parent",
      collectionId: "col-1",
      folderId: "folder-parent",
      name: "Parent Request",
      method: "GET",
      url: "https://api.test/parent",
      headersJson: "[]",
      queryParamsJson: "[]",
      bodyMode: "none",
      bodyRaw: "",
      preRequestScript: "",
      postRequestScript: "",
      authJson: "{\"type\":\"none\"}",
      createdAt: new Date("2026-01-01T00:04:00.000Z")
    },
    {
      id: "req-child",
      collectionId: "col-1",
      folderId: "folder-child",
      name: "Child Request",
      method: "POST",
      url: "https://api.test/child",
      headersJson: "[]",
      queryParamsJson: "[]",
      bodyMode: "none",
      bodyRaw: "",
      preRequestScript: "",
      postRequestScript: "",
      authJson: "{\"type\":\"none\"}",
      createdAt: new Date("2026-01-01T00:02:00.000Z")
    }
  ]
};

describe("collection run helpers", () => {
  it("flattens folder requests within folder scope only", () => {
    const requests = flattenRunRequests(collection, { type: "folder", id: "folder-parent" });

    expect(requests.map((request) => request.id)).toEqual(["req-child", "req-parent"]);
    expect(requests[0].path).toEqual(["Parent", "Child"]);
  });

  it("keeps natural order for collections and builds hierarchical script stacks", () => {
    const requests = flattenRunRequests(collection, { type: "collection", id: "col-1" });

    expect(requests.map((request) => request.id)).toEqual(["req-child", "req-parent", "req-root"]);
    expect(requests[0].preScripts.map((script) => script.source)).toEqual([
      "Collection pre-request",
      "Folder pre-request: Parent",
      "Folder pre-request: Child",
      "Request pre-request: Child Request"
    ]);
  });

  it("validates explicit request order against the selected target", () => {
    const requests = flattenRunRequests(collection, { type: "folder", id: "folder-parent" });

    expect(() => selectRunRequests(requests, ["req-root"])).toThrow(
      'Request "req-root" does not belong to the selected target.'
    );
    expect(selectRunRequests(requests, ["req-parent", "req-child"]).map((request) => request.id)).toEqual([
      "req-parent",
      "req-child"
    ]);
  });

  it("rejects an empty explicit selection", () => {
    expect(() => selectRunRequests([], [])).toThrow("The selected target has no requests to run.");
    expect(() => selectRunRequests([flattenRunRequests(collection, { type: "collection", id: "col-1" })[0]], ["missing"])).toThrow(
      'Request "missing" does not belong to the selected target.'
    );
  });
});
