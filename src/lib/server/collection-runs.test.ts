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
      preRequestScript: "pm.collectionVariables.set('fromParent', 'yes')",
      postRequestScript: "pm.collectionVariables.set('afterParent', 'yes')",
      metadataJson: "{}",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      sortOrder: 0
    },
    {
      id: "folder-child",
      name: "Child",
      collectionId: "col-1",
      parentId: "folder-parent",
      preRequestScript: "pm.collectionVariables.set('fromChild', 'yes')",
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
      bodyRawFormat: "json",
      bodyRaw: "",
      preRequestScript: "",
      postRequestScript: "pm.collectionVariables.set('afterRoot', 'yes')",
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
      bodyRawFormat: "json",
      bodyRaw: "",
      preRequestScript: "   ",
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
      bodyRawFormat: "json",
      bodyRaw: "",
      preRequestScript: "pm.collectionVariables.set('fromRequest', 'yes')",
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

  it("keeps natural order for collections and selects the nearest script per phase", () => {
    const requests = flattenRunRequests(collection, { type: "collection", id: "col-1" });

    expect(requests.map((request) => request.id)).toEqual(["req-child", "req-parent", "req-root"]);
    expect(requests[0].preScripts.map((script) => script.source)).toEqual([
      "Request pre-request: Child Request"
    ]);
    expect(requests[0].postScripts.map((script) => script.source)).toEqual([
      "Folder post-request: Parent"
    ]);
    expect(requests[1].preScripts.map((script) => script.source)).toEqual([
      "Folder pre-request: Parent"
    ]);
    expect(requests[1].postScripts.map((script) => script.source)).toEqual([
      "Folder post-request: Parent"
    ]);
    expect(requests[2].preScripts.map((script) => script.source)).toEqual([
      "Collection pre-request"
    ]);
    expect(requests[2].postScripts.map((script) => script.source)).toEqual([
      "Request post-request: Root"
    ]);
  });

  it("lets the closest nested folder override parent and collection scripts", () => {
    const childInheritedCollection = {
      ...collection,
      requests: collection.requests.map((request) =>
        request.id === "req-child" ? { ...request, preRequestScript: "" } : request
      )
    };
    const requests = flattenRunRequests(childInheritedCollection, { type: "collection", id: "col-1" });

    expect(requests[0].preScripts.map((script) => script.source)).toEqual([
      "Folder pre-request: Child"
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
