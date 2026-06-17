export const HTTP_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS"
] as const;

export type HttpMethod = (typeof HTTP_METHODS)[number];

export type BodyMode =
  | "none"
  | "formdata"
  | "form_urlencoded"
  | "raw"
  | "binary";

export type RawFormat = "json" | "text" | "xml" | "javascript" | "html";

export type VariableScope = "GLOBAL" | "ENVIRONMENT" | "COLLECTION" | "REQUEST";

export type ImportKind = "collection" | "environment" | "unknown";

export interface KeyValueRow {
  id?: string;
  key: string;
  value: string;
  enabled: boolean;
  isSecret?: boolean;
}

export interface AuthConfig {
  type: "none" | "bearer" | "basic" | "apiKey" | "unsupported";
  token?: string;
  username?: string;
  password?: string;
  key?: string;
  value?: string;
  placement?: "header" | "query";
  label?: string;
  raw?: unknown;
}

export interface VariableValue {
  id?: string;
  key: string;
  initialValue: string;
  currentValue: string;
  enabled: boolean;
  scope: VariableScope;
  isSecret: boolean;
}

export interface RequestDraft {
  id?: string;
  collectionId?: string;
  folderId?: string | null;
  name: string;
  method: HttpMethod;
  url: string;
  headers: KeyValueRow[];
  queryParams: KeyValueRow[];
  bodyMode: BodyMode;
  bodyRawFormat: RawFormat;
  bodyRaw: string;
  preRequestScript: string;
  postRequestScript: string;
  auth: AuthConfig;
}

export interface ApiRequest extends RequestDraft {
  id: string;
  collectionId: string;
  createdAt: string;
  updatedAt: string;
  variables: VariableValue[];
}

export interface ApiFolder {
  id: string;
  name: string;
  collectionId: string;
  parentId: string | null;
  preRequestScript: string;
  postRequestScript: string;
  children: ApiFolder[];
  requests: ApiRequest[];
}

export interface ApiCollection {
  id: string;
  name: string;
  description: string | null;
  preRequestScript: string;
  postRequestScript: string;
  folders: ApiFolder[];
  requests: ApiRequest[];
  variables: VariableValue[];
  createdAt: string;
  updatedAt: string;
}

export interface ApiEnvironment {
  id: string;
  name: string;
  active: boolean;
  variables: VariableValue[];
  createdAt: string;
  updatedAt: string;
}

export interface ApiHistoryEntry {
  id: string;
  requestId: string | null;
  method: HttpMethod;
  url: string;
  status: number | null;
  statusText: string | null;
  durationMs: number | null;
  sizeBytes: number | null;
  responseHeaders: KeyValueRow[];
  responseBodyPreview: string | null;
  responseBodyTruncated: boolean;
  error: string | null;
  createdAt: string;
}

export interface AppData {
  collections: ApiCollection[];
  environments: ApiEnvironment[];
  activeEnvironmentId: string | null;
  globalVariables: VariableValue[];
  history: ApiHistoryEntry[];
}

export interface ApiCookie {
  id: string;
  name: string;
  value: string;
  domain: string;
  path: string;
  hostOnly: boolean;
  secure: boolean;
  httpOnly: boolean;
  sameSite: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  lastAccessedAt: string | null;
}

export interface ImportPreview {
  type: ImportKind;
  name: string;
  folderCount: number;
  requestCount: number;
  variableCount: number;
  warnings: string[];
}

export interface SendResult {
  status: number;
  statusText: string;
  headers: KeyValueRow[];
  body: string;
  bodyBase64?: string;
  contentType: string;
  durationMs: number;
  sizeBytes: number;
}

export interface SendErrorResult {
  error: string;
  durationMs?: number;
}

export type ScriptPhase = "pre-request" | "post-request";

export interface ScriptExecutionResult {
  phase: ScriptPhase;
  ok: boolean;
  logs: string[];
  source?: string;
  error?: string;
}

export type CollectionRunTargetType = "collection" | "folder";
export type CollectionRunStatus = "running" | "completed" | "completed_with_errors" | "stopped";

export interface ApiCollectionRunSummary {
  id: string;
  collectionId: string;
  targetType: CollectionRunTargetType;
  targetId: string;
  targetName: string;
  environmentId: string | null;
  iterations: number;
  delayMs: number;
  stopOnError: boolean;
  status: CollectionRunStatus;
  requestOrder: string[];
  totalSteps: number;
  completedSteps: number;
  successCount: number;
  errorCount: number;
  createdAt: string;
  finishedAt: string | null;
}

export interface ApiCollectionRunStep {
  id: string;
  requestId: string | null;
  iteration: number;
  sequence: number;
  requestName: string;
  method: HttpMethod;
  resolvedUrl: string | null;
  status: number | null;
  statusText: string | null;
  durationMs: number | null;
  sizeBytes: number | null;
  responseHeaders: KeyValueRow[];
  responseBodyPreview: string | null;
  responseBodyTruncated: boolean;
  error: string | null;
  missingVariables: string[];
  scriptResults: ScriptExecutionResult[];
  createdAt: string;
}

export interface ApiCollectionRunReport {
  run: ApiCollectionRunSummary;
  steps: ApiCollectionRunStep[];
}
