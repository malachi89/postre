import { describe, expect, it } from "vitest";
import { resolveEffectiveScriptSources } from "@/lib/server/script-inheritance";

describe("script inheritance", () => {
  it("resolves pre and post scripts independently to the nearest non-empty level", () => {
    const scripts = resolveEffectiveScriptSources({
      collection: {
        preRequestScript: "collectionPre()",
        postRequestScript: "collectionPost()"
      },
      folders: [
        {
          name: "Parent",
          preRequestScript: "parentPre()",
          postRequestScript: "parentPost()"
        },
        {
          name: "Child",
          preRequestScript: "",
          postRequestScript: "childPost()"
        }
      ],
      request: {
        name: "Get user",
        preRequestScript: "   ",
        postRequestScript: "requestPost()"
      }
    });

    expect(scripts.preScripts).toEqual([
      { script: "parentPre()", source: "Folder pre-request: Parent" }
    ]);
    expect(scripts.postScripts).toEqual([
      { script: "requestPost()", source: "Request post-request: Get user" }
    ]);
  });

  it("falls back to collection scripts for root requests", () => {
    const scripts = resolveEffectiveScriptSources({
      collection: {
        preRequestScript: "collectionPre()",
        postRequestScript: "collectionPost()"
      },
      folders: [],
      request: {
        name: "Root",
        preRequestScript: "",
        postRequestScript: ""
      }
    });

    expect(scripts.preScripts).toEqual([
      { script: "collectionPre()", source: "Collection pre-request" }
    ]);
    expect(scripts.postScripts).toEqual([
      { script: "collectionPost()", source: "Collection post-request" }
    ]);
  });
});
