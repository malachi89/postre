"use client";

import {
  ChevronRight,
  Eye,
  EyeOff,
  FileJson,
  FileText,
  Folder,
  FolderPlus,
  History,
  Loader2,
  Pencil,
  Plus,
  Save,
  Send,
  Settings,
  Trash2,
  Upload
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  ApiCollection,
  ApiFolder,
  ApiHistoryEntry,
  ApiRequest,
  AppData,
  AuthConfig,
  BodyMode,
  HttpMethod,
  ImportPreview,
  KeyValueRow,
  RequestDraft,
  SendResult,
  VariableValue
} from "@/lib/types";
import { HTTP_METHODS } from "@/lib/types";
import { inferIsSecret, maskSecret } from "@/lib/secret-utils";

type SendResponseState =
  | (SendResult & {
      resolvedDraft?: RequestDraft;
    })
  | {
      error: string;
      missingVariables?: string[];
      resolvedDraft?: RequestDraft;
      durationMs?: number;
    };

const EMPTY_AUTH: AuthConfig = { type: "none" };
const REQUEST_TABS = ["auth", "headers", "query", "body"] as const;
type RequestTab = (typeof REQUEST_TABS)[number];

function CakeIcon({
  size,
  className = ""
}: {
  size: number;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center justify-center leading-none ${className}`}
      style={{ fontSize: size, lineHeight: 1 }}
      aria-hidden="true"
    >
      🍰
    </span>
  );
}

export function PostreApp() {
  const [data, setData] = useState<AppData | null>(null);
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null);
  const [selectedCollectionId, setSelectedCollectionId] = useState<string | null>(null);
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [draft, setDraft] = useState<RequestDraft | null>(null);
  const [response, setResponse] = useState<SendResponseState | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [showEnvironments, setShowEnvironments] = useState(false);
  const [showImport, setShowImport] = useState(false);

  const refresh = useCallback(async () => {
    const nextData = await api<AppData>("/api/data");
    setData(nextData);

    if (!selectedCollectionId && nextData.collections[0]) {
      setSelectedCollectionId(nextData.collections[0].id);
    }

    if (!selectedRequestId) {
      const first = findFirstRequest(nextData.collections);
      if (first) {
        setSelectedRequestId(first.id);
        setSelectedCollectionId(first.collectionId);
        setSelectedFolderId(first.folderId ?? null);
        setDraft(cloneDraft(first));
      }
    } else {
      const current = findRequest(nextData.collections, selectedRequestId);
      if (current) {
        setDraft(cloneDraft(current));
      }
    }
  }, [selectedCollectionId, selectedRequestId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const activeEnvironmentId = data?.activeEnvironmentId ?? null;
  async function createCollection() {
    const name = window.prompt("Collection name", "New Collection");
    if (name === null) {
      return;
    }

    setBusy(true);
    try {
      const result = await api<{ id: string }>("/api/collections", {
        method: "POST",
        body: JSON.stringify({ name })
      });
      setSelectedCollectionId(result.id);
      setSelectedFolderId(null);
      setNotice("Collection created.");
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function renameCollection(collection: ApiCollection) {
    const name = window.prompt("Collection name", collection.name);
    if (!name) {
      return;
    }

    await api(`/api/collections/${collection.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name })
    });
    await refresh();
  }

  async function deleteCollection(collection: ApiCollection) {
    if (!window.confirm(`Delete collection "${collection.name}"?`)) {
      return;
    }

    await api(`/api/collections/${collection.id}`, { method: "DELETE" });
    setSelectedRequestId(null);
    setDraft(null);
    await refresh();
  }

  async function createFolder() {
    const collectionId = selectedCollectionId ?? data?.collections[0]?.id;
    if (!collectionId) {
      setNotice("Create a collection first.");
      return;
    }

    const name = window.prompt("Folder name", "New Folder");
    if (name === null) {
      return;
    }

    const result = await api<{ id: string }>("/api/folders", {
      method: "POST",
      body: JSON.stringify({ name, collectionId, parentId: selectedFolderId })
    });
    setSelectedFolderId(result.id);
    await refresh();
  }

  async function renameFolder(folder: ApiFolder) {
    const name = window.prompt("Folder name", folder.name);
    if (!name) {
      return;
    }

    await api(`/api/folders/${folder.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name })
    });
    await refresh();
  }

  async function deleteFolder(folder: ApiFolder) {
    if (!window.confirm(`Delete folder "${folder.name}" and its nested content?`)) {
      return;
    }

    await api(`/api/folders/${folder.id}`, { method: "DELETE" });
    setSelectedFolderId(null);
    await refresh();
  }

  async function createRequest() {
    const collectionId = selectedCollectionId ?? data?.collections[0]?.id;
    if (!collectionId) {
      await createCollection();
      return;
    }

    const request = await api<ApiRequest>("/api/requests", {
      method: "POST",
      body: JSON.stringify({
        collectionId,
        folderId: selectedFolderId,
        name: "New Request",
        method: "GET",
        url: "",
        headers: [],
        queryParams: [],
        bodyMode: "none",
        bodyRaw: "",
        auth: EMPTY_AUTH
      })
    });

    setSelectedRequestId(request.id);
    setDraft(cloneDraft(request));
    await refresh();
  }

  async function saveDraft(showMessage = true): Promise<RequestDraft | null> {
    if (!draft?.id) {
      return null;
    }

    const saved = await api<ApiRequest>(`/api/requests/${draft.id}`, {
      method: "PATCH",
      body: JSON.stringify(draft)
    });
    const nextDraft = cloneDraft(saved);
    setDraft(nextDraft);
    if (showMessage) {
      setNotice("Request saved.");
    }
    await refresh();
    return nextDraft;
  }

  async function deleteRequest() {
    if (!draft?.id) {
      return;
    }

    if (!window.confirm(`Delete request "${draft.name}"?`)) {
      return;
    }

    await api(`/api/requests/${draft.id}`, { method: "DELETE" });
    setSelectedRequestId(null);
    setDraft(null);
    await refresh();
  }

  async function sendRequest() {
    if (!draft) {
      return;
    }

    setBusy(true);
    setResponse(null);
    try {
      const savedDraft = await saveDraft(false);
      const sendDraft = savedDraft ?? draft;
      const result = await api<SendResponseState>("/api/send", {
        method: "POST",
        body: JSON.stringify({
          draft: sendDraft,
          activeEnvironmentId
        }),
        allowError: true
      });
      setResponse(result);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  function selectRequest(request: ApiRequest) {
    setSelectedRequestId(request.id);
    setSelectedCollectionId(request.collectionId);
    setSelectedFolderId(request.folderId ?? null);
    setDraft(cloneDraft(request));
    setResponse(null);
  }

  function openHistory(entry: ApiHistoryEntry) {
    if (entry.requestId && data) {
      const request = findRequest(data.collections, entry.requestId);
      if (request) {
        selectRequest(request);
        return;
      }
    }

    setDraft({
      name: "History Request",
      method: entry.method,
      url: entry.url,
      headers: [],
      queryParams: [],
      bodyMode: "none",
      bodyRaw: "",
      auth: EMPTY_AUTH
    });
    setSelectedRequestId(null);
    setResponse(null);
  }

  const responseBody = useMemo(() => formatResponseBody(response), [response]);

  return (
    <main className="flex h-screen min-h-[720px] flex-col bg-[#f6f7f9] text-slate-950">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-slate-200 bg-white px-4">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded bg-amber-500 text-white">
            <CakeIcon size={17} />
          </div>
          <div>
            <h1 className="text-base font-semibold leading-5">PostRE</h1>
            <p className="text-xs text-slate-500">Local HTTP client</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <select
            className="h-9 min-w-44 rounded border border-slate-300 bg-white px-3 text-sm"
            value={activeEnvironmentId ?? ""}
            onChange={async (event) => {
              const environmentId = event.target.value || null;
              await api("/api/environments/active", {
                method: "PATCH",
                body: JSON.stringify({ environmentId })
              });
              await refresh();
            }}
            aria-label="Active environment"
          >
            <option value="">No environment</option>
            {data?.environments.map((environment) => (
              <option key={environment.id} value={environment.id}>
                {environment.name}
              </option>
            ))}
          </select>
          <IconButton label="Import" onClick={() => setShowImport(true)}>
            <Upload size={17} />
          </IconButton>
          <IconButton label="Environments" onClick={() => setShowEnvironments(true)}>
            <Settings size={17} />
          </IconButton>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[300px_minmax(0,1fr)]">
        <aside className="flex min-h-0 flex-col border-r border-slate-200 bg-white">
          <div className="flex h-12 items-center justify-between border-b border-slate-200 px-3">
            <span className="text-sm font-semibold text-slate-700">Collections</span>
            <div className="flex gap-1">
              <IconButton label="New collection" onClick={createCollection}>
                <Plus size={16} />
              </IconButton>
              <IconButton label="New folder" onClick={createFolder}>
                <FolderPlus size={16} />
              </IconButton>
              <IconButton label="New request" onClick={createRequest}>
                <FileText size={16} />
              </IconButton>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-auto p-2">
            {!data ? (
              <LoadingBlock label="Loading collections" />
            ) : data.collections.length === 0 ? (
              <EmptyState title="No collections" actionLabel="Create collection" onAction={createCollection} />
            ) : (
              data.collections.map((collection) => (
                <CollectionTree
                  key={collection.id}
                  collection={collection}
                  selectedRequestId={selectedRequestId}
                  selectedFolderId={selectedFolderId}
                  onSelectCollection={() => {
                    setSelectedCollectionId(collection.id);
                    setSelectedFolderId(null);
                  }}
                  onSelectFolder={(folder) => {
                    setSelectedCollectionId(folder.collectionId);
                    setSelectedFolderId(folder.id);
                  }}
                  onSelectRequest={selectRequest}
                  onRenameCollection={renameCollection}
                  onDeleteCollection={deleteCollection}
                  onRenameFolder={renameFolder}
                  onDeleteFolder={deleteFolder}
                />
              ))
            )}
          </div>

          <div className="max-h-64 border-t border-slate-200">
            <div className="flex h-10 items-center gap-2 px-3 text-sm font-semibold text-slate-700">
              <History size={15} />
              History
            </div>
            <div className="max-h-52 overflow-auto px-2 pb-2">
              {data?.history.length ? (
                data.history.map((entry) => (
                  <button
                    key={entry.id}
                    className="mb-1 w-full rounded border border-transparent px-2 py-1.5 text-left text-xs hover:border-slate-200 hover:bg-slate-50"
                    onClick={() => openHistory(entry)}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-teal-700">{entry.method}</span>
                      <span className={entry.error ? "text-rose-600" : "text-slate-500"}>
                        {entry.error ? "ERR" : entry.status}
                      </span>
                    </div>
                    <div className="truncate text-slate-500">{entry.url}</div>
                  </button>
                ))
              ) : (
                <p className="px-2 pb-3 text-xs text-slate-500">No requests sent yet.</p>
              )}
            </div>
          </div>
        </aside>

        <section className="flex min-h-0 flex-col bg-[#fbfcfd]">
          {draft ? (
            <div className="flex min-h-0 flex-1 flex-col">
              <RequestEditor
                draft={draft}
                busy={busy}
                onChange={setDraft}
                onSave={() => void saveDraft()}
                onSend={() => void sendRequest()}
                onDelete={() => void deleteRequest()}
              />
              <ResponsePanel response={response} body={responseBody} busy={busy} />
            </div>
          ) : (
            <div className="flex flex-1 items-center justify-center">
              <EmptyState title="Select or create a request" actionLabel="New request" onAction={createRequest} />
            </div>
          )}
        </section>
      </div>

      {notice ? (
        <div className="fixed bottom-4 left-1/2 z-40 -translate-x-1/2 rounded bg-slate-950 px-4 py-2 text-sm text-white shadow-lg">
          <button className="absolute inset-0" onClick={() => setNotice(null)} aria-label="Dismiss notice" />
          {notice}
        </div>
      ) : null}

      {showEnvironments && data ? (
        <EnvironmentModal
          data={data}
          onClose={() => setShowEnvironments(false)}
          onRefresh={refresh}
        />
      ) : null}

      {showImport ? (
        <ImportModal
          onClose={() => setShowImport(false)}
          onImported={async () => {
            setShowImport(false);
            await refresh();
            setNotice("Import completed.");
          }}
        />
      ) : null}
    </main>
  );
}

function RequestEditor({
  draft,
  busy,
  onChange,
  onSave,
  onSend,
  onDelete
}: {
  draft: RequestDraft;
  busy: boolean;
  onChange: (draft: RequestDraft) => void;
  onSave: () => void;
  onSend: () => void;
  onDelete: () => void;
}) {
  const [activeTab, setActiveTab] = useState<RequestTab>("auth");

  return (
    <div className="flex min-h-0 flex-1 flex-col border-b border-slate-200 bg-white">
      <div className="border-b border-slate-200 p-4">
        <div className="mb-3 flex items-center gap-2">
          <input
            className="h-10 min-w-0 flex-1 rounded border border-slate-300 px-3 text-sm font-semibold"
            value={draft.name}
            onChange={(event) => onChange({ ...draft, name: event.target.value })}
            aria-label="Request name"
          />
          <IconButton label="Save request" onClick={onSave}>
            <Save size={17} />
          </IconButton>
          <IconButton label="Delete request" onClick={onDelete}>
            <Trash2 size={17} />
          </IconButton>
        </div>

        <div className="flex gap-2">
          <select
            className="h-11 w-32 rounded border border-slate-300 bg-white px-3 text-sm font-semibold text-teal-700"
            value={draft.method}
            onChange={(event) => onChange({ ...draft, method: event.target.value as HttpMethod })}
            aria-label="HTTP method"
          >
            {HTTP_METHODS.map((method) => (
              <option key={method} value={method}>
                {method}
              </option>
            ))}
          </select>
          <input
            className="h-11 min-w-0 flex-1 rounded border border-slate-300 px-3 font-mono text-sm"
            value={draft.url}
            onChange={(event) => onChange({ ...draft, url: event.target.value })}
            placeholder="{{baseUrl}}/users"
            aria-label="Request URL"
          />
          <button
            className="inline-flex h-11 items-center gap-2 rounded bg-teal-600 px-4 text-sm font-semibold text-white hover:bg-teal-700 disabled:cursor-not-allowed disabled:opacity-50"
            onClick={onSend}
            disabled={busy || !draft.url.trim()}
          >
            {busy ? <Loader2 className="animate-spin" size={17} /> : <Send size={17} />}
            Send
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-4">
        <div className="grid gap-4">
          <div className="flex flex-wrap gap-2 border-b border-slate-200 pb-3">
            {REQUEST_TABS.map((tab) => {
              const label =
                tab === "auth" ? "Auth" : tab === "headers" ? "Headers" : tab === "query" ? "Query Params" : "Body";
              const active = activeTab === tab;

              return (
                <button
                  key={tab}
                  className={`rounded-full border px-4 py-2 text-sm font-semibold transition ${
                    active
                      ? "border-teal-600 bg-teal-600 text-white"
                      : "border-slate-300 bg-white text-slate-600 hover:bg-slate-50"
                  }`}
                  onClick={() => setActiveTab(tab)}
                  type="button"
                >
                  {label}
                </button>
              );
            })}
          </div>

          {activeTab === "auth" ? (
            <EditorSection title="Auth">
              <AuthEditor auth={draft.auth} onChange={(auth) => onChange({ ...draft, auth })} />
            </EditorSection>
          ) : null}

          {activeTab === "headers" ? (
            <EditorSection title="Headers">
              <KeyValueTable
                rows={draft.headers}
                onChange={(headers) => onChange({ ...draft, headers })}
                addLabel="Add header"
              />
            </EditorSection>
          ) : null}

          {activeTab === "query" ? (
            <EditorSection title="Query Params">
              <KeyValueTable
                rows={draft.queryParams}
                onChange={(queryParams) => onChange({ ...draft, queryParams })}
                addLabel="Add param"
              />
            </EditorSection>
          ) : null}

          {activeTab === "body" ? (
            <EditorSection title="Body">
              <div className="mb-3">
                <select
                  className="h-9 rounded border border-slate-300 bg-white px-3 text-sm"
                  value={draft.bodyMode}
                  onChange={(event) =>
                    onChange({
                      ...draft,
                      bodyMode: event.target.value as BodyMode
                    })
                  }
                >
                  <option value="none">none</option>
                  <option value="raw_json">raw JSON</option>
                  <option value="raw_text">raw text</option>
                </select>
              </div>
              <textarea
                className="min-h-64 w-full resize-y rounded border border-slate-300 bg-white p-3 font-mono text-sm"
                value={draft.bodyRaw}
                disabled={draft.bodyMode === "none"}
                onChange={(event) => onChange({ ...draft, bodyRaw: event.target.value })}
                placeholder={draft.bodyMode === "raw_json" ? '{\n  "name": "PostRE"\n}' : ""}
              />
            </EditorSection>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function AuthEditor({
  auth,
  onChange
}: {
  auth: AuthConfig;
  onChange: (auth: AuthConfig) => void;
}) {
  const type = auth.type;

  return (
    <div className="grid gap-3">
      <select
        className="h-9 w-48 rounded border border-slate-300 bg-white px-3 text-sm"
        value={type}
        onChange={(event) => onChange({ type: event.target.value as AuthConfig["type"] })}
      >
        <option value="none">No auth</option>
        <option value="bearer">Bearer token</option>
        <option value="basic">Basic auth</option>
        <option value="apiKey">API key</option>
        <option value="unsupported">Unsupported</option>
      </select>

      {type === "bearer" ? (
        <input
          className="h-9 rounded border border-slate-300 px-3 font-mono text-sm"
          value={auth.token ?? ""}
          onChange={(event) => onChange({ ...auth, token: event.target.value })}
          placeholder="{{token}}"
        />
      ) : null}

      {type === "basic" ? (
        <div className="grid grid-cols-2 gap-2">
          <input
            className="h-9 rounded border border-slate-300 px-3 font-mono text-sm"
            value={auth.username ?? ""}
            onChange={(event) => onChange({ ...auth, username: event.target.value })}
            placeholder="username"
          />
          <input
            className="h-9 rounded border border-slate-300 px-3 font-mono text-sm"
            value={auth.password ?? ""}
            onChange={(event) => onChange({ ...auth, password: event.target.value })}
            placeholder="password"
          />
        </div>
      ) : null}

      {type === "apiKey" ? (
        <div className="grid grid-cols-[1fr_1fr_140px] gap-2">
          <input
            className="h-9 rounded border border-slate-300 px-3 font-mono text-sm"
            value={auth.key ?? ""}
            onChange={(event) => onChange({ ...auth, key: event.target.value })}
            placeholder="X-API-Key"
          />
          <input
            className="h-9 rounded border border-slate-300 px-3 font-mono text-sm"
            value={auth.value ?? ""}
            onChange={(event) => onChange({ ...auth, value: event.target.value })}
            placeholder="{{apiKey}}"
          />
          <select
            className="h-9 rounded border border-slate-300 bg-white px-3 text-sm"
            value={auth.placement ?? "header"}
            onChange={(event) =>
              onChange({
                ...auth,
                placement: event.target.value as "header" | "query"
              })
            }
          >
            <option value="header">header</option>
            <option value="query">query</option>
          </select>
        </div>
      ) : null}

      {type === "unsupported" ? (
        <p className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Imported auth was preserved as metadata but cannot be executed yet.
        </p>
      ) : null}
    </div>
  );
}

function KeyValueTable({
  rows,
  onChange,
  addLabel
}: {
  rows: KeyValueRow[];
  onChange: (rows: KeyValueRow[]) => void;
  addLabel: string;
}) {
  const [showSecrets, setShowSecrets] = useState(false);

  function updateRow(index: number, patch: Partial<KeyValueRow>) {
    onChange(
      rows.map((row, rowIndex) =>
        rowIndex === index
          ? {
              ...row,
              ...patch,
              isSecret:
                patch.key !== undefined ? row.isSecret || inferIsSecret(patch.key) : row.isSecret
            }
          : row
      )
    );
  }

  return (
    <div className="grid gap-2">
      <div className="grid grid-cols-[40px_minmax(120px,1fr)_minmax(120px,1.4fr)_42px] gap-2 text-xs font-semibold uppercase text-slate-500">
        <span>On</span>
        <span>Key</span>
        <span>Value</span>
        <button
          className="flex h-6 items-center justify-center rounded border border-slate-200 bg-white"
          onClick={() => setShowSecrets((value) => !value)}
          title={showSecrets ? "Hide secrets" : "Show secrets"}
          type="button"
        >
          {showSecrets ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>
      </div>

      {rows.map((row, index) => (
        <div
          key={row.id ?? index}
          className="grid grid-cols-[40px_minmax(120px,1fr)_minmax(120px,1.4fr)_42px] gap-2"
        >
          <input
            type="checkbox"
            className="h-9 w-5"
            checked={row.enabled}
            onChange={(event) => updateRow(index, { enabled: event.target.checked })}
            aria-label="Enabled"
          />
          <input
            className="h-9 rounded border border-slate-300 px-2 font-mono text-sm"
            value={row.key}
            onChange={(event) => updateRow(index, { key: event.target.value })}
          />
          <input
            className="h-9 rounded border border-slate-300 px-2 font-mono text-sm"
            value={row.isSecret && !showSecrets ? maskSecret(row.value) : row.value}
            onChange={(event) => updateRow(index, { value: event.target.value })}
            readOnly={row.isSecret && !showSecrets}
          />
          <IconButton label="Remove row" onClick={() => onChange(rows.filter((_, rowIndex) => rowIndex !== index))}>
            <Trash2 size={15} />
          </IconButton>
        </div>
      ))}

      <button
        className="inline-flex h-9 w-fit items-center gap-2 rounded border border-slate-300 bg-white px-3 text-sm font-medium hover:bg-slate-50"
        onClick={() => onChange([...rows, { key: "", value: "", enabled: true, isSecret: false }])}
        type="button"
      >
        <Plus size={15} />
        {addLabel}
      </button>
    </div>
  );
}

function CollectionTree({
  collection,
  selectedRequestId,
  selectedFolderId,
  onSelectCollection,
  onSelectFolder,
  onSelectRequest,
  onRenameCollection,
  onDeleteCollection,
  onRenameFolder,
  onDeleteFolder
}: {
  collection: ApiCollection;
  selectedRequestId: string | null;
  selectedFolderId: string | null;
  onSelectCollection: () => void;
  onSelectFolder: (folder: ApiFolder) => void;
  onSelectRequest: (request: ApiRequest) => void;
  onRenameCollection: (collection: ApiCollection) => void;
  onDeleteCollection: (collection: ApiCollection) => void;
  onRenameFolder: (folder: ApiFolder) => void;
  onDeleteFolder: (folder: ApiFolder) => void;
}) {
  return (
    <div className="mb-2">
      <div className="group flex items-center gap-1 rounded px-2 py-1.5 hover:bg-slate-50">
        <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={onSelectCollection}>
          <ChevronRight size={14} className="text-slate-400" />
          <Folder size={15} className="text-amber-600" />
          <span className="truncate text-sm font-semibold">{collection.name}</span>
        </button>
        <TreeAction label="Rename collection" onClick={() => onRenameCollection(collection)}>
          <Pencil size={13} />
        </TreeAction>
        <TreeAction label="Delete collection" onClick={() => onDeleteCollection(collection)}>
          <Trash2 size={13} />
        </TreeAction>
      </div>
      <div className="ml-5 border-l border-slate-200 pl-2">
        {collection.folders.map((folder) => (
          <FolderTree
            key={folder.id}
            folder={folder}
            selectedRequestId={selectedRequestId}
            selectedFolderId={selectedFolderId}
            onSelectFolder={onSelectFolder}
            onSelectRequest={onSelectRequest}
            onRenameFolder={onRenameFolder}
            onDeleteFolder={onDeleteFolder}
          />
        ))}
        {collection.requests.map((request) => (
          <RequestTreeItem
            key={request.id}
            request={request}
            selected={selectedRequestId === request.id}
            onSelect={onSelectRequest}
          />
        ))}
      </div>
    </div>
  );
}

function FolderTree({
  folder,
  selectedRequestId,
  selectedFolderId,
  onSelectFolder,
  onSelectRequest,
  onRenameFolder,
  onDeleteFolder
}: {
  folder: ApiFolder;
  selectedRequestId: string | null;
  selectedFolderId: string | null;
  onSelectFolder: (folder: ApiFolder) => void;
  onSelectRequest: (request: ApiRequest) => void;
  onRenameFolder: (folder: ApiFolder) => void;
  onDeleteFolder: (folder: ApiFolder) => void;
}) {
  const selected = selectedFolderId === folder.id;

  return (
    <div>
      <div
        className={`group flex items-center gap-1 rounded px-2 py-1.5 ${
          selected ? "bg-teal-50 text-teal-800" : "hover:bg-slate-50"
        }`}
      >
        <button
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          onClick={() => onSelectFolder(folder)}
        >
          <Folder size={14} className={selected ? "text-teal-700" : "text-amber-600"} />
          <span className="truncate text-sm">{folder.name}</span>
        </button>
        <TreeAction label="Rename folder" onClick={() => onRenameFolder(folder)}>
          <Pencil size={13} />
        </TreeAction>
        <TreeAction label="Delete folder" onClick={() => onDeleteFolder(folder)}>
          <Trash2 size={13} />
        </TreeAction>
      </div>
      <div className="ml-4 border-l border-slate-200 pl-2">
        {folder.children.map((child) => (
          <FolderTree
            key={child.id}
            folder={child}
            selectedRequestId={selectedRequestId}
            selectedFolderId={selectedFolderId}
            onSelectFolder={onSelectFolder}
            onSelectRequest={onSelectRequest}
            onRenameFolder={onRenameFolder}
            onDeleteFolder={onDeleteFolder}
          />
        ))}
        {folder.requests.map((request) => (
          <RequestTreeItem
            key={request.id}
            request={request}
            selected={selectedRequestId === request.id}
            onSelect={onSelectRequest}
          />
        ))}
      </div>
    </div>
  );
}

function RequestTreeItem({
  request,
  selected,
  onSelect
}: {
  request: ApiRequest;
  selected: boolean;
  onSelect: (request: ApiRequest) => void;
}) {
  return (
    <button
      className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm ${
        selected ? "bg-teal-600 text-white" : "hover:bg-slate-50"
      }`}
      onClick={() => onSelect(request)}
    >
      <FileText size={14} className={selected ? "text-white" : "text-slate-500"} />
      <span className={selected ? "text-white" : "font-semibold text-teal-700"}>{request.method}</span>
      <span className="truncate">{request.name}</span>
    </button>
  );
}

