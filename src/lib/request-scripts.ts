import { getQuickJS } from "quickjs-emscripten";
import { prisma } from "@/lib/db";
import { inferIsSecret } from "@/lib/secret-utils";
import type {
  KeyValueRow,
  RequestDraft,
  ScriptExecutionResult,
  ScriptPhase,
  SendResult,
  VariableScope
} from "@/lib/types";
import type { VariableBuckets } from "@/lib/variable-resolver";

const DEFAULT_SCRIPT_TIMEOUT_MS = 1_000;
const SCRIPT_MEMORY_LIMIT_BYTES = 8 * 1024 * 1024;
const SCRIPT_STACK_SIZE_BYTES = 512 * 1024;

type ScriptMutationAction = "set" | "unset";

export interface ScriptMutation {
  scope: VariableScope;
  action: ScriptMutationAction;
  key: string;
  value?: string;
}

export interface RequestScriptRun {
  result: ScriptExecutionResult;
  mutations: ScriptMutation[];
}

export interface RequestScriptInput {
  phase: ScriptPhase;
  script: string;
  draft: RequestDraft;
  variables: VariableBuckets;
  activeEnvironmentId: string | null;
  response?: SendResult;
  timeoutMs?: number;
}

interface ScriptState {
  phase: ScriptPhase;
  draft: {
    name: string;
    method: string;
    url: string;
    headers: KeyValueRow[];
    queryParams: KeyValueRow[];
    bodyRaw: string;
  };
  variables: VariableBuckets;
  response: SendResult | null;
  hasActiveEnvironment: boolean;
}

interface ScriptPayload {
  mutations?: Array<Partial<ScriptMutation>>;
}

export async function runRequestScript(input: RequestScriptInput): Promise<RequestScriptRun> {
  const script = input.script.trim();
  const result: ScriptExecutionResult = {
    phase: input.phase,
    ok: true,
    logs: []
  };

  if (!script) {
    return { result, mutations: [] };
  }

  const state: ScriptState = {
    phase: input.phase,
    draft: {
      name: input.draft.name,
      method: input.draft.method,
      url: input.draft.url,
      headers: input.draft.headers,
      queryParams: input.draft.queryParams,
      bodyRaw: input.draft.bodyRaw
    },
    variables: input.variables,
    response: input.response ?? null,
    hasActiveEnvironment: Boolean(input.activeEnvironmentId)
  };

  const started = Date.now();
  const timeoutMs = input.timeoutMs ?? DEFAULT_SCRIPT_TIMEOUT_MS;
  const QuickJS = await getQuickJS();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(SCRIPT_MEMORY_LIMIT_BYTES);
  runtime.setMaxStackSize(SCRIPT_STACK_SIZE_BYTES);
  runtime.setInterruptHandler(() => Date.now() - started > timeoutMs);

  const vm = runtime.newContext();

  const logHandle = vm.newFunction("log", (...args) => {
    result.logs.push(args.map((arg) => formatLogValue(vm.dump(arg))).join(" "));
  });
  const consoleHandle = vm.newObject();
  vm.setProp(consoleHandle, "log", logHandle);
  vm.setProp(consoleHandle, "info", logHandle);
  vm.setProp(consoleHandle, "warn", logHandle);
  vm.setProp(consoleHandle, "error", logHandle);
  vm.setProp(vm.global, "console", consoleHandle);
  consoleHandle.dispose();
  logHandle.dispose();

  try {
    const evaluation = vm.evalCode(buildScriptSource(state, script), `${input.phase}.js`);
    if (evaluation.error) {
      result.ok = false;
      result.error = formatScriptError(vm.dump(evaluation.error));
      evaluation.error.dispose();
      return { result, mutations: [] };
    }

    if (!evaluation.value) {
      result.ok = false;
      result.error = "Script returned no result.";
      return { result, mutations: [] };
    }

    const payloadText = vm.dump(evaluation.value);
    evaluation.value.dispose();
    const payload = parseScriptPayload(payloadText);
    return {
      result,
      mutations: normalizeMutations(payload.mutations ?? [])
    };
  } finally {
    vm.dispose();
    runtime.dispose();
  }
}

