import type { ScriptSource } from "@/lib/server/request-execution";

export interface ScriptPair {
  preRequestScript?: string | null;
  postRequestScript?: string | null;
}

export interface ScriptInheritanceInput {
  collection: ScriptPair;
  folders: Array<ScriptPair & { name: string }>;
  request: ScriptPair & { name: string };
}

export function resolveEffectiveScriptSources(input: ScriptInheritanceInput): {
  preScripts: ScriptSource[];
  postScripts: ScriptSource[];
} {
  return {
    preScripts: chooseNearestScript([
      { script: input.request.preRequestScript ?? "", source: `Request pre-request: ${input.request.name}` },
      ...input.folders
        .slice()
        .reverse()
        .map((folder) => ({
          script: folder.preRequestScript ?? "",
          source: `Folder pre-request: ${folder.name}`
        })),
      {
        script: input.collection.preRequestScript ?? "",
        source: "Collection pre-request"
      }
    ]),
    postScripts: chooseNearestScript([
      { script: input.request.postRequestScript ?? "", source: `Request post-request: ${input.request.name}` },
      ...input.folders
        .slice()
        .reverse()
        .map((folder) => ({
          script: folder.postRequestScript ?? "",
          source: `Folder post-request: ${folder.name}`
        })),
      {
        script: input.collection.postRequestScript ?? "",
        source: "Collection post-request"
      }
    ])
  };
}

export function chooseNearestScript(candidates: ScriptSource[]): ScriptSource[] {
  const selected = candidates.find((candidate) => candidate.script.trim().length > 0);
  return selected ? [selected] : [];
}
