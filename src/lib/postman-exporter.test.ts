import { describe, expect, it } from "vitest";
import { buildPostmanExport } from "@/lib/postman-exporter";
import type { ApiCollection } from "@/lib/types";

const collection: ApiCollection = {
  id: "col-1",
  name: "Users API",
  description: null,
  preRequestScript: "collectionPre();",
  postRequestScript: "collectionPost();",
  folders: [
    {
      id: "folder-1",
      name: "Users",
      collectionId: "col-1",
      parentId: null,
      preRequestScript: "folderPre();",
      postRequestScript: "folderPost();",
      children: [],
      requests: [
        {
          id: "req-1",
          collectionId: "col-1",
          folderId: "folder-1",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          variables: [],
          name: "Get user",
          method: "GET",
          url: "https://api.test/users/1",
          headers: [],
          queryParams: [],
          bodyMode: "none",
          bodyRaw: "",
          preRequestScript: "requestPre();",
          postRequestScript: "requestPost();",
          auth: { type: "none" }
        }
      ]
    }
  ],
  requests: [],
  variables: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z"
};

describe("postman exporter", () => {
  it("exports collection, folder, and request scripts as Postman events", () => {
    const result = buildPostmanExport([collection], []);
    const exportedCollection = result.collections[0] as {
      event: Array<{ listen: string; script: { exec: string[] } }>;
      item: Array<{
        event: Array<{ listen: string; script: { exec: string[] } }>;
        item: Array<{ event: Array<{ listen: string; script: { exec: string[] } }> }>;
      }>;
    };

    expect(exportedCollection.event.map((event) => event.listen)).toEqual(["prerequest", "test"]);
    expect(exportedCollection.event[0].script.exec).toEqual(["collectionPre();"]);
    expect(exportedCollection.item[0].event[0].script.exec).toEqual(["folderPre();"]);
    expect(exportedCollection.item[0].event[1].script.exec).toEqual(["folderPost();"]);
    expect(exportedCollection.item[0].item[0].event[0].script.exec).toEqual(["requestPre();"]);
    expect(exportedCollection.item[0].item[0].event[1].script.exec).toEqual(["requestPost();"]);
  });
});