export async function applyScriptMutations(
  mutations: ScriptMutation[],
  draft: RequestDraft,
  activeEnvironmentId: string | null
) {
  for (const mutation of mutations) {
    const where = mutationWhere(mutation, draft, activeEnvironmentId);

    if (mutation.action === "unset") {
      await prisma.variable.deleteMany({ where });
      continue;
    }

    await prisma.$transaction([
      prisma.variable.deleteMany({ where }),
      prisma.variable.create({
        data: {
          key: mutation.key,
          initialValue: mutation.value ?? "",
          currentValue: mutation.value ?? "",
          enabled: true,
          scope: mutation.scope,
          isSecret: inferIsSecret(mutation.key),
          environmentId: mutation.scope === "ENVIRONMENT" ? activeEnvironmentId : null,
          collectionId: mutation.scope === "COLLECTION" ? draft.collectionId ?? null : null,
          requestId: mutation.scope === "REQUEST" ? draft.id ?? null : null
        }
      })
    ]);
  }
}

function mutationWhere(
  mutation: ScriptMutation,
  draft: RequestDraft,
  activeEnvironmentId: string | null
) {
  if (mutation.scope === "GLOBAL") {
    return { scope: "GLOBAL" as const, key: mutation.key };
  }

  if (mutation.scope === "ENVIRONMENT") {
    if (!activeEnvironmentId) {
      throw new Error("pm.environment requires an active environment.");
    }
    return { scope: "ENVIRONMENT" as const, environmentId: activeEnvironmentId, key: mutation.key };
  }

  if (mutation.scope === "COLLECTION") {
    if (!draft.collectionId) {
      throw new Error("pm.collectionVariables requires a saved collection.");
    }
    return { scope: "COLLECTION" as const, collectionId: draft.collectionId, key: mutation.key };
  }

  if (!draft.id) {
    throw new Error("pm.variables.set requires a saved request.");
  }
  return { scope: "REQUEST" as const, requestId: draft.id, key: mutation.key };
}

