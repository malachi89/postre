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
  | "raw_json"
  | "raw_text"
  | "form_urlencoded"
  | "multipart";

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
  bodyRaw: string;
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
  children: ApiFolder[];
  requests: ApiRequest[];
}

export interface ApiCollection {
  id: string;
  name: string;
  description: string | null;
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
  contentType: string;
  durationMs: number;
  sizeBytes: number;
}

export interface SendErrorResult {
  error: string;
  durationMs?: number;
}