function EnvironmentModal({
  data,
  onClose,
  onRefresh
}: {
  data: AppData;
  onClose: () => void;
  onRefresh: () => Promise<void>;
}) {
  const [selectedEnvId, setSelectedEnvId] = useState(data.activeEnvironmentId ?? data.environments[0]?.id ?? "");
  const selectedEnv = data.environments.find((environment) => environment.id === selectedEnvId) ?? null;
  const [globalRows, setGlobalRows] = useState<VariableValue[]>(data.globalVariables);
  const [envRows, setEnvRows] = useState<VariableValue[]>(selectedEnv?.variables ?? []);
  const [envName, setEnvName] = useState(selectedEnv?.name ?? "");

  useEffect(() => {
    const nextEnv = data.environments.find((environment) => environment.id === selectedEnvId) ?? null;
    setEnvRows(nextEnv?.variables ?? []);
    setEnvName(nextEnv?.name ?? "");
  }, [data.environments, selectedEnvId]);

  async function createEnvironment() {
    const name = window.prompt("Environment name", "New Environment");
    if (!name) {
      return;
    }

    const result = await api<{ id: string }>("/api/environments", {
      method: "POST",
      body: JSON.stringify({ name })
    });
    setSelectedEnvId(result.id);
    await onRefresh();
  }

  async function deleteEnvironment() {
    if (!selectedEnv || !window.confirm(`Delete environment "${selectedEnv.name}"?`)) {
      return;
    }

    await api(`/api/environments/${selectedEnv.id}`, { method: "DELETE" });
    setSelectedEnvId("");
    await onRefresh();
  }

  async function saveGlobals() {
    await api("/api/variables/bulk", {
      method: "PUT",
      body: JSON.stringify({
        scope: "GLOBAL",
        variables: globalRows.map(stripVariableId)
      })
    });
    await onRefresh();
  }

  async function saveEnvironment() {
    if (!selectedEnv) {
      return;
    }

    await api(`/api/environments/${selectedEnv.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: envName })
    });
    await api("/api/variables/bulk", {
      method: "PUT",
      body: JSON.stringify({
        scope: "ENVIRONMENT",
        environmentId: selectedEnv.id,
        variables: envRows.map(stripVariableId)
      })
    });
    await onRefresh();
  }

  return (
    <Modal title="Environments" onClose={onClose}>
      <div className="grid max-h-[78vh] min-h-[560px] grid-cols-[230px_minmax(520px,1fr)] gap-4 overflow-hidden">
        <aside className="overflow-auto border-r border-slate-200 pr-3">
          <button
            className="mb-3 inline-flex h-9 items-center gap-2 rounded bg-teal-600 px-3 text-sm font-semibold text-white"
            onClick={createEnvironment}
          >
            <Plus size={15} />
            New
          </button>
          {data.environments.map((environment) => (
            <button
              key={environment.id}
              className={`mb-1 w-full rounded px-3 py-2 text-left text-sm ${
                selectedEnvId === environment.id ? "bg-teal-50 font-semibold text-teal-800" : "hover:bg-slate-50"
              }`}
              onClick={() => setSelectedEnvId(environment.id)}
            >
              {environment.name}
              {environment.active ? <span className="ml-2 text-xs text-slate-500">active</span> : null}
            </button>
          ))}
        </aside>
        <div className="min-h-0 overflow-auto pr-1">
          <EditorSection title="Global Variables">
            <VariableTable rows={globalRows} onChange={setGlobalRows} />
            <button
              className="mt-3 inline-flex h-9 items-center gap-2 rounded border border-slate-300 bg-white px-3 text-sm font-semibold hover:bg-slate-50"
              onClick={saveGlobals}
            >
              <Save size={15} />
              Save globals
            </button>
          </EditorSection>

          <div className="h-4" />

          <EditorSection title="Environment Variables">
            {selectedEnv ? (
              <>
                <div className="mb-3 flex gap-2">
                  <input
                    className="h-9 flex-1 rounded border border-slate-300 px-3 text-sm font-semibold"
                    value={envName}
                    onChange={(event) => setEnvName(event.target.value)}
                  />
                  <button
                    className="inline-flex h-9 items-center gap-2 rounded border border-rose-200 bg-white px-3 text-sm font-semibold text-rose-700 hover:bg-rose-50"
                    onClick={deleteEnvironment}
                  >
                    <Trash2 size={15} />
                    Delete
                  </button>
                </div>
                <VariableTable rows={envRows} onChange={setEnvRows} />
                <button
                  className="mt-3 inline-flex h-9 items-center gap-2 rounded bg-teal-600 px-3 text-sm font-semibold text-white hover:bg-teal-700"
                  onClick={saveEnvironment}
                >
                  <Save size={15} />
                  Save environment
                </button>
              </>
            ) : (
              <p className="text-sm text-slate-500">Create an environment to manage scoped variables.</p>
            )}
          </EditorSection>
        </div>
      </div>
    </Modal>
  );
}

function VariableTable({
  rows,
  onChange
}: {
  rows: VariableValue[];
  onChange: (rows: VariableValue[]) => void;
}) {
  const [showSecrets, setShowSecrets] = useState(false);

  function updateRow(index: number, patch: Partial<VariableValue>) {
    onChange(
      rows.map((row, rowIndex) =>
        rowIndex === index
          ? {
              ...row,
              ...patch,
              isSecret:
                patch.key !== undefined ? row.isSecret || inferIsSecret(patch.key) : row.isSecret
            }
          : row
      )
    );
  }

  return (
    <div className="grid gap-2">
      <div className="grid grid-cols-[44px_minmax(100px,1fr)_minmax(120px,1fr)_minmax(120px,1fr)_70px_42px] gap-2 text-xs font-semibold uppercase text-slate-500">
        <span>On</span>
        <span>Key</span>
        <span>Initial</span>
        <span>Current</span>
        <span>Secret</span>
        <button
          className="flex h-6 items-center justify-center rounded border border-slate-200 bg-white"
          onClick={() => setShowSecrets((value) => !value)}
          title={showSecrets ? "Hide secrets" : "Show secrets"}
          type="button"
        >
          {showSecrets ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>
      </div>
      {rows.map((row, index) => (
        <div
          key={row.id ?? index}
          className="grid grid-cols-[44px_minmax(100px,1fr)_minmax(120px,1fr)_minmax(120px,1fr)_70px_42px] gap-2"
        >
          <input
            type="checkbox"
            className="h-9 w-5"
            checked={row.enabled}
            onChange={(event) => updateRow(index, { enabled: event.target.checked })}
          />
          <input
            className="h-9 rounded border border-slate-300 px-2 font-mono text-sm"
            value={row.key}
            onChange={(event) => updateRow(index, { key: event.target.value })}
          />
          <SecretInput
            value={row.initialValue}
            isSecret={row.isSecret}
            showSecrets={showSecrets}
            onChange={(value) => updateRow(index, { initialValue: value })}
          />
          <SecretInput
            value={row.currentValue}
            isSecret={row.isSecret}
            showSecrets={showSecrets}
            onChange={(value) => updateRow(index, { currentValue: value })}
          />
          <input
            type="checkbox"
            className="h-9 w-5"
            checked={row.isSecret}
            onChange={(event) => updateRow(index, { isSecret: event.target.checked })}
          />
          <IconButton label="Remove variable" onClick={() => onChange(rows.filter((_, rowIndex) => rowIndex !== index))}>
            <Trash2 size={15} />
          </IconButton>
        </div>
      ))}
      <button
        className="inline-flex h-9 w-fit items-center gap-2 rounded border border-slate-300 bg-white px-3 text-sm font-medium hover:bg-slate-50"
        onClick={() =>
          onChange([
            ...rows,
            {
              key: "",
              initialValue: "",
              currentValue: "",
              enabled: true,
              scope: "GLOBAL",
              isSecret: false
            }
          ])
        }
      >
        <Plus size={15} />
        Add variable
      </button>
    </div>
  );
}

function ImportModal({
  onClose,
  onImported
}: {
  onClose: () => void;
  onImported: () => Promise<void>;
}) {
  const [rawText, setRawText] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function loadFile(file: File | null) {
    if (!file) {
      return;
    }

    const text = await file.text();
    setRawText(text);
    setPreview(null);
    setError(null);
  }

  async function previewImport() {
    setError(null);
    setBusy(true);
    try {
      const json = JSON.parse(rawText);
      const result = await api<ImportPreview>("/api/import/preview", {
        method: "POST",
        body: JSON.stringify(json)
      });
      setPreview(result);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Invalid JSON");
    } finally {
      setBusy(false);
    }
  }

  async function importJson() {
    setError(null);
    setBusy(true);
    try {
      const json = JSON.parse(rawText);
      await api("/api/import", {
        method: "POST",
        body: JSON.stringify(json)
      });
      await onImported();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Import failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Import Postman JSON" onClose={onClose}>
      <div className="grid max-h-[78vh] min-h-[560px] grid-cols-[minmax(420px,1fr)_300px] gap-4 overflow-hidden">
        <div className="flex min-h-0 flex-col gap-3">
          <input
            type="file"
            accept=".json,application/json"
            className="text-sm"
            onChange={(event) => void loadFile(event.target.files?.[0] ?? null)}
          />
          <textarea
            className="min-h-0 flex-1 resize-none rounded border border-slate-300 p-3 font-mono text-xs"
            value={rawText}
            onChange={(event) => {
              setRawText(event.target.value);
              setPreview(null);
            }}
            placeholder="Paste a Postman Collection v2.1 or Environment JSON here."
          />
          <div className="flex gap-2">
            <button
              className="inline-flex h-9 items-center gap-2 rounded border border-slate-300 bg-white px-3 text-sm font-semibold hover:bg-slate-50 disabled:opacity-50"
              onClick={previewImport}
              disabled={busy || !rawText.trim()}
            >
              <FileJson size={15} />
              Preview
            </button>
            <button
              className="inline-flex h-9 items-center gap-2 rounded bg-teal-600 px-3 text-sm font-semibold text-white hover:bg-teal-700 disabled:opacity-50"
              onClick={importJson}
              disabled={busy || !preview || preview.type === "unknown"}
            >
              {busy ? <Loader2 className="animate-spin" size={15} /> : <Upload size={15} />}
              Import
            </button>
          </div>
        </div>
        <aside className="overflow-auto rounded border border-slate-200 bg-slate-50 p-3">
          <h3 className="mb-3 text-sm font-semibold">Preview</h3>
          {error ? <p className="rounded bg-rose-50 p-2 text-sm text-rose-700">{error}</p> : null}
          {preview ? (
            <div className="grid gap-2 text-sm">
              <PreviewRow label="Type" value={preview.type} />
              <PreviewRow label="Name" value={preview.name} />
              <PreviewRow label="Folders" value={String(preview.folderCount)} />
              <PreviewRow label="Requests" value={String(preview.requestCount)} />
              <PreviewRow label="Variables" value={String(preview.variableCount)} />
              {preview.warnings.length ? (
                <div className="mt-2 rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
                  {preview.warnings.map((warning) => (
                    <p key={warning} className="mb-1 last:mb-0">
                      {warning}
                    </p>
                  ))}
                </div>
              ) : null}
            </div>
          ) : (
            <p className="text-sm text-slate-500">Choose a JSON file or paste JSON, then preview it.</p>
          )}
        </aside>
      </div>
    </Modal>
  );
}

function SuccessResponse({ response, body }: { response: SendResult; body: string }) {
  return (
    <div className="grid gap-4">
      <div className="grid grid-cols-2 gap-2 text-sm">
        <Metric label="Status" value={`${response.status} ${response.statusText}`} tone="teal" />
        <Metric label="Time" value={`${response.durationMs} ms`} tone="amber" />
        <Metric label="Size" value={formatSize(response.sizeBytes)} />
        <Metric label="Type" value={response.contentType || "unknown"} />
      </div>
      <EditorSection title="Headers">
        <div className="grid gap-1 text-xs">
          {response.headers.map((header) => (
            <div key={`${header.key}-${header.value}`} className="grid grid-cols-[120px_1fr] gap-2">
              <span className="truncate font-semibold text-slate-600">{header.key}</span>
              <span className="break-all font-mono text-slate-700">{header.value}</span>
            </div>
          ))}
        </div>
      </EditorSection>
      <EditorSection title="Body">
        <pre className="max-h-[560px] overflow-auto rounded bg-slate-950 p-3 font-mono text-xs text-slate-50">
          {body}
        </pre>
      </EditorSection>
    </div>
  );
}

function ResponsePanel({
  response,
  body,
  busy
}: {
  response: SendResponseState | null;
  body: string;
  busy: boolean;
}) {
  return (
    <aside className="flex min-h-0 flex-col border-t border-slate-200 bg-white">
      <div className="flex h-12 items-center justify-between border-b border-slate-200 px-4">
        <span className="text-sm font-semibold text-slate-700">Response</span>
        {busy ? <Loader2 className="animate-spin text-teal-600" size={18} /> : null}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {response ? (
          "error" in response ? (
            <ErrorResponse response={response} />
          ) : (
            <SuccessResponse response={response} body={body} />
          )
        ) : (
          <p className="text-sm text-slate-500">
            Send a request to see status, headers, timing, size, and body here.
          </p>
        )}
      </div>
    </aside>
  );
}

function ErrorResponse({
  response
}: {
  response: Extract<SendResponseState, { error: string }>;
}) {
  return (
    <div className="grid gap-3">
      <div className="rounded border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
        <div className="font-semibold">{response.error}</div>
        {response.durationMs ? <div>{response.durationMs} ms</div> : null}
      </div>
      {response.missingVariables?.length ? (
        <div className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          Missing variables: {response.missingVariables.join(", ")}
        </div>
      ) : null}
      {response.resolvedDraft ? (
        <EditorSection title="Resolved Draft">
          <pre className="rounded bg-slate-950 p-3 font-mono text-xs text-slate-50">
            {JSON.stringify(response.resolvedDraft, null, 2)}
          </pre>
        </EditorSection>
      ) : null}
    </div>
  );
}

function Modal({
  title,
  children,
  onClose
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 p-6">
      <div className="w-full max-w-5xl rounded bg-white shadow-2xl">
        <div className="flex h-12 items-center justify-between border-b border-slate-200 px-4">
          <h2 className="text-sm font-semibold">{title}</h2>
          <button className="rounded px-2 py-1 text-sm text-slate-500 hover:bg-slate-100" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}

function EditorSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded border border-slate-200 bg-white p-3 shadow-panel">
      <h2 className="mb-3 text-sm font-semibold text-slate-700">{title}</h2>
      {children}
    </section>
  );
}

function IconButton({
  label,
  children,
  onClick
}: {
  label: string;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      className="inline-flex h-9 w-9 items-center justify-center rounded border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
      onClick={onClick}
      title={label}
      aria-label={label}
      type="button"
    >
      {children}
    </button>
  );
}

function TreeAction({
  label,
  children,
  onClick
}: {
  label: string;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      className="hidden h-6 w-6 items-center justify-center rounded text-slate-500 hover:bg-white group-hover:flex"
      title={label}
      aria-label={label}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}

function EmptyState({
  title,
  actionLabel,
  onAction
}: {
  title: string;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <div className="grid justify-items-center gap-3 text-center">
      <p className="text-sm font-semibold text-slate-700">{title}</p>
      <button
        className="inline-flex h-9 items-center gap-2 rounded bg-teal-600 px-3 text-sm font-semibold text-white hover:bg-teal-700"
        onClick={onAction}
      >
        <Plus size={15} />
        {actionLabel}
      </button>
    </div>
  );
}

function LoadingBlock({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 px-2 py-3 text-sm text-slate-500">
      <Loader2 className="animate-spin" size={16} />
      {label}
    </div>
  );
}

function Metric({
  label,
  value,
  tone = "slate"
}: {
  label: string;
  value: string;
  tone?: "slate" | "teal" | "amber";
}) {
  const color =
    tone === "teal"
      ? "border-teal-200 bg-teal-50 text-teal-800"
      : tone === "amber"
        ? "border-amber-200 bg-amber-50 text-amber-800"
        : "border-slate-200 bg-slate-50 text-slate-800";

  return (
    <div className={`rounded border p-2 ${color}`}>
      <div className="text-xs uppercase">{label}</div>
      <div className="truncate text-sm font-semibold">{value}</div>
    </div>
  );
}

function PreviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[90px_1fr] gap-2">
      <span className="text-slate-500">{label}</span>
      <span className="font-semibold">{value}</span>
    </div>
  );
}

function SecretInput({
  value,
  isSecret,
  showSecrets,
  onChange
}: {
  value: string;
  isSecret: boolean;
  showSecrets: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <input
      className="h-9 rounded border border-slate-300 px-2 font-mono text-sm"
      value={isSecret && !showSecrets ? maskSecret(value) : value}
      readOnly={isSecret && !showSecrets}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

function findFirstRequest(collections: ApiCollection[]): ApiRequest | null {
  for (const collection of collections) {
    if (collection.requests[0]) {
      return collection.requests[0];
    }

    const nested = findFirstRequestInFolders(collection.folders);
    if (nested) {
      return nested;
    }
  }

  return null;
}

function findFirstRequestInFolders(folders: ApiFolder[]): ApiRequest | null {
  for (const folder of folders) {
    if (folder.requests[0]) {
      return folder.requests[0];
    }

    const nested = findFirstRequestInFolders(folder.children);
    if (nested) {
      return nested;
    }
  }

  return null;
}

function findRequest(collections: ApiCollection[], requestId: string): ApiRequest | null {
  for (const collection of collections) {
    const direct = collection.requests.find((request) => request.id === requestId);
    if (direct) {
      return direct;
    }

    const nested = findRequestInFolders(collection.folders, requestId);
    if (nested) {
      return nested;
    }
  }

  return null;
}

function findRequestInFolders(folders: ApiFolder[], requestId: string): ApiRequest | null {
  for (const folder of folders) {
    const direct = folder.requests.find((request) => request.id === requestId);
    if (direct) {
      return direct;
    }

    const nested = findRequestInFolders(folder.children, requestId);
    if (nested) {
      return nested;
    }
  }

  return null;
}

function cloneDraft(request: ApiRequest): RequestDraft {
  return {
    id: request.id,
    collectionId: request.collectionId,
    folderId: request.folderId,
    name: request.name,
    method: request.method,
    url: request.url,
    headers: request.headers.map((row) => ({ ...row })),
    queryParams: request.queryParams.map((row) => ({ ...row })),
    bodyMode: request.bodyMode,
    bodyRaw: request.bodyRaw,
    auth: { ...request.auth }
  };
}

function stripVariableId(variable: VariableValue): Omit<VariableValue, "id"> {
  return {
    key: variable.key,
    initialValue: variable.initialValue,
    currentValue: variable.currentValue,
    enabled: variable.enabled,
    scope: variable.scope,
    isSecret: variable.isSecret || inferIsSecret(variable.key)
  };
}

function formatResponseBody(response: SendResponseState | null): string {
  if (!response || "error" in response) {
    return "";
  }

  const body = response.body;
  const contentType = response.contentType.toLowerCase();

  if (contentType.includes("json") || body.trim().startsWith("{") || body.trim().startsWith("[")) {
    try {
      return JSON.stringify(JSON.parse(body), null, 2);
    } catch {
      return body;
    }
  }

  return body;
}

function formatSize(sizeBytes: number): string {
  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }

  if (sizeBytes < 1024 * 1024) {
    return `${(sizeBytes / 1024).toFixed(1)} KB`;
  }

  return `${(sizeBytes / 1024 / 1024).toFixed(1)} MB`;
}

async function api<T = unknown>(
  url: string,
  options: RequestInit & { allowError?: boolean } = {}
): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers ?? {})
    }
  });

  const payload = (await response.json().catch(() => ({}))) as T & { error?: string };

  if (!response.ok && !options.allowError) {
    throw new Error(payload.error ?? `Request failed with ${response.status}`);
  }

  return payload as T;
}