function buildScriptSource(state: ScriptState, script: string): string {
  return `
(function () {
  "use strict";
  var __state = ${JSON.stringify(state)};
  var __mutations = [];

  function __string(value) {
    return value === undefined || value === null ? "" : String(value);
  }

  function __rowsToHeaders(rows) {
    return {
      get: function (key) {
        var needle = __string(key).toLowerCase();
        var row = (rows || []).find(function (entry) {
          return entry && entry.enabled !== false && __string(entry.key).toLowerCase() === needle;
        });
        return row ? __string(row.value) : undefined;
      },
      all: function () {
        return (rows || []).slice();
      }
    };
  }

  function __currentValue(variable) {
    if (!variable || variable.enabled === false) {
      return undefined;
    }
    return variable.currentValue || variable.initialValue || "";
  }

  function __find(scope, key) {
    var variables = __state.variables[scope] || [];
    for (var index = 0; index < variables.length; index += 1) {
      if (variables[index].key === key && variables[index].enabled !== false) {
        return variables[index];
      }
    }
    return null;
  }

  function __setLocal(scope, key, value) {
    var variables = __state.variables[scope] || [];
    var existing = __find(scope, key);
    if (existing) {
      existing.currentValue = value;
      existing.initialValue = existing.initialValue || value;
      existing.enabled = true;
    } else {
      variables.push({
        key: key,
        initialValue: value,
        currentValue: value,
        enabled: true,
        scope: scope === "global" ? "GLOBAL" : scope === "environment" ? "ENVIRONMENT" : scope === "collection" ? "COLLECTION" : "REQUEST",
        isSecret: false
      });
      __state.variables[scope] = variables;
    }
  }

  function __unsetLocal(scope, key) {
    __state.variables[scope] = (__state.variables[scope] || []).filter(function (variable) {
      return variable.key !== key;
    });
  }

  function __scopeApi(localScope, mutationScope, requireEnvironment) {
    return {
      get: function (key) {
        var variable = __find(localScope, __string(key));
        return __currentValue(variable);
      },
      set: function (key, value) {
        if (requireEnvironment && !__state.hasActiveEnvironment) {
          throw new Error("pm.environment requires an active environment.");
        }
        key = __string(key);
        value = __string(value);
        __setLocal(localScope, key, value);
        __mutations.push({ scope: mutationScope, action: "set", key: key, value: value });
      },
      unset: function (key) {
        if (requireEnvironment && !__state.hasActiveEnvironment) {
          throw new Error("pm.environment requires an active environment.");
        }
        key = __string(key);
        __unsetLocal(localScope, key);
        __mutations.push({ scope: mutationScope, action: "unset", key: key });
      }
    };
  }

  var __response = __state.response;
  var pm = {
    request: {
      name: __state.draft.name,
      method: __state.draft.method,
      url: __state.draft.url,
      headers: __rowsToHeaders(__state.draft.headers),
      body: __state.draft.bodyRaw
    },
    response: __response ? {
      code: __response.status,
      status: __response.status,
      statusText: __response.statusText,
      responseTime: __response.durationMs,
      headers: __rowsToHeaders(__response.headers),
      text: function () {
        return __response.body || "";
      },
      json: function () {
        return JSON.parse(__response.body || "");
      }
    } : undefined,
    globals: __scopeApi("global", "GLOBAL", false),
    environment: __scopeApi("environment", "ENVIRONMENT", true),
    collectionVariables: __scopeApi("collection", "COLLECTION", false),
    variables: {
      get: function (key) {
        key = __string(key);
        var scopes = ["request", "collection", "environment", "global"];
        for (var index = 0; index < scopes.length; index += 1) {
          var value = __currentValue(__find(scopes[index], key));
          if (value !== undefined) {
            return value;
          }
        }
        return undefined;
      },
      set: function (key, value) {
        key = __string(key);
        value = __string(value);
        __setLocal("request", key, value);
        __mutations.push({ scope: "REQUEST", action: "set", key: key, value: value });
      },
      unset: function (key) {
        key = __string(key);
        __unsetLocal("request", key);
        __mutations.push({ scope: "REQUEST", action: "unset", key: key });
      }
    }
  };

  ${script}

  return JSON.stringify({ mutations: __mutations });
})()
`;
}

function parseScriptPayload(value: unknown): ScriptPayload {
  if (typeof value !== "string") {
    return {};
  }

  try {
    return JSON.parse(value) as ScriptPayload;
  } catch {
    return {};
  }
}

function normalizeMutations(mutations: Array<Partial<ScriptMutation>>): ScriptMutation[] {
  return mutations
    .map((mutation) => {
      const scope = normalizeMutationScope(mutation.scope);
      const action = mutation.action === "unset" ? "unset" : mutation.action === "set" ? "set" : null;
      const key = typeof mutation.key === "string" ? mutation.key.trim() : "";
      if (!scope || !action || !key) {
        return null;
      }

      return {
        scope,
        action,
        key,
        value: mutation.value === undefined ? undefined : String(mutation.value)
      };
    })
    .filter(Boolean) as ScriptMutation[];
}

function normalizeMutationScope(scope: unknown): VariableScope | null {
  if (scope === "GLOBAL" || scope === "ENVIRONMENT" || scope === "COLLECTION" || scope === "REQUEST") {
    return scope;
  }

  return null;
}

function formatScriptError(value: unknown): string {
  if (value instanceof Error) {
    return value.message;
  }

  if (value && typeof value === "object") {
    const record = value as { name?: unknown; message?: unknown; stack?: unknown };
    const name = typeof record.name === "string" ? record.name : "ScriptError";
    const message = typeof record.message === "string" ? record.message : formatLogValue(value);
    return `${name}: ${message}`;
  }

  return formatLogValue(value);
}

function formatLogValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (value === undefined) {
    return "undefined";
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
