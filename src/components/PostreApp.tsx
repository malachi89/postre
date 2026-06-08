"use client";

import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Copy,
  Cookie,
  Download,
  Eye,
  EyeOff,
  FileJson,
  FileText,
  Folder,
  FolderPlus,
  Loader2,
  Moon,
  PanelBottomClose,
  PanelBottomOpen,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Play,
  Plus,
  RotateCw,
  Save,
  Send,
  Settings,
  Sun,
  Trash2,
  Upload,
  X
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type {
  ApiCollection,
  ApiCollectionRunReport,
  ApiCookie,
  ApiEnvironment,
  ApiFolder,
  ApiRequest,
  AppData,
  AuthConfig,
  BodyMode,
  HttpMethod,
  ImportPreview,
  KeyValueRow,
  RequestDraft,
  ScriptExecutionResult,
  SendResult,
  VariableValue
} from "@/lib/types";
import { HTTP_METHODS } from "@/lib/types";
import { CurlParseError, parseCurlToRequestDraft, requestDraftToCurl } from "@/lib/curl";
import { inferIsSecret, maskSecret } from "@/lib/secret-utils";
import {
  applyVariableAutocomplete,
  findVariableAutocompleteMatch,
  getVariableSuggestions
} from "@/lib/variable-autocomplete";
import type { VariableAutocompleteMatch, VariableLookupLike } from "@/lib/variable-autocomplete";
import { getEffectiveAutoHeaders } from "@/lib/auto-headers";

type SendSuccessResponseState = SendResult & {
  resolvedDraft?: RequestDraft;
  scriptResults?: ScriptExecutionResult[];
};

type SendErrorResponseState = {
  error: string;
  missingVariables?: string[];
  resolvedDraft?: RequestDraft;
  durationMs?: number;
  scriptResults?: ScriptExecutionResult[];
};

type SendResponseState = SendSuccessResponseState | SendErrorResponseState;
type CollectionRunnerTarget = { type: "collection" | "folder"; id: string; name: string };
type RequestTreeDropTarget = { requestId: string; collectionId: string; folderId: string | null };
type OpenRequestTab = {
  tabId: string;
  requestId: string;
  draft: RequestDraft;
  response: SendResponseState | null;
  busy: boolean;
  dirty: boolean;
  saving: boolean;
};
type RequestTabContextMenuState = {
  tabId: string;
  x: number;
  y: number;
};
type RequestTreeContextMenuState = {
  requestId: string;
  x: number;
  y: number;
};
type EnvironmentMenuState = {
  environmentId: string;
  x: number;
  y: number;
};
type StoredRequestTabs = {
  tabs: Array<{ tabId: string; requestId: string }>;
  activeTabId: string | null;
};
type BodyViewMode = "edit" | "pretty";
type BodyFormat = "json" | "xml" | "text";

const EMPTY_AUTH: AuthConfig = { type: "none" };
const REQUEST_TABS = ["body", "auth", "headers", "query", "scripts"] as const;
type RequestTab = (typeof REQUEST_TABS)[number];
const SCRIPT_TABS = ["pre-request", "post-request"] as const;
type ScriptTab = (typeof SCRIPT_TABS)[number];
const RESPONSE_HANDLE_HEIGHT = 12;
const RESPONSE_PANEL_MIN_HEIGHT = 220;
const REQUEST_EDITOR_MIN_HEIGHT = 260;
const COLLECTIONS_PANEL_MIN_WIDTH = 240;
const COLLECTIONS_PANEL_MAX_WIDTH = 560;
const COLLECTIONS_HANDLE_WIDTH = 10;
const SIDEBAR_PANEL_MIN_HEIGHT = 220;
const SIDEBAR_HANDLE_HEIGHT = 10;
const THEME_STORAGE_KEY = "postre-theme";
const REQUEST_TABS_STORAGE_KEY = "postre-request-tabs";
const EXPANDED_FOLDERS_STORAGE_KEY = "postre-expanded-folders";
const REQUEST_DRAG_DATA_TYPE = "application/x-postre-request-id";
const TOKEN_PATTERN = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;
type Theme = "light" | "dark";
type MainPanelMode = "request" | "environment";
type VariableLookup = VariableLookupLike;
type SelectionOffsets = { start: number; end: number };

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function getDraggedRequestId(event: Pick<React.DragEvent, "dataTransfer">) {
  return event.dataTransfer.getData(REQUEST_DRAG_DATA_TYPE) || event.dataTransfer.getData("text/plain");
}

function hasDraggedRequestType(event: Pick<React.DragEvent, "dataTransfer">) {
  return Array.from(event.dataTransfer.types).includes(REQUEST_DRAG_DATA_TYPE);
}

function readExpandedFolders(): Record<string, boolean> {
  if (typeof window === "undefined") {
    return {};
  }

  try {
    const stored = window.localStorage.getItem(EXPANDED_FOLDERS_STORAGE_KEY);
    if (stored) {
      return JSON.parse(stored);
    }
  } catch {
    // Ignore
  }

  return {};
}

function readPreferredTheme(): Theme {
  if (typeof window === "undefined") {
    return "light";
  }

  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "light" || stored === "dark") {
      return stored;
    }
  } catch {
    // Ignore storage access issues and fall back to the system setting.
  }

  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}

function variableValue(variable: VariableValue) {
  return variable.currentValue || variable.initialValue;
}

function buildVariableLookup({
  global,
  environment,
  collection,
  request
}: {
  global: VariableValue[];
  environment: VariableValue[];
  collection: VariableValue[];
  request: VariableValue[];
}): VariableLookup {
  const lookup: VariableLookup = {};

  for (const scope of [global, environment, collection, request]) {
    for (const variable of scope) {
      if (!variable.enabled || !variable.key) {
        continue;
      }

      lookup[variable.key] = {
        value: variableValue(variable),
        isSecret: variable.isSecret
      };
    }
  }

  return lookup;
}

function readEditableText(element: HTMLDivElement, multiline: boolean) {
  const raw = multiline ? element.innerText : element.textContent ?? "";
  const normalized = raw.replace(/\r/g, "");

  return multiline ? normalized.replace(/\n$/, "") : normalized.replace(/\n/g, "");
}

function getSelectionOffsets(root: HTMLElement): SelectionOffsets | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return null;
  }

  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) {
    return null;
  }

  const startRange = range.cloneRange();
  startRange.selectNodeContents(root);
  startRange.setEnd(range.startContainer, range.startOffset);

  const endRange = range.cloneRange();
  endRange.selectNodeContents(root);
  endRange.setEnd(range.endContainer, range.endOffset);

  return {
    start: startRange.toString().length,
    end: endRange.toString().length
  };
}

function resolveTextPosition(root: HTMLElement, targetOffset: number) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let current = walker.nextNode();
  let consumed = 0;
  let lastTextNode: Text | null = null;

  while (current) {
    const textNode = current as Text;
    const nextConsumed = consumed + textNode.data.length;

    if (targetOffset <= nextConsumed) {
      return {
        node: textNode,
        offset: targetOffset - consumed
      };
    }

    consumed = nextConsumed;
    lastTextNode = textNode;
    current = walker.nextNode();
  }

  if (lastTextNode) {
    return {
      node: lastTextNode,
      offset: lastTextNode.data.length
    };
  }

  return {
    node: root,
    offset: 0
  };
}

function restoreSelection(root: HTMLElement, selectionOffsets: SelectionOffsets) {
  const selection = window.getSelection();
  if (!selection) {
    return;
  }

  const range = document.createRange();
  const start = resolveTextPosition(root, selectionOffsets.start);
  const end = resolveTextPosition(root, selectionOffsets.end);

  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  selection.removeAllRanges();
  selection.addRange(range);
}

function escapeHtml(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function renderTokenizedHtml(value: string, variableLookup: VariableLookup) {
  const parts: string[] = [];
  let match: RegExpExecArray | null;
  let lastIndex = 0;
  TOKEN_PATTERN.lastIndex = 0;

  while ((match = TOKEN_PATTERN.exec(value)) !== null) {
    if (match.index > lastIndex) {
      parts.push(escapeHtml(value.slice(lastIndex, match.index)));
    }

    const tokenText = match[0];
    const variableName = match[1];
    const resolvedVariable = variableLookup[variableName];
    const hasValue = resolvedVariable !== undefined;

    const colorClass = hasValue
      ? "border-teal-200 bg-teal-50 text-teal-800"
      : "border-amber-200 bg-amber-50 text-amber-800";

    parts.push(
      `<span class="mx-px inline-flex rounded-full border px-2 py-0.5 align-baseline text-[0.95em] leading-5 ${colorClass}" title="${escapeHtml(hasValue ? resolvedVariable.value : `Variable not found: ${variableName}`)}">${escapeHtml(tokenText)}</span>`
    );

    lastIndex = match.index + tokenText.length;
  }

  if (lastIndex < value.length) {
    parts.push(escapeHtml(value.slice(lastIndex)));
  }

  return parts.join("");
}

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

function TokenizedField({
  value,
  onChange,
  placeholder,
  ariaLabel,
  variableLookup,
  disabled = false,
  multiline = false,
  className = ""
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  variableLookup: VariableLookup;
  disabled?: boolean;
  multiline?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const selectionRef = useRef<SelectionOffsets | null>(null);
  const isComposingRef = useRef(false);
  const [isFocused, setIsFocused] = useState(false);
  const [autocomplete, setAutocomplete] = useState<{
    match: VariableAutocompleteMatch;
    activeIndex: number;
  } | null>(null);
  const plainHtml = useMemo(() => escapeHtml(value), [value]);
  const tokenizedHtml = useMemo(() => renderTokenizedHtml(value, variableLookup), [value, variableLookup]);
  const suggestions = useMemo(
    () => (autocomplete ? getVariableSuggestions(variableLookup, autocomplete.match.query) : []),
    [autocomplete, variableLookup]
  );
  const activeSuggestionIndex = autocomplete ? clamp(autocomplete.activeIndex, 0, Math.max(suggestions.length - 1, 0)) : 0;

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }

    const isEditing = isFocused || document.activeElement === element;
    if (isEditing) {
      if (readEditableText(element, multiline) !== value || element.innerHTML !== plainHtml) {
        element.textContent = value;
      }
    } else if (element.innerHTML !== tokenizedHtml) {
      element.innerHTML = tokenizedHtml;
    }

    if (document.activeElement !== element || isComposingRef.current || !selectionRef.current) {
      return;
    }

    restoreSelection(element, selectionRef.current);
  }, [isFocused, multiline, plainHtml, tokenizedHtml, value]);

  function updateAutocomplete(nextValue: string, nextSelection: SelectionOffsets | null) {
    const match = nextSelection ? findVariableAutocompleteMatch(nextValue, nextSelection.start, nextSelection.end) : null;

    if (!match) {
      setAutocomplete(null);
      return;
    }

    const nextSuggestions = getVariableSuggestions(variableLookup, match.query);
    const maxIndex = Math.max(nextSuggestions.length - 1, 0);

    setAutocomplete((current) => ({
      match,
      activeIndex:
        current &&
        current.match.query === match.query &&
        current.match.replaceFrom === match.replaceFrom &&
        current.match.replaceTo === match.replaceTo
          ? clamp(current.activeIndex, 0, maxIndex)
          : 0
    }));
  }

  function refreshAutocompleteFromDom() {
    const element = ref.current;
    if (!element) {
      return;
    }

    updateAutocomplete(readEditableText(element, multiline), getSelectionOffsets(element));
  }

  function syncValue() {
    const element = ref.current;
    if (!element) {
      return;
    }

    const nextSelection = getSelectionOffsets(element);
    const nextValue = readEditableText(element, multiline);

    selectionRef.current = nextSelection;
    updateAutocomplete(nextValue, nextSelection);
    onChange(nextValue);
  }

  function selectSuggestion(index: number) {
    const element = ref.current;
    const suggestion = suggestions[index];
    if (!element || !suggestion) {
      return;
    }

    const nextValue = readEditableText(element, multiline);
    const nextSelection = getSelectionOffsets(element) ?? selectionRef.current;
    const match =
      nextSelection ? findVariableAutocompleteMatch(nextValue, nextSelection.start, nextSelection.end) : autocomplete?.match ?? null;

    if (!match) {
      setAutocomplete(null);
      return;
    }

    const result = applyVariableAutocomplete(nextValue, match, suggestion.key);
    selectionRef.current = { start: result.selection, end: result.selection };
    setAutocomplete(null);
    onChange(result.value);
    element.focus();
  }

  return (
    <div className="relative">
      {!value ? (
        <span
          className={`pointer-events-none absolute left-0 top-0 select-none text-sm text-slate-400 ${
            multiline ? "px-3 py-1.5 font-mono whitespace-pre-wrap" : "px-3 py-2 font-mono"
          }`}
        >
          {placeholder}
        </span>
      ) : null}
      <div
        ref={ref}
        className={[
          "w-full rounded border border-slate-300 bg-white font-mono text-sm text-slate-900 outline-none transition focus:border-teal-500 focus:ring-2 focus:ring-teal-100",
          multiline
            ? "min-h-64 max-h-[32rem] overflow-y-auto whitespace-pre-wrap break-words p-2 leading-6"
            : "min-h-[2.25rem] overflow-x-auto overflow-y-hidden whitespace-pre px-3 py-1.5 leading-5",
          disabled ? "cursor-not-allowed bg-slate-50 text-slate-400" : "",
          className
        ]
          .filter(Boolean)
          .join(" ")}
        contentEditable={!disabled}
        suppressContentEditableWarning
        role="textbox"
        aria-label={ariaLabel}
        aria-multiline={multiline}
        onInput={() => {
          if (!isComposingRef.current) {
            syncValue();
          }
        }}
        onBlur={() => {
          selectionRef.current = null;
          setAutocomplete(null);
          setIsFocused(false);
        }}
        onKeyDown={(event) => {
          if (autocomplete) {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setAutocomplete((current) =>
                current
                  ? {
                      ...current,
                      activeIndex: current.activeIndex + 1
                    }
                  : current
              );
              return;
            }

            if (event.key === "ArrowUp") {
              event.preventDefault();
              setAutocomplete((current) =>
                current
                  ? {
                      ...current,
                      activeIndex: Math.max(current.activeIndex - 1, 0)
                    }
                  : current
              );
              return;
            }

            if ((event.key === "Enter" || event.key === "Tab") && suggestions.length > 0) {
              event.preventDefault();
              selectSuggestion(activeSuggestionIndex);
              return;
            }

            if (event.key === "Escape") {
              event.preventDefault();
              setAutocomplete(null);
              return;
            }
          }

          if (!multiline && event.key === "Enter") {
            event.preventDefault();
          }
        }}
        onKeyUp={() => {
          if (!isComposingRef.current) {
            refreshAutocompleteFromDom();
          }
        }}
        onMouseUp={() => {
          refreshAutocompleteFromDom();
        }}
        onFocus={() => {
          const element = ref.current;
          const nextSelection = element ? getSelectionOffsets(element) : null;

          selectionRef.current = nextSelection;
          setIsFocused(true);
          if (element) {
            updateAutocomplete(readEditableText(element, multiline), nextSelection);
          }
        }}
        onCompositionStart={() => {
          isComposingRef.current = true;
        }}
        onCompositionEnd={() => {
          isComposingRef.current = false;
          syncValue();
        }}
      />
      {autocomplete ? (
        <div className="absolute left-0 right-0 top-full z-30 mt-1 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-lg">
          <div className="border-b border-slate-100 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            Variables disponibles
          </div>
          {suggestions.length > 0 ? (
            <div className="max-h-56 overflow-auto py-1">
              {suggestions.map((suggestion, index) => {
                const active = index === activeSuggestionIndex;

                return (
                  <button
                    key={suggestion.key}
                    className={`flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm ${
                      active ? "bg-teal-50 text-teal-900" : "text-slate-700 hover:bg-slate-50"
                    }`}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      selectSuggestion(index);
                    }}
                    type="button"
                  >
                    <span className="font-mono font-semibold">{suggestion.key}</span>
                    <span className="max-w-[14rem] truncate text-xs text-slate-500">
                      {suggestion.isSecret ? maskSecret(suggestion.value) : suggestion.value || "Sin valor"}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="px-3 py-1.5 text-sm text-slate-500">No hay variables que coincidan.</div>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function PostreApp() {
  const [data, setData] = useState<AppData | null>(null);
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null);
  const [selectedCollectionId, setSelectedCollectionId] = useState<string | null>(null);
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<string | null>(null);
  const [expandedCollections, setExpandedCollections] = useState<Record<string, boolean>>({});
  const [expandedFolders, setExpandedFolders] = useState<Record<string, boolean>>(readExpandedFolders);
  const [collectionsPanelWidth, setCollectionsPanelWidth] = useState<number | null>(300);
  const [collectionsPanelHeight, setCollectionsPanelHeight] = useState<number | null>(360);
  const [theme, setTheme] = useState<Theme>("light");
  const [themeReady, setThemeReady] = useState(false);
  const [requestTabs, setRequestTabs] = useState<OpenRequestTab[]>([]);
  const [activeRequestTabId, setActiveRequestTabId] = useState<string | null>(null);
  const [requestTabMenu, setRequestTabMenu] = useState<RequestTabContextMenuState | null>(null);
  const [requestTreeMenu, setRequestTreeMenu] = useState<RequestTreeContextMenuState | null>(null);
  const [renamingRequestId, setRenamingRequestId] = useState<string | null>(null);
  const [responsePanelHeight, setResponsePanelHeight] = useState<number | null>(null);
  const [_appBusy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [mainPanelMode, setMainPanelMode] = useState<MainPanelMode>("request");
  const [showCollectionsPanel, setShowCollectionsPanel] = useState(true);
  const [showEnvironmentsPanel, setShowEnvironmentsPanel] = useState(false);
  const [showSidebar, setShowSidebar] = useState(true);
  const [showResponsePanel, setShowResponsePanel] = useState(true);
  const [renamingEnvironmentId, setRenamingEnvironmentId] = useState<string | null>(null);
  const [environmentMenu, setEnvironmentMenu] = useState<EnvironmentMenuState | null>(null);
  const [showAppMenu, setShowAppMenu] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showCookies, setShowCookies] = useState(false);
  const [runnerTarget, setRunnerTarget] = useState<CollectionRunnerTarget | null>(null);
  const [runnerReport, setRunnerReport] = useState<ApiCollectionRunReport | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<{
    message: string;
    onConfirm: () => void;
  } | null>(null);
  const [promptDialog, setPromptDialog] = useState<{
    message: string;
    defaultValue: string;
    onConfirm: (value: string) => void;
  } | null>(null);
  const [draggedRequestId, setDraggedRequestId] = useState<string | null>(null);
  const [dropTargetCollectionId, setDropTargetCollectionId] = useState<string | null>(null);
  const [dropTargetFolderId, setDropTargetFolderId] = useState<string | null>(null);
  const collectionsSplitRef = useRef<HTMLDivElement | null>(null);
  const sidebarSplitRef = useRef<HTMLDivElement | null>(null);
  const didInitializeEnvironmentSelectionRef = useRef(false);
  const responseSplitRef = useRef<HTMLDivElement | null>(null);
  const requestTabsRef = useRef<OpenRequestTab[]>(requestTabs);
  const activeRequestTabIdRef = useRef<string | null>(activeRequestTabId);
  const activeRequestControllerRef = useRef<AbortController | null>(null);
  const didInitializeRequestTabsRef = useRef(false);
  requestTabsRef.current = requestTabs;
  activeRequestTabIdRef.current = activeRequestTabId;

  const refresh = useCallback(async (options: { reconcileTabs?: boolean } = {}) => {
    const reconcileTabs = options.reconcileTabs ?? true;
    const nextData = await api<AppData>("/api/data");
    setData(nextData);

    setSelectedCollectionId((current) => current ?? nextData.collections[0]?.id ?? null);

    if (!didInitializeRequestTabsRef.current) {
      didInitializeRequestTabsRef.current = true;
      const restored = restoreRequestTabs(nextData.collections);
      setRequestTabs(restored.tabs);
      setActiveRequestTabId(restored.activeTabId);
      return nextData;
    }

    if (reconcileTabs) {
      const currentTabs = requestTabsRef.current;
      const reconciledTabs = reconcileRequestTabsWithData(currentTabs, nextData.collections);
      const currentActiveId = activeRequestTabIdRef.current;
      const nextActiveId = reconciledTabs.some((tab) => tab.tabId === currentActiveId)
        ? currentActiveId
        : reconciledTabs[0]?.tabId ?? null;

      setRequestTabs(reconciledTabs);
      setActiveRequestTabId(nextActiveId);
    }

    return nextData;
  }, []);

  const handleExport = useCallback(async () => {
    try {
      const result = await api<{ collections: unknown[]; environments: unknown[] }>("/api/export");
      const blob = new Blob([JSON.stringify(result, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "postre-export.json";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Export failed");
    }
    setShowAppMenu(false);
  }, []);

  const openCookies = useCallback(() => {
    setShowCookies(true);
    setShowAppMenu(false);
  }, []);

  const appMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!showAppMenu) return;
    const handler = (event: MouseEvent) => {
      if (appMenuRef.current && !appMenuRef.current.contains(event.target as Node)) {
        setShowAppMenu(false);
      }
    };
    document.addEventListener("mousedown", handler, true);
    return () => document.removeEventListener("mousedown", handler, true);
  }, [showAppMenu]);

  useEffect(() => {
    const dirtyTabs = requestTabs.filter((tab) => tab.dirty && !tab.saving && !tab.busy);
    if (dirtyTabs.length === 0) {
      return;
    }

    const timer = window.setTimeout(() => {
      for (const tab of dirtyTabs) {
        void saveRequestTab(tab.tabId, false);
      }
    }, 800);

    return () => window.clearTimeout(timer);
  }, [requestTabs]);

  useEffect(() => {
    if (!didInitializeRequestTabsRef.current) {
      return;
    }

    const stored: StoredRequestTabs = {
      tabs: requestTabs.map((tab) => ({ tabId: tab.tabId, requestId: tab.requestId })),
      activeTabId: activeRequestTabId
    };

    try {
      window.localStorage.setItem(REQUEST_TABS_STORAGE_KEY, JSON.stringify(stored));
    } catch {
      // Ignore storage failures. The tabs still work for the current session.
    }
  }, [activeRequestTabId, requestTabs]);

  useEffect(() => {
    try {
      window.localStorage.setItem(EXPANDED_FOLDERS_STORAGE_KEY, JSON.stringify(expandedFolders));
    } catch {
      // Ignore storage failures.
    }
  }, [expandedFolders]);

  const activeRequestTab = useMemo(
    () => requestTabs.find((tab) => tab.tabId === activeRequestTabId) ?? null,
    [activeRequestTabId, requestTabs]
  );
  const draft = activeRequestTab?.draft ?? null;
  const response = activeRequestTab?.response ?? null;
  const busy = activeRequestTab?.busy ?? false;

  useEffect(() => {
    if (!activeRequestTab) {
      setSelectedRequestId(null);
      return;
    }

    setSelectedRequestId(activeRequestTab.requestId);
    setSelectedCollectionId(activeRequestTab.draft.collectionId ?? null);
    setSelectedFolderId(activeRequestTab.draft.folderId ?? null);
  }, [
    activeRequestTab?.draft.collectionId,
    activeRequestTab?.draft.folderId,
    activeRequestTab?.requestId,
    activeRequestTab?.tabId
  ]);

  useEffect(() => {
    if (!requestTabMenu) {
      return;
    }

    function closeMenu() {
      setRequestTabMenu(null);
    }

    window.addEventListener("click", closeMenu);
    window.addEventListener("contextmenu", closeMenu);
    window.addEventListener("resize", closeMenu);
    return () => {
      window.removeEventListener("click", closeMenu);
      window.removeEventListener("contextmenu", closeMenu);
      window.removeEventListener("resize", closeMenu);
    };
  }, [requestTabMenu]);

  useEffect(() => {
    if (!requestTreeMenu) {
      return;
    }

    function closeMenu() {
      setRequestTreeMenu(null);
    }

    window.addEventListener("click", closeMenu);
    window.addEventListener("contextmenu", closeMenu);
    window.addEventListener("resize", closeMenu);
    return () => {
      window.removeEventListener("click", closeMenu);
      window.removeEventListener("contextmenu", closeMenu);
      window.removeEventListener("resize", closeMenu);
    };
  }, [requestTreeMenu]);

  useEffect(() => {
    if (!data) {
      setSelectedEnvironmentId(null);
      didInitializeEnvironmentSelectionRef.current = false;
      return;
    }

    if (!didInitializeEnvironmentSelectionRef.current) {
      didInitializeEnvironmentSelectionRef.current = true;
      setSelectedEnvironmentId(data.activeEnvironmentId ?? data.environments[0]?.id ?? null);
      return;
    }

    if (selectedEnvironmentId && data.environments.some((environment) => environment.id === selectedEnvironmentId)) {
      return;
    }
  }, [data, selectedEnvironmentId]);

  function setCollectionExpanded(collectionId: string, expanded: boolean) {
    setExpandedCollections((current) => ({
      ...current,
      [collectionId]: expanded
    }));
  }

  function setFolderExpanded(folderId: string, expanded: boolean) {
    setExpandedFolders((current) => ({
      ...current,
      [folderId]: expanded
    }));
  }

  function focusRequestView() {
    setMainPanelMode("request");
    setShowCollectionsPanel(true);
  }

  function focusEnvironmentView(environmentId: string | null) {
    setSelectedEnvironmentId(environmentId);
    setMainPanelMode("environment");
    setShowEnvironmentsPanel(true);
  }

  function updateRequestTab(tabId: string, updater: (tab: OpenRequestTab) => OpenRequestTab) {
    setRequestTabs((current) => current.map((tab) => (tab.tabId === tabId ? updater(tab) : tab)));
  }

  function updateActiveDraft(nextDraft: RequestDraft) {
    const tabId = activeRequestTabIdRef.current;
    if (!tabId) {
      return;
    }

    updateRequestTab(tabId, (tab) => ({
      ...tab,
      draft: cloneDraftDraft(nextDraft),
      dirty: true
    }));
  }

  function openRequestInTab(request: ApiRequest) {
    focusRequestView();
    const existing = requestTabsRef.current.find((tab) => tab.requestId === request.id);
    if (existing) {
      setActiveRequestTabId(existing.tabId);
      return;
    }

    const tab = createOpenRequestTab(request);
    setRequestTabs((current) => [...current, tab]);
    setActiveRequestTabId(tab.tabId);
  }

  function duplicateRequestTab(tabId: string) {
    const currentTabs = requestTabsRef.current;
    const tabIndex = currentTabs.findIndex((tab) => tab.tabId === tabId);
    const tab = currentTabs[tabIndex];
    if (!tab) {
      return;
    }

    const duplicate: OpenRequestTab = {
      ...tab,
      tabId: createRequestTabId(),
      draft: cloneDraftDraft(tab.draft),
      response: cloneSendResponse(tab.response),
      busy: false,
      saving: false
    };

    setRequestTabs((current) => {
      const next = [...current];
      const insertAt = current.findIndex((item) => item.tabId === tabId);
      next.splice(insertAt >= 0 ? insertAt + 1 : next.length, 0, duplicate);
      return next;
    });
    setActiveRequestTabId(duplicate.tabId);
    setRequestTabMenu(null);
  }

  async function saveRequestTab(tabId: string, showMessage = true): Promise<RequestDraft | null> {
    const tab = requestTabsRef.current.find((item) => item.tabId === tabId);
    if (!tab?.draft.id) {
      return null;
    }

    if (!tab.dirty && !tab.saving) {
      return tab.draft;
    }

    const savedDraftFingerprint = fingerprintDraft(tab.draft);
    updateRequestTab(tabId, (current) => ({ ...current, saving: true }));

    try {
      const saved = await api<ApiRequest>(`/api/requests/${tab.requestId}`, {
        method: "PATCH",
        body: JSON.stringify(tab.draft)
      });
      const nextDraft = cloneDraft(saved);

      setRequestTabs((current) =>
        current.map((item) => {
          if (item.tabId !== tabId) {
            return item;
          }

          const unchangedSinceSaveStarted = fingerprintDraft(item.draft) === savedDraftFingerprint;
          return {
            ...item,
            requestId: saved.id,
            draft: unchangedSinceSaveStarted ? nextDraft : item.draft,
            dirty: unchangedSinceSaveStarted ? false : item.dirty,
            saving: false
          };
        })
      );

      if (showMessage) {
        setNotice("Request saved.");
      }

      await refresh({ reconcileTabs: false });
      return nextDraft;
    } catch (error) {
      updateRequestTab(tabId, (current) => ({ ...current, saving: false }));
      throw error;
    }
  }

  async function closeRequestTabs(tabIds: string[], force: boolean) {
    const closingIds = new Set(tabIds);
    setRequestTabMenu(null);

    if (!force) {
      for (const tabId of tabIds) {
        await saveRequestTab(tabId, false);
      }
    }

    const currentTabs = requestTabsRef.current;
    const firstClosedIndex = Math.min(
      ...tabIds
        .map((tabId) => currentTabs.findIndex((tab) => tab.tabId === tabId))
        .filter((index) => index >= 0)
    );
    const remainingTabs = currentTabs.filter((tab) => !closingIds.has(tab.tabId));
    const activeId = activeRequestTabIdRef.current;
    const nextActiveId = remainingTabs.some((tab) => tab.tabId === activeId)
      ? activeId
      : remainingTabs[firstClosedIndex]?.tabId ?? remainingTabs[firstClosedIndex - 1]?.tabId ?? remainingTabs[0]?.tabId ?? null;

    setRequestTabs(remainingTabs);
    setActiveRequestTabId(nextActiveId);
  }

  async function closeOtherRequestTabs(tabId: string, force: boolean) {
    const closingIds = requestTabsRef.current.filter((tab) => tab.tabId !== tabId).map((tab) => tab.tabId);
    await closeRequestTabs(closingIds, force);
    setActiveRequestTabId(tabId);
  }

  async function closeAllRequestTabs(force: boolean) {
    await closeRequestTabs(requestTabsRef.current.map((tab) => tab.tabId), force);
  }

  function handleRequestTabContextMenu(event: React.MouseEvent<HTMLElement>, tabId: string) {
    event.preventDefault();
    event.stopPropagation();
    setActiveRequestTabId(tabId);
    setRequestTabMenu({ tabId, x: event.clientX, y: event.clientY });
  }

  function handleRequestTreeContextMenu(event: React.MouseEvent, requestId: string) {
    event.preventDefault();
    event.stopPropagation();
    setRenamingRequestId(null);
    setRequestTreeMenu({ requestId, x: event.clientX, y: event.clientY });
  }

  function expandFolderPath(folderId: string) {
    if (!data) {
      return;
    }

    const path = findFolderPath(data.collections, folderId);
    if (!path) {
      return;
    }

    setCollectionExpanded(path.collectionId, true);
    setExpandedFolders((current) => {
      const next = { ...current };
      for (const id of path.folderIds) {
        next[id] = true;
      }
      return next;
    });
  }

  function clearRequestDragState() {
    setDraggedRequestId(null);
    setDropTargetCollectionId(null);
    setDropTargetFolderId(null);
  }

  async function moveRequestToTreeTarget(target: RequestTreeDropTarget) {
    if (!data) {
      return;
    }

    const request = findRequest(data.collections, target.requestId);
    const collection = data.collections.find((item) => item.id === target.collectionId);
    const folder = target.folderId ? findFolder(data.collections, target.folderId) : null;
    if (
      !request ||
      !collection ||
      (target.folderId && !folder) ||
      (request.collectionId === target.collectionId && (request.folderId ?? null) === target.folderId)
    ) {
      return;
    }

    const movedRequest = await api<ApiRequest>(`/api/requests/${request.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        ...cloneDraft(request),
        collectionId: collection.id,
        folderId: target.folderId
      })
    });

    setSelectedRequestId(movedRequest.id);
    setSelectedCollectionId(collection.id);
    setSelectedFolderId(target.folderId);
    setCollectionExpanded(collection.id, true);
    if (target.folderId) {
      expandFolderPath(target.folderId);
    }
    setRequestTabs((current) =>
      current.map((tab) => {
        if (tab.requestId !== movedRequest.id) {
          return tab;
        }

        return {
          ...tab,
          draft: tab.dirty
            ? {
                ...tab.draft,
                collectionId: movedRequest.collectionId,
                folderId: movedRequest.folderId
              }
            : cloneDraft(movedRequest)
        };
      })
    );
    setNotice(`Request moved to "${folder?.name ?? collection.name}".`);
    await refresh();
  }

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const nextTheme = readPreferredTheme();
    setTheme(nextTheme);
    setThemeReady(true);
  }, []);

  useEffect(() => {
    if (!themeReady) {
      return;
    }

    applyTheme(theme);

    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // Ignore storage failures so theme switching still works.
    }
  }, [theme, themeReady]);

  useEffect(() => {
    if (!draft || responsePanelHeight !== null) {
      return;
    }

    const container = responseSplitRef.current;
    if (!container) {
      return;
    }

    const rect = container.getBoundingClientRect();
    const maxHeight = Math.max(
      RESPONSE_PANEL_MIN_HEIGHT,
      rect.height - REQUEST_EDITOR_MIN_HEIGHT - RESPONSE_HANDLE_HEIGHT
    );
    const initialHeight = Math.round((rect.height - RESPONSE_HANDLE_HEIGHT) / 2);
    setResponsePanelHeight(clamp(initialHeight, RESPONSE_PANEL_MIN_HEIGHT, maxHeight));
  }, [draft, responsePanelHeight]);

  useEffect(() => {
    function handleResize() {
      const container = responseSplitRef.current;
      if (!container) {
        return;
      }

      setResponsePanelHeight((current) => {
        if (current === null) {
          return current;
        }

        const rect = container.getBoundingClientRect();
        const maxHeight = Math.max(
          RESPONSE_PANEL_MIN_HEIGHT,
          rect.height - REQUEST_EDITOR_MIN_HEIGHT - RESPONSE_HANDLE_HEIGHT
        );
        return clamp(current, RESPONSE_PANEL_MIN_HEIGHT, maxHeight);
      });
    }

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  useEffect(() => {
    function handleResize() {
      const container = collectionsSplitRef.current;
      if (!container) {
        return;
      }

      setCollectionsPanelWidth((current) => {
        if (current === null) {
          return current;
        }

        const rect = container.getBoundingClientRect();
        const maxWidth = Math.min(
          COLLECTIONS_PANEL_MAX_WIDTH,
          rect.width - COLLECTIONS_PANEL_MIN_WIDTH - COLLECTIONS_HANDLE_WIDTH
        );
        return clamp(current, COLLECTIONS_PANEL_MIN_WIDTH, Math.max(COLLECTIONS_PANEL_MIN_WIDTH, maxWidth));
      });
    }

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  useEffect(() => {
    function handleResize() {
      const container = sidebarSplitRef.current;
      if (!container) {
        return;
      }

      setCollectionsPanelHeight((current) => {
        if (current === null) {
          return current;
        }

        const rect = container.getBoundingClientRect();
        const maxHeight = Math.max(
          SIDEBAR_PANEL_MIN_HEIGHT,
          rect.height - SIDEBAR_PANEL_MIN_HEIGHT - SIDEBAR_HANDLE_HEIGHT
        );
        return clamp(current, SIDEBAR_PANEL_MIN_HEIGHT, maxHeight);
      });
    }

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const activeEnvironmentId = data?.activeEnvironmentId ?? null;
  async function createCollection() {
    setPromptDialog({
      message: "Collection name",
      defaultValue: "New Collection",
      onConfirm: (name) => {
        setPromptDialog(null);
        setBusy(true);
        void (async () => {
          try {
            const result = await api<{ id: string }>("/api/collections", {
              method: "POST",
              body: JSON.stringify({ name })
            });
            focusRequestView();
            setSelectedCollectionId(result.id);
            setSelectedFolderId(null);
            setCollectionExpanded(result.id, true);
            setNotice("Collection created.");
            await refresh();
          } finally {
            setBusy(false);
          }
        })();
      }
    });
  }

  async function createEnvironment() {
    setBusy(true);
    try {
      const result = await api<{ id: string }>("/api/environments", {
        method: "POST",
        body: JSON.stringify({ name: "New Environment" })
      });
      setNotice("Environment created.");
      await refresh();
      focusEnvironmentView(result.id);
      setRenamingEnvironmentId(result.id);
    } finally {
      setBusy(false);
    }
  }

  function handleDeleteEnvironment(environmentId: string) {
    const env = data?.environments.find((e) => e.id === environmentId);
    if (!env) {
      return;
    }

    const remaining = data!.environments.filter((e) => e.id !== environmentId);
    const next = remaining.find((e) => e.active) ?? remaining[0] ?? null;

    setConfirmDialog({
      message: `Delete environment "${env.name}"?`,
      onConfirm: () => {
        setConfirmDialog(null);
        void (async () => {
          await api(`/api/environments/${environmentId}`, { method: "DELETE" });
          if (next) {
            selectEnvironment(next.id);
          } else {
            setSelectedEnvironmentId(null);
            setMainPanelMode("request");
            setShowEnvironmentsPanel(false);
          }
          await refresh();
        })();
      }
    });
  }

  async function renameCollection(collection: ApiCollection) {
    setPromptDialog({
      message: "Collection name",
      defaultValue: collection.name,
      onConfirm: (name) => {
        setPromptDialog(null);
        void (async () => {
          await api(`/api/collections/${collection.id}`, {
            method: "PATCH",
            body: JSON.stringify({ name })
          });
          await refresh();
        })();
      }
    });
  }

  async function deleteCollection(collection: ApiCollection) {
    setConfirmDialog({
      message: `Delete collection "${collection.name}"?`,
      onConfirm: () => {
        setConfirmDialog(null);
        void (async () => {
          await api(`/api/collections/${collection.id}`, { method: "DELETE" });
          setSelectedRequestId(null);
          await refresh();
        })();
      }
    });
  }

  async function createFolder() {
    const collectionId = selectedCollectionId ?? data?.collections[0]?.id;
    if (!collectionId) {
      setNotice("Create a collection first.");
      return;
    }

    const cId = collectionId;
    setPromptDialog({
      message: "Folder name",
      defaultValue: "New Folder",
      onConfirm: (name) => {
        setPromptDialog(null);
        void (async () => {
          const result = await api<{ id: string }>("/api/folders", {
            method: "POST",
            body: JSON.stringify({ name, collectionId: cId, parentId: selectedFolderId })
          });
          focusRequestView();
          setSelectedFolderId(result.id);
          setCollectionExpanded(cId, true);
          if (selectedFolderId) {
            setFolderExpanded(selectedFolderId, true);
          }
          await refresh();
        })();
      }
    });
  }

  async function renameFolder(folder: ApiFolder) {
    setPromptDialog({
      message: "Folder name",
      defaultValue: folder.name,
      onConfirm: (name) => {
        setPromptDialog(null);
        void (async () => {
          await api(`/api/folders/${folder.id}`, {
            method: "PATCH",
            body: JSON.stringify({ name })
          });
          await refresh();
        })();
      }
    });
  }

  async function saveCollectionScripts(collectionId: string, preRequestScript: string, postRequestScript: string) {
    await api(`/api/collections/${collectionId}`, {
      method: "PATCH",
      body: JSON.stringify({ preRequestScript, postRequestScript })
    });
    setNotice("Collection scripts saved.");
    await refresh();
  }

  async function saveFolderScripts(folderId: string, preRequestScript: string, postRequestScript: string) {
    await api(`/api/folders/${folderId}`, {
      method: "PATCH",
      body: JSON.stringify({ preRequestScript, postRequestScript })
    });
    setNotice("Folder scripts saved.");
    await refresh();
  }

  async function renameRequest(requestId: string, newName: string) {
    const req = data && findRequest(data.collections, requestId);
    if (!req) {
      return;
    }
    await api(`/api/requests/${requestId}`, {
      method: "PATCH",
      body: JSON.stringify({ ...req, name: newName })
    });
    setRenamingRequestId(null);
    await refresh();
  }

  async function renameEnvironment(environmentId: string, newName: string) {
    const trimmed = newName.trim();
    if (!trimmed) {
      setRenamingEnvironmentId(null);
      return;
    }
    await api(`/api/environments/${environmentId}`, {
      method: "PATCH",
      body: JSON.stringify({ name: trimmed })
    });
    setRenamingEnvironmentId(null);
    await refresh();
  }

  function handleEnvironmentContextMenu(event: React.MouseEvent, environmentId: string) {
    event.preventDefault();
    event.stopPropagation();
    setRenamingEnvironmentId(null);
    setEnvironmentMenu({ environmentId, x: event.clientX, y: event.clientY });
  }

  async function duplicateRequest(request: ApiRequest) {
    const newRequest = await api<ApiRequest>("/api/requests", {
      method: "POST",
      body: JSON.stringify({
        collectionId: request.collectionId,
        folderId: request.folderId,
        name: `${request.name} (copy)`,
        method: request.method,
        url: request.url,
        headers: request.headers,
        queryParams: request.queryParams,
        bodyMode: request.bodyMode,
        bodyRaw: request.bodyRaw,
        preRequestScript: request.preRequestScript,
        postRequestScript: request.postRequestScript,
        auth: request.auth
      })
    });

    focusRequestView();
    const tab = createOpenRequestTab(newRequest);
    setRequestTabs((current) => [...current, tab]);
    setActiveRequestTabId(tab.tabId);
    setCollectionExpanded(newRequest.collectionId, true);
    if (newRequest.folderId) {
      setFolderExpanded(newRequest.folderId, true);
    }
    setRequestTreeMenu(null);
    await refresh({ reconcileTabs: false });
  }

  function copyRequestAsCurl(request: ApiRequest) {
    const curl = requestDraftToCurl(request);
    navigator.clipboard.writeText(curl).catch(() => {});
    setRequestTreeMenu(null);
    setNotice("Request copied as cURL.");
  }

  async function deleteFolder(folder: ApiFolder) {
    setConfirmDialog({
      message: `Delete folder "${folder.name}" and its nested content?`,
      onConfirm: () => {
        setConfirmDialog(null);
        void (async () => {
          await api(`/api/folders/${folder.id}`, { method: "DELETE" });
          setSelectedFolderId(null);
          await refresh();
        })();
      }
    });
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
        preRequestScript: "",
        postRequestScript: "",
        auth: EMPTY_AUTH
      })
    });

    focusRequestView();
    const tab = createOpenRequestTab(request);
    setRequestTabs((current) => [...current, tab]);
    setActiveRequestTabId(tab.tabId);
    setCollectionExpanded(collectionId, true);
    if (selectedFolderId) {
      setFolderExpanded(selectedFolderId, true);
    }
    await refresh({ reconcileTabs: false });
  }

  async function saveDraft(showMessage = true): Promise<RequestDraft | null> {
    const tabId = activeRequestTabIdRef.current;
    if (!tabId) {
      return null;
    }

    return saveRequestTab(tabId, showMessage);
  }

  async function deleteRequest() {
    const tab = activeRequestTab;
    if (!tab?.draft.id) {
      return;
    }

    setConfirmDialog({
      message: `Delete request "${tab.draft.name}"?`,
      onConfirm: () => {
        setConfirmDialog(null);
        void (async () => {
          await api(`/api/requests/${tab.requestId}`, { method: "DELETE" });
          const remainingTabs = requestTabsRef.current.filter((item) => item.requestId !== tab.requestId);
          setRequestTabs(remainingTabs);
          setActiveRequestTabId(remainingTabs[0]?.tabId ?? null);
          await refresh();
        })();
      }
    });
  }

  async function sendRequest() {
    const tabId = activeRequestTabIdRef.current;
    const tab = requestTabsRef.current.find((item) => item.tabId === tabId);
    if (!tab) {
      return;
    }

    let sendUrl = tab.draft.url.trim();
    if (sendUrl && !sendUrl.startsWith("http://") && !sendUrl.startsWith("https://") && !sendUrl.includes("{{")) {
      sendUrl = `https://${sendUrl}`;
      updateRequestTab(tab.tabId, (current) => ({
        ...current,
        draft: { ...current.draft, url: sendUrl }
      }));
    }

    const controller = new AbortController();
    activeRequestControllerRef.current = controller;

    updateRequestTab(tab.tabId, (current) => ({ ...current, busy: true, response: null }));
    try {
      const savedDraft = await saveRequestTab(tab.tabId, false);
      const sendDraft = savedDraft ?? tab.draft;
      const result = await api<SendResponseState>("/api/send", {
        method: "POST",
        body: JSON.stringify({
          draft: { ...sendDraft, url: sendUrl || sendDraft.url },
          activeEnvironmentId
        }),
        allowError: true,
        signal: controller.signal
      });
      updateRequestTab(tab.tabId, (current) => ({ ...current, response: result }));
      await refresh({ reconcileTabs: false });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        updateRequestTab(tab.tabId, (current) => ({
          ...current,
          response: { error: "Request cancelled" }
        }));
      } else {
        const errorMessage = error instanceof Error ? error.message : "Request failed";
        const friendlyMessage = categorizeError(errorMessage);
        updateRequestTab(tab.tabId, (current) => ({
          ...current,
          response: { error: friendlyMessage }
        }));
      }
    } finally {
      updateRequestTab(tab.tabId, (current) => ({ ...current, busy: false }));
      activeRequestControllerRef.current = null;
    }
  }

  function cancelRequest() {
    activeRequestControllerRef.current?.abort();
  }

  async function sendAndDownloadRequest() {
    await sendRequest();
    const tab = requestTabsRef.current.find((t) => t.tabId === activeRequestTabIdRef.current);
    const result = tab?.response;
    if (!result || "error" in result || !result.body) return;

    try {
      let blob: Blob;
      if (result.bodyBase64) {
        const binary = atob(result.bodyBase64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        blob = new Blob([bytes], { type: result.contentType || "application/octet-stream" });
      } else {
        blob = new Blob([result.body], { type: result.contentType || "text/plain" });
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const ext = result.contentType.includes("pdf") ? "pdf" : result.contentType.includes("json") ? "json" : result.contentType.includes("xml") ? "xml" : result.contentType.includes("html") ? "html" : "bin";
      a.download = `response.${ext}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {
      // ignore
    }
  }

  async function saveDraftIfInsideTarget(target: CollectionRunnerTarget) {
    if (!draft?.id || !data) {
      return;
    }

    const request = findRequest(data.collections, draft.id);
    if (!request) {
      return;
    }

    if (target.type === "collection") {
      if (request.collectionId !== target.id) {
        return;
      }
    } else if (
      request.folderId !== target.id &&
      !isFolderDescendant(data.collections, request.folderId, target.id)
    ) {
      return;
    }

    await saveDraft(false);
  }

  function selectRequest(request: ApiRequest) {
    setCollectionExpanded(request.collectionId, true);
    if (request.folderId) {
      expandFolderPath(request.folderId);
    }
    openRequestInTab(request);
  }

  function selectEnvironment(environmentId: string | null) {
    focusEnvironmentView(environmentId);
  }

  function beginResponseResize(event: React.PointerEvent<HTMLButtonElement>) {
    const container = responseSplitRef.current;
    if (!container) {
      return;
    }

    event.preventDefault();
    const rect = container.getBoundingClientRect();
    const minHeight = RESPONSE_PANEL_MIN_HEIGHT;
    const maxHeight = Math.max(
      minHeight,
      rect.height - REQUEST_EDITOR_MIN_HEIGHT - RESPONSE_HANDLE_HEIGHT
    );
    const previousUserSelect = document.body.style.userSelect;
    const previousCursor = document.body.style.cursor;

    const updateHeight = (clientY: number) => {
      const nextHeight = clamp(Math.round(rect.bottom - clientY), minHeight, maxHeight);
      setResponsePanelHeight(nextHeight);
    };

    const cleanup = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", cleanup);
      window.removeEventListener("pointercancel", cleanup);
      document.body.style.userSelect = previousUserSelect;
      document.body.style.cursor = previousCursor;
    };

    const handlePointerMove = (moveEvent: PointerEvent) => {
      updateHeight(moveEvent.clientY);
    };

    document.body.style.userSelect = "none";
    document.body.style.cursor = "row-resize";
    updateHeight(event.clientY);
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", cleanup, { once: true });
    window.addEventListener("pointercancel", cleanup, { once: true });
  }

  function beginCollectionsResize(event: React.PointerEvent<HTMLButtonElement>) {
    const container = collectionsSplitRef.current;
    if (!container) {
      return;
    }

    event.preventDefault();
    const rect = container.getBoundingClientRect();
    const minWidth = COLLECTIONS_PANEL_MIN_WIDTH;
    const maxWidth = Math.min(
      COLLECTIONS_PANEL_MAX_WIDTH,
      rect.width - COLLECTIONS_PANEL_MIN_WIDTH - COLLECTIONS_HANDLE_WIDTH
    );
    const previousUserSelect = document.body.style.userSelect;
    const previousCursor = document.body.style.cursor;

    const updateWidth = (clientX: number) => {
      const nextWidth = clamp(Math.round(clientX - rect.left), minWidth, Math.max(minWidth, maxWidth));
      setCollectionsPanelWidth(nextWidth);
    };

    const cleanup = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", cleanup);
      window.removeEventListener("pointercancel", cleanup);
      document.body.style.userSelect = previousUserSelect;
      document.body.style.cursor = previousCursor;
    };

    const handlePointerMove = (moveEvent: PointerEvent) => {
      updateWidth(moveEvent.clientX);
    };

    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    updateWidth(event.clientX);
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", cleanup, { once: true });
    window.addEventListener("pointercancel", cleanup, { once: true });
  }

  function beginSidebarResize(event: React.PointerEvent<HTMLButtonElement>) {
    const container = sidebarSplitRef.current;
    if (!container) {
      return;
    }

    event.preventDefault();
    const rect = container.getBoundingClientRect();
    const minHeight = SIDEBAR_PANEL_MIN_HEIGHT;
    const maxHeight = Math.max(minHeight, rect.height - SIDEBAR_PANEL_MIN_HEIGHT - SIDEBAR_HANDLE_HEIGHT);
    const previousUserSelect = document.body.style.userSelect;
    const previousCursor = document.body.style.cursor;

    const updateHeight = (clientY: number) => {
      const nextHeight = clamp(Math.round(clientY - rect.top), minHeight, maxHeight);
      setCollectionsPanelHeight(nextHeight);
    };

    const cleanup = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", cleanup);
      window.removeEventListener("pointercancel", cleanup);
      document.body.style.userSelect = previousUserSelect;
      document.body.style.cursor = previousCursor;
    };

    const handlePointerMove = (moveEvent: PointerEvent) => {
      updateHeight(moveEvent.clientY);
    };

    document.body.style.userSelect = "none";
    document.body.style.cursor = "row-resize";
    updateHeight(event.clientY);
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", cleanup, { once: true });
    window.addEventListener("pointercancel", cleanup, { once: true });
  }

  const responseBody = useMemo(() => formatResponseBody(response), [response]);
  const selectedSidebarCollection = useMemo(
    () =>
      selectedCollectionId && data
        ? data.collections.find((collection) => collection.id === selectedCollectionId) ?? null
        : null,
    [data, selectedCollectionId]
  );
  const selectedSidebarFolder = useMemo(
    () => (selectedFolderId && data ? findFolder(data.collections, selectedFolderId) : null),
    [data, selectedFolderId]
  );
  const selectedCollection = useMemo(
    () =>
      draft?.collectionId && data
        ? data.collections.find((collection) => collection.id === draft.collectionId) ?? null
        : null,
    [data, draft?.collectionId]
  );
  const selectedRequest = useMemo(
    () => (draft?.id && data ? findRequest(data.collections, draft.id) : null),
    [data, draft?.id]
  );
  const activeEnvironment = useMemo(
    () =>
      activeEnvironmentId && data
        ? data.environments.find((environment) => environment.id === activeEnvironmentId) ?? null
        : null,
    [activeEnvironmentId, data]
  );
  const variableLookup = useMemo(
    () =>
      buildVariableLookup({
        global: data?.globalVariables ?? [],
        environment: activeEnvironment?.variables ?? [],
        collection: selectedCollection?.variables ?? [],
        request: selectedRequest?.variables ?? []
      }),
    [activeEnvironment?.variables, data?.globalVariables, selectedCollection?.variables, selectedRequest?.variables]
  );
  const isDarkTheme = theme === "dark";

  return (
    <main className="flex h-screen min-h-[720px] flex-col bg-[var(--background)] text-[var(--foreground)]">
      <header className="flex h-10 shrink-0 items-center justify-between border-b border-slate-200 bg-white px-3">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded bg-amber-500 text-white">
            <CakeIcon size={17} />
          </div>
          <div>
            <h1 className="text-base font-semibold leading-5">PostRE</h1>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <IconButton
            label={showSidebar ? "Hide sidebar" : "Show sidebar"}
            onClick={() => setShowSidebar((c) => !c)}
          >
            {showSidebar ? <PanelLeftClose size={17} /> : <PanelLeftOpen size={17} />}
          </IconButton>
          <IconButton
            label={showResponsePanel ? "Hide response" : "Show response"}
            onClick={() => setShowResponsePanel((c) => !c)}
          >
            {showResponsePanel ? <PanelBottomClose size={17} /> : <PanelBottomOpen size={17} />}
          </IconButton>
          <button
            type="button"
className="inline-flex h-8 w-8 items-center justify-center rounded border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
            onClick={() => setTheme(isDarkTheme ? "light" : "dark")}
            aria-label={isDarkTheme ? "Switch to light theme" : "Switch to dark theme"}
            aria-pressed={isDarkTheme}
            title={isDarkTheme ? "Switch to light theme" : "Switch to dark theme"}
          >
            {isDarkTheme ? <Sun size={16} /> : <Moon size={16} />}
          </button>
          <IconButton label="Manage cookies" onClick={openCookies}>
            <Cookie size={17} />
          </IconButton>
          <select
            className="h-8 min-w-44 rounded border border-slate-300 bg-white px-3 text-sm"
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
          <div ref={appMenuRef} className="relative">
            <IconButton
              label="App menu"
              onClick={() => setShowAppMenu((current) => !current)}
            >
              <Settings size={17} />
            </IconButton>
            {showAppMenu ? (
              <div className="absolute right-0 top-full z-50 mt-1 w-56 origin-top-right rounded border border-slate-200 bg-white py-1 shadow-lg">
                <button
                  className="flex w-full items-center gap-2 px-4 py-1.5 text-left text-sm text-slate-700 hover:bg-slate-100"
                  onClick={handleExport}
                >
                  <Download size={15} />
                  Export all to Postman
                </button>
                <button
                  className="flex w-full items-center gap-2 px-4 py-1.5 text-left text-sm text-slate-700 hover:bg-slate-100"
                  onClick={openCookies}
                >
                  <Cookie size={15} />
                  Manage cookies
                </button>
                <button
                  className="flex w-full items-center gap-2 px-4 py-1.5 text-left text-sm text-slate-700 hover:bg-slate-100"
                  onClick={() => {
                    setShowEnvironmentsPanel((current) => !current);
                    setShowAppMenu(false);
                  }}
                >
                  <Eye size={15} />
                  {showEnvironmentsPanel ? "Hide" : "Show"} environments
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </header>

      <div ref={collectionsSplitRef} className="flex min-h-0 flex-1 overflow-hidden">
        {showSidebar ? (<>
        <aside
          className="flex min-h-0 shrink-0 flex-col border-r border-slate-200 bg-white"
          style={{
            width: collectionsPanelWidth === null ? "300px" : `${collectionsPanelWidth}px`,
            minWidth: `${COLLECTIONS_PANEL_MIN_WIDTH}px`,
            maxWidth: `${COLLECTIONS_PANEL_MAX_WIDTH}px`
          }}
        >
          <div ref={sidebarSplitRef} className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <section
              className={`flex min-h-0 flex-col border-b border-slate-200 ${
                showCollectionsPanel ? (showEnvironmentsPanel ? "" : "flex-1") : "shrink-0"
              }`}
              style={
                showCollectionsPanel && showEnvironmentsPanel
                  ? {
                      height: collectionsPanelHeight === null ? "50%" : `${collectionsPanelHeight}px`
                    }
                  : undefined
              }
            >
              <div className="flex h-8 shrink-0 items-center justify-between border-b border-slate-200 px-2">
                <button
                  type="button"
                  className="flex min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-left text-xs font-semibold text-slate-700 hover:bg-slate-50"
                  onClick={() => setShowCollectionsPanel((current) => !current)}
                  aria-expanded={showCollectionsPanel}
                  aria-label={showCollectionsPanel ? "Collapse collections panel" : "Expand collections panel"}
                  title={showCollectionsPanel ? "Collapse collections panel" : "Expand collections panel"}
                >
                  <ChevronRight
                    size={15}
                    className={`shrink-0 transition-transform ${showCollectionsPanel ? "rotate-90" : ""}`}
                  />
                  <span className="truncate">Collections</span>
                </button>
                {showCollectionsPanel ? (
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
                ) : null}
              </div>

              {showCollectionsPanel ? (
                <>
                  <div className="min-h-0 flex-1 overflow-auto p-1">
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
                          expanded={expandedCollections[collection.id] ?? true}
                          folderExpanded={expandedFolders}
                          onSelectCollection={() => {
                            focusRequestView();
                            setActiveRequestTabId(null);
                            setSelectedCollectionId(collection.id);
                            setSelectedFolderId(null);
                            setCollectionExpanded(collection.id, true);
                          }}
                          onSelectFolder={(folder) => {
                            focusRequestView();
                            setActiveRequestTabId(null);
                            setSelectedCollectionId(folder.collectionId);
                            setSelectedFolderId(folder.id);
                            setCollectionExpanded(folder.collectionId, true);
                            expandFolderPath(folder.id);
                          }}
                          onSelectRequest={selectRequest}
                          onRenameCollection={renameCollection}
                          onDeleteCollection={deleteCollection}
                          onRenameFolder={renameFolder}
                          onDeleteFolder={deleteFolder}
                          onToggleCollection={(collection) =>
                            setCollectionExpanded(collection.id, !(expandedCollections[collection.id] ?? true))
                          }
                          onToggleFolder={(folder) =>
                            setFolderExpanded(folder.id, !(expandedFolders[folder.id] ?? true))
                          }
                          onRunCollection={(collection) =>
                            setRunnerTarget({ type: "collection", id: collection.id, name: collection.name })
                          }
                          onRunFolder={(folder) =>
                            setRunnerTarget({ type: "folder", id: folder.id, name: folder.name })
                          }
                          draggedRequestId={draggedRequestId}
                          dropTargetCollectionId={dropTargetCollectionId}
                          dropTargetFolderId={dropTargetFolderId}
                          onRequestDragStart={(request) => {
                            setDraggedRequestId(request.id);
                            setDropTargetCollectionId(null);
                            setDropTargetFolderId(null);
                          }}
                          onRequestDragEnd={clearRequestDragState}
                          onCollectionDragOver={(collection, requestId) => {
                            if (!requestId) {
                              return;
                            }
                            setDropTargetCollectionId(collection.id);
                            setDropTargetFolderId(null);
                          }}
                          onCollectionDragLeave={(collection) => {
                            setDropTargetCollectionId((current) => (current === collection.id ? null : current));
                          }}
                          onCollectionDrop={(collection, requestId) => {
                            if (!requestId) {
                              return;
                            }
                            void moveRequestToTreeTarget({
                              requestId,
                              collectionId: collection.id,
                              folderId: null
                            }).finally(() => {
                              clearRequestDragState();
                            });
                          }}
                          onFolderDragOver={(folder, requestId) => {
                            if (!requestId) {
                              return;
                            }
                            setDropTargetCollectionId(null);
                            setDropTargetFolderId(folder.id);
                          }}
                          onFolderDragLeave={(folder) => {
                            setDropTargetFolderId((current) => (current === folder.id ? null : current));
                          }}
                          onFolderDrop={(folder, requestId) => {
                            if (!requestId) {
                              return;
                            }
                            void moveRequestToTreeTarget({
                              requestId,
                              collectionId: folder.collectionId,
                              folderId: folder.id
                            }).finally(() => {
                              clearRequestDragState();
                            });
                          }}
                          onRequestContextMenu={(event, request) => handleRequestTreeContextMenu(event, request.id)}
                          renamingRequestId={renamingRequestId}
                          onRenameRequest={renameRequest}
                          onRenameCancel={() => setRenamingRequestId(null)}
                        />
                      ))
                    )}
                  </div>
                </>
              ) : null}
            </section>

              {showCollectionsPanel && showEnvironmentsPanel ? (
                <button
                  type="button"
                  className="group relative z-10 -mt-px flex h-[10px] shrink-0 cursor-row-resize items-stretch justify-center border-y border-transparent bg-slate-100 hover:bg-teal-50 active:bg-teal-100"
                  onPointerDown={beginSidebarResize}
                  aria-label="Resize collections and environments panels"
                  title="Drag to resize collections and environments panels"
                >
                  <span className="my-auto h-1 w-14 rounded-full bg-slate-300 transition group-hover:bg-teal-400" />
                </button>
              ) : null}

            <section className={`flex min-h-0 flex-col ${showEnvironmentsPanel ? "flex-1" : "shrink-0"}`}>
              <div className="flex h-8 shrink-0 items-center justify-between border-b border-slate-200 px-2">
                <button
                  type="button"
                  className="flex min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-left text-xs font-semibold text-slate-700 hover:bg-slate-50"
                  onClick={() => setShowEnvironmentsPanel((current) => !current)}
                  aria-expanded={showEnvironmentsPanel}
                  aria-label={showEnvironmentsPanel ? "Collapse environments panel" : "Expand environments panel"}
                  title={showEnvironmentsPanel ? "Collapse environments panel" : "Expand environments panel"}
                >
                  <ChevronRight
                    size={15}
                    className={`shrink-0 transition-transform ${showEnvironmentsPanel ? "rotate-90" : ""}`}
                  />
                  <span className="truncate">Environments</span>
                </button>
                {showEnvironmentsPanel ? (
                  <div className="flex gap-1">
                    <IconButton label="New environment" onClick={createEnvironment}>
                      <Plus size={16} />
                    </IconButton>
                  </div>
                ) : null}
              </div>

              {showEnvironmentsPanel ? (
                <div className="min-h-0 flex-1 overflow-auto p-1">
                  {!data ? (
                    <LoadingBlock label="Loading environments" />
                  ) : data.environments.length === 0 ? (
                    <EmptyState
                      title="No environments"
                      actionLabel="Create environment"
                      onAction={createEnvironment}
                    />
                  ) : (
                    data.environments.map((environment) => (
                      <EnvironmentTreeItem
                        key={environment.id}
                        environment={environment}
                        selected={selectedEnvironmentId === environment.id}
                        onSelect={selectEnvironment}
                        onContextMenu={handleEnvironmentContextMenu}
                        renaming={renamingEnvironmentId === environment.id}
                        onRenameSubmit={renameEnvironment}
                        onRenameCancel={() => setRenamingEnvironmentId(null)}
                      />
                    ))
                  )}
                </div>
              ) : null}
            </section>
          </div>
        </aside>

        <button
          type="button"
          className="group relative z-10 -ml-px flex w-[10px] shrink-0 cursor-col-resize items-stretch justify-center border-x border-transparent bg-slate-100 hover:bg-teal-50 active:bg-teal-100"
          onPointerDown={beginCollectionsResize}
          aria-label="Resize sidebar"
          title="Drag to resize sidebar"
        >
          <span className="my-auto h-12 w-1 rounded-full bg-slate-300 transition group-hover:bg-teal-400" />
        </button>
        </>) : null}

        <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[var(--surface-2)]">
          <div className={mainPanelMode === "request" ? "flex min-h-0 flex-1 flex-col overflow-hidden" : "hidden"}>
            {requestTabs.length ? (
              <RequestTabStrip
                tabs={requestTabs}
                activeTabId={activeRequestTabId}
                onSelectTab={(tabId) => {
                  focusRequestView();
                  setActiveRequestTabId(tabId);
                }}
                onCloseTab={(tabId) => void closeRequestTabs([tabId], false)}
                onContextMenu={handleRequestTabContextMenu}
              />
            ) : null}
            {draft ? (
              <div ref={responseSplitRef} className="flex min-h-0 flex-1 flex-col overflow-hidden">
                <div className="min-h-0 flex-1 overflow-hidden">
                  <RequestEditor
                    draft={draft}
                    busy={busy}
                    variableLookup={variableLookup}
                    onChange={updateActiveDraft}
                    onSave={() => void saveDraft()}
                    onSend={() => void sendRequest()}
                    onSendAndDownload={() => void sendAndDownloadRequest()}
                    onCancel={() => cancelRequest()}
                    onDelete={() => void deleteRequest()}
                  />
                </div>
                {showResponsePanel ? (<>
                <button
                  className="group flex h-3 shrink-0 items-center justify-center border-y border-slate-200 bg-[var(--surface-3)] transition hover:bg-teal-50 active:bg-teal-100"
                  onPointerDown={beginResponseResize}
                  type="button"
                  aria-label="Resize response panel"
                  title="Drag to resize response panel"
                >
                  <span className="h-1 w-14 rounded-full bg-slate-300 transition group-hover:bg-teal-400" />
                </button>
                <div
                  className="min-h-0 flex-none"
                  style={{
                    height: responsePanelHeight === null ? "45%" : `${responsePanelHeight}px`
                  }}
                >
                  <ResponsePanel response={response} body={responseBody} busy={busy} />
                </div>
                </>) : null}
              </div>
            ) : selectedSidebarFolder ? (
              <ScriptScopeEditor
                key={`folder-${selectedSidebarFolder.id}`}
                title={selectedSidebarFolder.name}
                scopeLabel="Folder"
                preRequestScript={selectedSidebarFolder.preRequestScript}
                postRequestScript={selectedSidebarFolder.postRequestScript}
                onSave={(preRequestScript, postRequestScript) =>
                  saveFolderScripts(selectedSidebarFolder.id, preRequestScript, postRequestScript)
                }
              />
            ) : selectedSidebarCollection ? (
              <ScriptScopeEditor
                key={`collection-${selectedSidebarCollection.id}`}
                title={selectedSidebarCollection.name}
                scopeLabel="Collection"
                preRequestScript={selectedSidebarCollection.preRequestScript}
                postRequestScript={selectedSidebarCollection.postRequestScript}
                onSave={(preRequestScript, postRequestScript) =>
                  saveCollectionScripts(selectedSidebarCollection.id, preRequestScript, postRequestScript)
                }
              />
            ) : (
              <div className="flex flex-1 items-center justify-center">
                <EmptyState title="Select or create a request" actionLabel="New request" onAction={createRequest} />
              </div>
            )}
          </div>

          <div className={mainPanelMode === "environment" ? "flex min-h-0 flex-1 overflow-hidden" : "hidden"}>
            {data ? (
               <EnvironmentWorkspace
                data={data}
                selectedEnvironmentId={selectedEnvironmentId}
                onSelectEnvironment={selectEnvironment}
                onBackToRequests={focusRequestView}
                onCreateEnvironment={createEnvironment}
                onDeleteEnvironment={handleDeleteEnvironment}
                onRefresh={async () => {
                  await refresh();
                }}
              />
            ) : (
              <div className="flex flex-1 items-center justify-center">
                <LoadingBlock label="Loading environments" />
              </div>
            )}
          </div>
        </section>
      </div>

      {notice ? (
        <div className="fixed bottom-4 left-1/2 z-40 -translate-x-1/2 rounded bg-slate-950 px-4 py-1.5 text-sm text-white shadow-lg">
          <button className="absolute inset-0" onClick={() => setNotice(null)} aria-label="Dismiss notice" />
          {notice}
        </div>
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

      {showCookies ? <CookiesModal onClose={() => setShowCookies(false)} onNotice={setNotice} /> : null}

      {requestTabMenu ? (
        <RequestTabContextMenu
          menu={requestTabMenu}
          tabCount={requestTabs.length}
          onDuplicate={() => duplicateRequestTab(requestTabMenu.tabId)}
          onClose={() => void closeRequestTabs([requestTabMenu.tabId], false)}
          onForceClose={() => void closeRequestTabs([requestTabMenu.tabId], true)}
          onCloseOthers={() => void closeOtherRequestTabs(requestTabMenu.tabId, false)}
          onCloseAll={() => void closeAllRequestTabs(false)}
          onForceCloseAll={() => void closeAllRequestTabs(true)}
        />
      ) : null}

      {requestTreeMenu && data ? (
        (() => {
          const req = findRequest(data.collections, requestTreeMenu.requestId);
          return req ? (
            <RequestTreeContextMenu
              menu={requestTreeMenu}
              request={req}
              onRename={() => {
                setRequestTreeMenu(null);
                setRenamingRequestId(req.id);
              }}
              onDuplicate={() => duplicateRequest(req)}
              onCopy={() => copyRequestAsCurl(req)}
            />
          ) : null;
        })()
      ) : null}

      {environmentMenu && data ? (
        <EnvironmentContextMenu
          menu={environmentMenu}
          onRename={(environmentId) => {
            setEnvironmentMenu(null);
            setRenamingEnvironmentId(environmentId);
          }}
          onDelete={async (environmentId) => {
            setEnvironmentMenu(null);
            const env = data.environments.find((e) => e.id === environmentId);
            if (!env) {
              return;
            }
            const remaining = data.environments.filter((e) => e.id !== environmentId);
            const next = remaining.find((e) => e.active) ?? remaining[0] ?? null;
            setConfirmDialog({
              message: `Delete environment "${env.name}"?`,
              onConfirm: () => {
                setConfirmDialog(null);
                void (async () => {
                  await api(`/api/environments/${environmentId}`, { method: "DELETE" });
                  if (next) {
                    selectEnvironment(next.id);
                  } else {
                    setSelectedEnvironmentId(null);
                    setMainPanelMode("request");
                    setShowEnvironmentsPanel(false);
                  }
                  await refresh();
                })();
              }
            });
          }}
        />
      ) : null}

      {runnerTarget && data ? (
        <CollectionRunnerModal
          data={data}
          target={runnerTarget}
          initialReport={runnerReport}
          onClose={() => {
            setRunnerTarget(null);
            setRunnerReport(null);
          }}
          onBeforeRun={() => saveDraftIfInsideTarget(runnerTarget)}
          onRunComplete={async (report) => {
            setRunnerReport(report);
            await refresh();
          }}
        />
      ) : null}

      {confirmDialog ? (
        <ConfirmDialog
          message={confirmDialog.message}
          onConfirm={confirmDialog.onConfirm}
          onCancel={() => setConfirmDialog(null)}
        />
      ) : null}

      {promptDialog ? (
        <PromptDialog
          message={promptDialog.message}
          defaultValue={promptDialog.defaultValue}
          onConfirm={promptDialog.onConfirm}
          onCancel={() => setPromptDialog(null)}
        />
      ) : null}
    </main>
  );
}

function RequestTabStrip({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onContextMenu
}: {
  tabs: OpenRequestTab[];
  activeTabId: string | null;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onContextMenu: (event: React.MouseEvent<HTMLElement>, tabId: string) => void;
}) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  function updateScrollButtons() {
    const scroller = scrollerRef.current;
    if (!scroller) {
      setCanScrollLeft(false);
      setCanScrollRight(false);
      return;
    }

    setCanScrollLeft(scroller.scrollLeft > 1);
    setCanScrollRight(scroller.scrollLeft + scroller.clientWidth < scroller.scrollWidth - 1);
  }

  function scrollTabs(direction: -1 | 1) {
    const scroller = scrollerRef.current;
    if (!scroller) {
      return;
    }

    scroller.scrollBy({
      left: direction * Math.max(240, Math.round(scroller.clientWidth * 0.7)),
      behavior: "smooth"
    });
  }

  useEffect(() => {
    updateScrollButtons();
  }, [tabs.length, activeTabId]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || !activeTabId) {
      return;
    }

    const activeTab = scroller.querySelector(`[data-request-tab-id="${activeTabId}"]`);
    activeTab?.scrollIntoView({ block: "nearest", inline: "nearest" });
    updateScrollButtons();
  }, [activeTabId]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) {
      return;
    }

    scroller.addEventListener("scroll", updateScrollButtons);
    window.addEventListener("resize", updateScrollButtons);
    return () => {
      scroller.removeEventListener("scroll", updateScrollButtons);
      window.removeEventListener("resize", updateScrollButtons);
    };
  }, []);

  return (
    <div className="flex h-10 shrink-0 items-end border-b border-slate-200 bg-slate-100 pl-2 pt-2">
      <div
        ref={scrollerRef}
        className="min-w-0 flex-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        <div className="flex min-w-max items-end gap-1 pr-2">
        {tabs.map((tab) => {
          const active = tab.tabId === activeTabId;
          const savingState = tab.saving ? "Saving" : tab.dirty ? "Unsaved changes" : "Saved";

          return (
            <div
              key={tab.tabId}
              data-request-tab-id={tab.tabId}
              className={`group flex h-8 w-56 shrink-0 items-center rounded-t border px-2 text-sm transition ${
                active
                  ? "border-slate-200 border-b-white bg-white text-slate-900 shadow-sm"
                  : "border-slate-200 bg-slate-50 text-slate-600 hover:bg-white"
              }`}
              onContextMenu={(event) => onContextMenu(event, tab.tabId)}
            >
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
                onClick={() => onSelectTab(tab.tabId)}
                title={`${tab.draft.method} ${tab.draft.name}`}
              >
                <span className={`shrink-0 text-xs font-semibold ${active ? "text-teal-700" : methodColor(tab.draft.method)}`}>
                  {tab.draft.method}
                </span>
                <span className="truncate font-medium">{tab.draft.name || "Untitled request"}</span>
                {tab.dirty || tab.saving ? (
                  <span
                    className={`h-2 w-2 shrink-0 rounded-full ${tab.saving ? "bg-amber-400" : "bg-teal-500"}`}
                    title={savingState}
                  />
                ) : null}
              </button>
              <button
                type="button"
                className="ml-1 flex h-6 w-6 shrink-0 items-center justify-center rounded text-slate-400 opacity-80 hover:bg-slate-200 hover:text-slate-700 group-hover:opacity-100"
                onClick={(event) => {
                  event.stopPropagation();
                  onCloseTab(tab.tabId);
                }}
                aria-label={`Close ${tab.draft.name || "request"} tab`}
                title="Close tab"
              >
                <X size={14} />
              </button>
            </div>
          );
        })}
        </div>
      </div>
      <div className="flex h-8 shrink-0 items-center gap-1 border-l border-slate-200 bg-slate-100 px-2">
        <button
          type="button"
          className="flex h-7 w-7 items-center justify-center rounded border border-slate-300 bg-white text-slate-600 disabled:cursor-not-allowed disabled:opacity-40 enabled:hover:bg-slate-50"
          onClick={() => scrollTabs(-1)}
          disabled={!canScrollLeft}
          aria-label="Scroll tabs left"
          title="Scroll tabs left"
        >
          <ChevronLeft size={15} />
        </button>
        <button
          type="button"
          className="flex h-7 w-7 items-center justify-center rounded border border-slate-300 bg-white text-slate-600 disabled:cursor-not-allowed disabled:opacity-40 enabled:hover:bg-slate-50"
          onClick={() => scrollTabs(1)}
          disabled={!canScrollRight}
          aria-label="Scroll tabs right"
          title="Scroll tabs right"
        >
          <ChevronRight size={15} />
        </button>
      </div>
    </div>
  );
}

function RequestTabContextMenu({
  menu,
  tabCount,
  onDuplicate,
  onClose,
  onForceClose,
  onCloseOthers,
  onCloseAll,
  onForceCloseAll
}: {
  menu: RequestTabContextMenuState;
  tabCount: number;
  onDuplicate: () => void;
  onClose: () => void;
  onForceClose: () => void;
  onCloseOthers: () => void;
  onCloseAll: () => void;
  onForceCloseAll: () => void;
}) {
  const hasOtherTabs = tabCount > 1;

  return (
    <div
      className="fixed z-50 w-56 rounded border border-slate-200 bg-white py-1 text-sm text-slate-700 shadow-xl"
      style={{ left: menu.x, top: menu.y }}
      role="menu"
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      <ContextMenuItem label="Duplicate Tab" onClick={onDuplicate} />
      <ContextMenuSeparator />
      <ContextMenuItem label="Close Tab" onClick={onClose} />
      <ContextMenuItem label="Force Close Tab" onClick={onForceClose} />
      <ContextMenuSeparator />
      <ContextMenuItem label="Close Other Tabs" onClick={onCloseOthers} disabled={!hasOtherTabs} />
      <ContextMenuItem label="Close All Tabs" onClick={onCloseAll} />
      <ContextMenuItem label="Force Close All Tabs" onClick={onForceCloseAll} />
    </div>
  );
}

function RequestTreeContextMenu({
  menu,
  request,
  onRename,
  onDuplicate,
  onCopy
}: {
  menu: RequestTreeContextMenuState;
  request: ApiRequest;
  onRename: (request: ApiRequest) => void;
  onDuplicate: (request: ApiRequest) => void;
  onCopy: (request: ApiRequest) => void;
}) {
  return (
    <div
      className="fixed z-50 w-48 rounded border border-slate-200 bg-white py-1 text-sm text-slate-700 shadow-xl"
      style={{ left: menu.x, top: menu.y }}
      role="menu"
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      <ContextMenuItem label="Rename" onClick={() => onRename(request)} />
      <ContextMenuItem label="Copy as cURL" onClick={() => onCopy(request)} />
      <ContextMenuItem label="Duplicate" onClick={() => onDuplicate(request)} />
    </div>
  );
}

function EnvironmentContextMenu({
  menu,
  onRename,
  onDelete
}: {
  menu: EnvironmentMenuState;
  onRename: (environmentId: string) => void;
  onDelete: (environmentId: string) => void;
}) {
  return (
    <div
      className="fixed z-50 w-48 rounded border border-slate-200 bg-white py-1 text-sm text-slate-700 shadow-xl"
      style={{ left: menu.x, top: menu.y }}
      role="menu"
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      <ContextMenuItem label="Rename" onClick={() => onRename(menu.environmentId)} />
      <ContextMenuSeparator />
      <ContextMenuItem label="Delete" onClick={() => onDelete(menu.environmentId)} />
    </div>
  );
}

function ContextMenuItem({
  label,
  onClick,
  disabled = false
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className="flex h-8 w-full items-center px-3 text-left disabled:cursor-not-allowed disabled:text-slate-300 enabled:hover:bg-teal-50 enabled:hover:text-teal-800"
      onClick={onClick}
      disabled={disabled}
      role="menuitem"
    >
      {label}
    </button>
  );
}

function ContextMenuSeparator() {
  return <div className="my-1 border-t border-slate-100" />;
}

function ScriptScopeEditor({
  title,
  scopeLabel,
  preRequestScript,
  postRequestScript,
  onSave
}: {
  title: string;
  scopeLabel: "Collection" | "Folder";
  preRequestScript: string;
  postRequestScript: string;
  onSave: (preRequestScript: string, postRequestScript: string) => Promise<void>;
}) {
  const [activeScriptTab, setActiveScriptTab] = useState<ScriptTab>("pre-request");
  const [preScript, setPreScript] = useState(preRequestScript);
  const [postScript, setPostScript] = useState(postRequestScript);
  const [saving, setSaving] = useState(false);
  const dirty = preScript !== preRequestScript || postScript !== postRequestScript;

  useEffect(() => {
    setPreScript(preRequestScript);
    setPostScript(postRequestScript);
    setActiveScriptTab(preRequestScript.trim() || !postRequestScript.trim() ? "pre-request" : "post-request");
  }, [preRequestScript, postRequestScript]);

  async function saveScripts() {
    setSaving(true);
    try {
      await onSave(preScript, postScript);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-white">
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-slate-200 px-4">
        <div className="min-w-0">
          <div className="text-xs font-semibold uppercase text-slate-500">{scopeLabel}</div>
          <h2 className="truncate text-sm font-semibold text-slate-800">{title}</h2>
        </div>
        <button
          className="inline-flex h-8 items-center gap-2 rounded bg-teal-600 px-3 text-sm font-semibold text-white hover:bg-teal-700 disabled:cursor-not-allowed disabled:opacity-50"
          onClick={() => void saveScripts()}
          disabled={saving || !dirty}
          type="button"
        >
          {saving ? <Loader2 className="animate-spin" size={16} /> : <Save size={16} />}
          Save
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-2">
        <EditorSection title="Scripts">
          <ScriptTextEditor
            activeScriptTab={activeScriptTab}
            preRequestScript={preScript}
            postRequestScript={postScript}
            onTabChange={setActiveScriptTab}
            onPreRequestScriptChange={setPreScript}
            onPostRequestScriptChange={setPostScript}
          />
        </EditorSection>
      </div>
    </div>
  );
}

function ScriptTextEditor({
  activeScriptTab,
  preRequestScript,
  postRequestScript,
  onTabChange,
  onPreRequestScriptChange,
  onPostRequestScriptChange
}: {
  activeScriptTab: ScriptTab;
  preRequestScript: string;
  postRequestScript: string;
  onTabChange: (tab: ScriptTab) => void;
  onPreRequestScriptChange: (script: string) => void;
  onPostRequestScriptChange: (script: string) => void;
}) {
  return (
    <div className="grid gap-2">
      <div className="inline-flex w-fit rounded border border-slate-200 bg-slate-50 p-1">
        {SCRIPT_TABS.map((tab) => {
          const active = activeScriptTab === tab;

          return (
            <button
              key={tab}
              className={`rounded px-3 py-1.5 text-xs font-semibold transition ${
                active
                  ? "bg-white text-teal-700 shadow-sm"
                  : "text-slate-600 hover:bg-white/70 hover:text-slate-900"
              }`}
              onClick={() => onTabChange(tab)}
              type="button"
            >
              {tab === "pre-request" ? "Pre-request" : "Post-request"}
            </button>
          );
        })}
      </div>

      {activeScriptTab === "pre-request" ? (
        <label className="grid gap-2">
          <span className="text-xs font-semibold uppercase text-slate-500">Pre-request</span>
          <textarea
            className="min-h-72 resize-y rounded border border-slate-300 bg-white p-2 font-mono text-xs leading-5 text-slate-900"
            value={preRequestScript}
            onChange={(event) => onPreRequestScriptChange(event.target.value)}
            spellCheck={false}
            aria-label="Pre-request script"
          />
        </label>
      ) : (
        <label className="grid gap-2">
          <span className="text-xs font-semibold uppercase text-slate-500">Post-request</span>
          <textarea
            className="min-h-72 resize-y rounded border border-slate-300 bg-white p-2 font-mono text-xs leading-5 text-slate-900"
            value={postRequestScript}
            onChange={(event) => onPostRequestScriptChange(event.target.value)}
            spellCheck={false}
            aria-label="Post-request script"
          />
        </label>
      )}
    </div>
  );
}

function RequestEditor({
  draft,
  busy,
  variableLookup,
  onChange,
  onSave,
  onSend,
  onSendAndDownload,
  onCancel,
  onDelete
}: {
  draft: RequestDraft;
  busy: boolean;
  variableLookup: VariableLookup;
  onChange: (draft: RequestDraft) => void;
  onSave: () => void;
  onSend: () => void;
  onSendAndDownload?: () => void;
  onCancel?: () => void;
  onDelete: () => void;
}) {
  const [activeTab, setActiveTab] = useState<RequestTab | null>("body");
  const [activeScriptTab, setActiveScriptTab] = useState<ScriptTab>("pre-request");
  const [showCodePanel, setShowCodePanel] = useState(false);
  const [showSendMenu, setShowSendMenu] = useState(false);
  const [curlError, setCurlError] = useState<string | null>(null);
  const [curlNotice, setCurlNotice] = useState<string | null>(null);
  const generatedCurl = useMemo(() => requestDraftToCurl(draft), [draft]);

  useEffect(() => {
    setCurlError(null);
    setCurlNotice(null);
  }, [draft.id]);

  useEffect(() => {
    const hasPre = draft.preRequestScript.trim().length > 0;
    const hasPost = draft.postRequestScript.trim().length > 0;

    if (hasPre && !hasPost) {
      setActiveScriptTab("pre-request");
      return;
    }

    if (hasPost && !hasPre) {
      setActiveScriptTab("post-request");
      return;
    }

    setActiveScriptTab("pre-request");
  }, [draft.id]);

  useEffect(() => {
    if (!showSendMenu) return;
    const handler = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (!target.closest(".send-button-group")) {
        setShowSendMenu(false);
      }
    };
    document.addEventListener("mousedown", handler, true);
    return () => document.removeEventListener("mousedown", handler, true);
  }, [showSendMenu]);

  async function copyCurl() {
    setCurlError(null);
    setCurlNotice(null);

    if (!navigator.clipboard?.writeText) {
      setCurlError("Clipboard is not available. Select the generated cURL and copy it manually.");
      return;
    }

    try {
      await navigator.clipboard.writeText(generatedCurl);
      setCurlNotice("cURL copied.");
    } catch {
      setCurlError("Could not copy to clipboard. Select the generated cURL and copy it manually.");
    }
  }

  function applyPastedCurl(text: string) {
    setCurlError(null);
    setCurlNotice(null);

    try {
      const nextDraft = parseCurlToRequestDraft(text, draft);
      onChange(nextDraft);
      setCurlNotice("cURL applied to the current request.");
    } catch (error) {
      setCurlError(
        error instanceof CurlParseError || error instanceof Error
          ? error.message
          : "Could not parse the pasted cURL."
      );
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col border-b border-slate-200 bg-white">
      <div className="border-b border-slate-200 px-2 py-1">
        <div className="mb-1 flex flex-wrap items-center gap-1.5">
          <div className="min-w-0 flex-1 overflow-x-auto">
            <div className="flex min-w-max gap-2">
              {REQUEST_TABS.map((tab) => {
                const label =
                  tab === "auth"
                    ? "Auth"
                    : tab === "headers"
                      ? "Headers"
                      : tab === "query"
                        ? "Query Params"
                        : tab === "body"
                          ? "Body"
                          : "Scripts";
                const active = activeTab === tab;

                return (
                  <button
                    key={tab}
                    className={`rounded-full border px-2.5 py-1 text-xs font-semibold transition ${
                      active
                        ? "border-teal-600 bg-teal-600 text-white"
                        : "border-slate-300 bg-white text-slate-600 hover:bg-slate-50"
                    }`}
                    onClick={() => setActiveTab((currentTab) => (currentTab === tab ? null : tab))}
                    type="button"
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
          <IconButton label="Save request" onClick={onSave}>
            <Save size={17} />
          </IconButton>
          <IconButton label="Delete request" onClick={onDelete}>
            <Trash2 size={17} />
          </IconButton>
        </div>

        <div className="flex gap-1.5">
          <select
            className="h-9 w-28 rounded border border-slate-300 bg-white px-2 text-sm font-semibold text-teal-700"
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
          <div className="relative min-w-0 flex-1">
            <TokenizedField
              className="min-h-[2.25rem] py-1.5 leading-6"
              value={draft.url}
              onChange={(value) => onChange({ ...draft, url: value })}
              placeholder="{{baseUrl}}/users"
              aria-label="Request URL"
              variableLookup={variableLookup}
            />
            {draft.url.trim() && !draft.url.startsWith("http://") && !draft.url.startsWith("https://") && !draft.url.includes("{{") ? (
              <span className="absolute -bottom-4 left-0 text-[10px] text-amber-600">
                No protocol — will prepend https://
              </span>
            ) : null}
          </div>
          {busy ? (
            <button
              className="inline-flex h-9 items-center gap-2 rounded border border-rose-300 bg-white px-3 text-sm font-semibold text-rose-700 hover:bg-rose-50"
              onClick={onCancel}
              type="button"
            >
              <X size={17} />
              Cancel
            </button>
          ) : (
            <div className="send-button-group relative flex">
              <button
                className="inline-flex h-9 items-center gap-2 rounded-l bg-teal-600 px-3 text-sm font-semibold text-white hover:bg-teal-700 disabled:cursor-not-allowed disabled:opacity-50"
                onClick={onSend}
                disabled={!draft.url.trim()}
                type="button"
              >
                <Send size={17} />
                Send
              </button>
              <button
                className="flex h-9 w-7 items-center justify-center rounded-r bg-teal-600 text-white hover:bg-teal-700 disabled:cursor-not-allowed disabled:opacity-50"
                onClick={() => setShowSendMenu((current) => !current)}
                type="button"
                disabled={!draft.url.trim()}
              >
                <ChevronDown size={12} />
              </button>
              {showSendMenu ? (
                <div
                  className="absolute right-0 top-full z-30 mt-1 w-52 rounded border border-slate-200 bg-white py-1 text-sm text-slate-700 shadow-xl"
                  onClick={(event) => event.stopPropagation()}
                >
                  <button
                    className="flex h-8 w-full items-center px-3 text-left hover:bg-teal-50 hover:text-teal-800"
                    onClick={() => { setShowSendMenu(false); onSend(); }}
                    type="button"
                  >
                    Send
                  </button>
                  <button
                    className="flex h-8 w-full items-center px-3 text-left hover:bg-teal-50 hover:text-teal-800"
                    onClick={() => { setShowSendMenu(false); onSendAndDownload?.(); }}
                    type="button"
                  >
                    <Download size={14} className="mr-2" />
                    Send and Download
                  </button>
                </div>
              ) : null}
            </div>
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="min-h-0 flex-1 overflow-auto p-1.5">
          <div className="grid gap-1.5">
            {activeTab ? (
              <>
                {activeTab === "auth" ? (
                  <EditorSection title="Auth">
                    <AuthEditor
                      auth={draft.auth}
                      variableLookup={variableLookup}
                      onChange={(auth) => onChange({ ...draft, auth })}
                    />
                  </EditorSection>
                ) : null}

                {activeTab === "headers" ? (
                  <EditorSection title="Headers">
                    <KeyValueTable
                      rows={draft.headers}
                      variableLookup={variableLookup}
                      onChange={(headers) => onChange({ ...draft, headers })}
                      addLabel="Add header"
                    />
                    <AutoHeadersDisplay draft={draft} />
                  </EditorSection>
                ) : null}

                {activeTab === "query" ? (
                  <EditorSection title="Query Params">
                    <KeyValueTable
                      rows={draft.queryParams}
                      variableLookup={variableLookup}
                      onChange={(queryParams) => onChange({ ...draft, queryParams })}
                      addLabel="Add param"
                    />
                  </EditorSection>
                ) : null}

                {activeTab === "body" ? (
                  <section className="rounded border border-slate-200 bg-white p-2 shadow-panel">
                    <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                      <h2 className="text-sm font-semibold text-slate-700">Body</h2>
                      {(["none", "raw_json", "raw_text", "form_urlencoded", "multipart"] as const).map((mode) => (
                        <label key={mode} className="flex cursor-pointer items-center gap-1 text-xs">
                          <input
                            type="radio"
                            name="bodyMode"
                            className="text-teal-600 accent-teal-600"
                            checked={draft.bodyMode === mode}
                            onChange={() => onChange({ ...draft, bodyMode: mode })}
                          />
                          {mode === "none" ? "none" : mode === "raw_json" ? "raw JSON" : mode === "raw_text" ? "raw text" : mode === "form_urlencoded" ? "URL-encoded" : "multipart"}
                        </label>
                      ))}
                      {draft.bodyMode === "raw_json" && draft.bodyRaw.trim() ? (
                        <button
                          className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-semibold text-slate-500 hover:bg-slate-100"
                          onClick={() => {
                            try {
                              const formatted = JSON.stringify(JSON.parse(draft.bodyRaw), null, 2);
                              onChange({ ...draft, bodyRaw: formatted });
                            } catch {
                              // ignore invalid JSON
                            }
                          }}
                          type="button"
                        >
                          <FileJson size={14} />
                          Format
                        </button>
                      ) : null}
                    </div>
                    <div className="grid gap-2">
                      <TokenizedField
                        className="resize-y"
                        value={draft.bodyRaw}
                        disabled={draft.bodyMode === "none"}
                        onChange={(value) => onChange({ ...draft, bodyRaw: value })}
                        placeholder={draft.bodyMode === "raw_json" ? '{\n  "name": "PostRE"\n}' : ""}
                        aria-label="Request body"
                        variableLookup={variableLookup}
                        multiline
                      />
                    </div>
                  </section>
                ) : null}

                {activeTab === "scripts" ? (
                  <EditorSection title="Scripts">
                    <ScriptTextEditor
                      activeScriptTab={activeScriptTab}
                      preRequestScript={draft.preRequestScript}
                      postRequestScript={draft.postRequestScript}
                      onTabChange={setActiveScriptTab}
                      onPreRequestScriptChange={(preRequestScript) => onChange({ ...draft, preRequestScript })}
                      onPostRequestScriptChange={(postRequestScript) => onChange({ ...draft, postRequestScript })}
                    />
                  </EditorSection>
                ) : null}
              </>
            ) : null}
          </div>
        </div>
        {showCodePanel ? (
          <CurlCodePanel
            generatedCurl={generatedCurl}
            curlNotice={curlNotice}
            curlError={curlError}
            onCopyCurl={() => void copyCurl()}
            onCurlPaste={applyPastedCurl}
            onClose={() => setShowCodePanel(false)}
          />
        ) : (
          <button
            className="flex items-center border-l border-slate-200 bg-slate-50 px-1 text-slate-400 hover:text-slate-600"
            onClick={() => setShowCodePanel(true)}
            title="Show code panel"
            type="button"
          >
            <ChevronLeft size={16} />
          </button>
        )}
      </div>
    </div>
  );
}

function CurlCodePanel({
  generatedCurl,
  curlNotice,
  curlError,
  onCopyCurl,
  onCurlPaste,
  onClose
}: {
  generatedCurl: string;
  curlNotice: string | null;
  curlError: string | null;
  onCopyCurl: () => void;
  onCurlPaste: (text: string) => void;
  onClose: () => void;
}) {
  function handlePaste(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    const pastedText = event.clipboardData.getData("text");
    if (pastedText.trim()) {
      onCurlPaste(pastedText);
    }
  }

  return (
    <aside className="flex min-h-[360px] min-w-0 flex-col gap-2 border-t border-slate-200 bg-slate-50 p-2 lg:min-h-0 lg:w-[360px] lg:shrink-0 lg:border-l lg:border-t-0">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-slate-700">Code</h2>
          <p className="text-xs text-slate-500">cURL</p>
        </div>
        <div className="flex items-center gap-1">
          <IconButton label="Copy cURL" onClick={onCopyCurl}>
            <Copy size={16} />
          </IconButton>
          <IconButton label="Hide code" onClick={onClose}>
            <ChevronRight size={16} />
          </IconButton>
        </div>
      </div>

      <textarea
        className="min-h-40 w-full flex-1 resize-y rounded border border-slate-300 bg-white p-2 font-mono text-xs leading-5 text-slate-900"
        value={generatedCurl}
        onPaste={handlePaste}
        readOnly
        aria-label="cURL"
      />

      {curlError ? (
        <p className="rounded border border-rose-200 bg-rose-50 px-3 py-1.5 text-xs font-medium text-rose-700">
          {curlError}
        </p>
      ) : null}
      {curlNotice ? (
        <p className="rounded border border-teal-200 bg-teal-50 px-3 py-1.5 text-xs font-medium text-teal-800">
          {curlNotice}
        </p>
      ) : null}
    </aside>
  );
}

function AuthEditor({
  auth,
  variableLookup,
  onChange
}: {
  auth: AuthConfig;
  variableLookup: VariableLookup;
  onChange: (auth: AuthConfig) => void;
}) {
  const type = auth.type;

  return (
    <div className="grid gap-2">
      <select
        className="h-8 w-48 rounded border border-slate-300 bg-white px-3 text-sm"
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
        <TokenizedField
          value={auth.token ?? ""}
          onChange={(value) => onChange({ ...auth, token: value })}
          placeholder="{{token}}"
          aria-label="Bearer token"
          variableLookup={variableLookup}
        />
      ) : null}

      {type === "basic" ? (
        <div className="grid grid-cols-2 gap-2">
          <TokenizedField
            value={auth.username ?? ""}
            onChange={(value) => onChange({ ...auth, username: value })}
            placeholder="username"
            aria-label="Basic auth username"
            variableLookup={variableLookup}
          />
          <TokenizedField
            value={auth.password ?? ""}
            onChange={(value) => onChange({ ...auth, password: value })}
            placeholder="password"
            aria-label="Basic auth password"
            variableLookup={variableLookup}
          />
        </div>
      ) : null}

      {type === "apiKey" ? (
        <div className="grid grid-cols-[1fr_1fr_140px] gap-2">
          <TokenizedField
            value={auth.key ?? ""}
            onChange={(value) => onChange({ ...auth, key: value })}
            placeholder="X-API-Key"
            aria-label="API key name"
            variableLookup={variableLookup}
          />
          <TokenizedField
            value={auth.value ?? ""}
            onChange={(value) => onChange({ ...auth, value: value })}
            placeholder="{{apiKey}}"
            aria-label="API key value"
            variableLookup={variableLookup}
          />
          <select
            className="h-8 rounded border border-slate-300 bg-white px-3 text-sm"
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
        <p className="rounded border border-amber-200 bg-amber-50 px-3 py-1.5 text-sm text-amber-800">
          Imported auth was preserved as metadata but cannot be executed yet.
        </p>
      ) : null}
    </div>
  );
}

function KeyValueTable({
  rows,
  variableLookup,
  onChange,
  addLabel
}: {
  rows: KeyValueRow[];
  variableLookup: VariableLookup;
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
            className="h-8 w-5"
            checked={row.enabled}
            onChange={(event) => updateRow(index, { enabled: event.target.checked })}
            aria-label="Enabled"
          />
          <TokenizedField
            className="px-2"
            value={row.key}
            onChange={(value) => updateRow(index, { key: value })}
            aria-label="Row key"
            variableLookup={variableLookup}
          />
          <SecretInput
            value={row.value}
            isSecret={Boolean(row.isSecret)}
            showSecrets={showSecrets}
            variableLookup={variableLookup}
            onChange={(value) => updateRow(index, { value })}
          />
          <IconButton label="Remove row" onClick={() => onChange(rows.filter((_, rowIndex) => rowIndex !== index))}>
            <Trash2 size={15} />
          </IconButton>
        </div>
      ))}

      <button
        className="inline-flex h-8 w-fit items-center gap-2 rounded border border-slate-300 bg-white px-3 text-sm font-medium hover:bg-slate-50"
        onClick={() => onChange([...rows, { key: "", value: "", enabled: true, isSecret: false }])}
        type="button"
      >
        <Plus size={15} />
        {addLabel}
      </button>
    </div>
  );
}

function AutoHeadersDisplay({ draft }: { draft: RequestDraft }) {
  const autoHeaders = useMemo(() => getEffectiveAutoHeaders(draft), [draft]);

  if (autoHeaders.length === 0) return null;

  return (
    <div className="mt-2 rounded border border-dashed border-slate-200 bg-slate-50 px-3 py-1.5">
      <p className="mb-2 text-xs font-semibold uppercase text-slate-400">Auto-generated</p>
      <div className="grid gap-1">
        {autoHeaders.map((header) => (
          <div
            key={header.key}
            className="grid grid-cols-[minmax(120px,1fr)_minmax(120px,1.4fr)] gap-2 text-sm text-slate-400"
          >
            <span className="truncate">{header.key}</span>
            <span className="truncate">{header.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function CollectionTree({
  collection,
  selectedRequestId,
  selectedFolderId,
  expanded,
  folderExpanded,
  onSelectCollection,
  onSelectFolder,
  onSelectRequest,
  onRenameCollection,
  onDeleteCollection,
  onRenameFolder,
  onDeleteFolder,
  onToggleCollection,
  onToggleFolder,
  onRunCollection,
  onRunFolder,
  draggedRequestId,
  dropTargetCollectionId,
  dropTargetFolderId,
  onRequestDragStart,
  onRequestDragEnd,
  onCollectionDragOver,
  onCollectionDragLeave,
  onCollectionDrop,
  onFolderDragOver,
  onFolderDragLeave,
  onFolderDrop,
  onRequestContextMenu,
  renamingRequestId,
  onRenameRequest,
  onRenameCancel
}: {
  collection: ApiCollection;
  selectedRequestId: string | null;
  selectedFolderId: string | null;
  expanded: boolean;
  folderExpanded: Record<string, boolean>;
  onSelectCollection: () => void;
  onSelectFolder: (folder: ApiFolder) => void;
  onSelectRequest: (request: ApiRequest) => void;
  onRenameCollection: (collection: ApiCollection) => void;
  onDeleteCollection: (collection: ApiCollection) => void;
  onRenameFolder: (folder: ApiFolder) => void;
  onDeleteFolder: (folder: ApiFolder) => void;
  onToggleCollection: (collection: ApiCollection) => void;
  onToggleFolder: (folder: ApiFolder) => void;
  onRunCollection: (collection: ApiCollection) => void;
  onRunFolder: (folder: ApiFolder) => void;
  draggedRequestId: string | null;
  dropTargetCollectionId: string | null;
  dropTargetFolderId: string | null;
  onRequestDragStart: (request: ApiRequest) => void;
  onRequestDragEnd: () => void;
  onCollectionDragOver: (collection: ApiCollection, requestId: string | null) => void;
  onCollectionDragLeave: (collection: ApiCollection) => void;
  onCollectionDrop: (collection: ApiCollection, requestId: string | null) => void;
  onFolderDragOver: (folder: ApiFolder, requestId: string | null) => void;
  onFolderDragLeave: (folder: ApiFolder) => void;
  onFolderDrop: (folder: ApiFolder, requestId: string | null) => void;
  onRequestContextMenu: (event: React.MouseEvent, request: ApiRequest) => void;
  renamingRequestId: string | null;
  onRenameRequest: (requestId: string, newName: string) => void;
  onRenameCancel: () => void;
}) {
  const dropActive = draggedRequestId !== null && dropTargetCollectionId === collection.id;

  return (
    <div className="mb-2">
      <div
        className={`group flex items-center gap-1 rounded px-2 py-1.5 hover:bg-slate-50 ${
          dropActive ? "bg-amber-50 ring-1 ring-amber-300" : ""
        }`}
        onDragOver={(event) => {
          const requestId = getDraggedRequestId(event) || draggedRequestId;
          if (!requestId && !hasDraggedRequestType(event)) {
            return;
          }
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          if (requestId) {
            onCollectionDragOver(collection, requestId);
          }
        }}
        onDragLeave={(event) => {
          const nextTarget = event.relatedTarget;
          if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
            return;
          }
          onCollectionDragLeave(collection);
        }}
        onDrop={(event) => {
          const requestId = getDraggedRequestId(event) || draggedRequestId;
          event.preventDefault();
          onCollectionDrop(collection, requestId || null);
        }}
      >
        <button
          type="button"
          className="flex h-6 w-6 items-center justify-center rounded text-slate-400 hover:bg-slate-200 hover:text-slate-600"
          onClick={() => onToggleCollection(collection)}
          aria-label={expanded ? `Collapse collection ${collection.name}` : `Expand collection ${collection.name}`}
          title={expanded ? `Collapse collection ${collection.name}` : `Expand collection ${collection.name}`}
        >
          <ChevronRight size={14} className={`transition-transform ${expanded ? "rotate-90" : ""}`} />
        </button>
        <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={onSelectCollection}>
          <Folder size={15} className="text-amber-600" />
          <span className="truncate text-sm font-semibold">{collection.name}</span>
        </button>
        <TreeAction label="Rename collection" onClick={() => onRenameCollection(collection)}>
          <Pencil size={13} />
        </TreeAction>
        <TreeAction label="Run collection" onClick={() => onRunCollection(collection)}>
          <Play size={13} />
        </TreeAction>
        <TreeAction label="Delete collection" onClick={() => onDeleteCollection(collection)}>
          <Trash2 size={13} />
        </TreeAction>
      </div>
      {expanded ? (
        <div className="ml-5 border-l border-slate-200 pl-2">
          {collection.folders.map((folder) => (
            <FolderTree
              key={folder.id}
              folder={folder}
              selectedRequestId={selectedRequestId}
              selectedFolderId={selectedFolderId}
              expanded={folderExpanded[folder.id] ?? true}
              folderExpanded={folderExpanded}
              onSelectFolder={onSelectFolder}
              onSelectRequest={onSelectRequest}
              onRenameFolder={onRenameFolder}
              onDeleteFolder={onDeleteFolder}
              onToggleFolder={onToggleFolder}
              onRunFolder={onRunFolder}
              draggedRequestId={draggedRequestId}
              dropTargetFolderId={dropTargetFolderId}
              onRequestDragStart={onRequestDragStart}
              onRequestDragEnd={onRequestDragEnd}
              onFolderDragOver={onFolderDragOver}
              onFolderDragLeave={onFolderDragLeave}
              onFolderDrop={onFolderDrop}
              onRequestContextMenu={onRequestContextMenu}
              renamingRequestId={renamingRequestId}
              onRenameRequest={onRenameRequest}
              onRenameCancel={onRenameCancel}
            />
          ))}
          {collection.requests.map((request) => (
            <RequestTreeItem
              key={request.id}
              request={request}
              selected={selectedRequestId === request.id}
              onSelect={onSelectRequest}
              onDragStart={onRequestDragStart}
              onDragEnd={onRequestDragEnd}
              onContextMenu={onRequestContextMenu}
              renaming={renamingRequestId === request.id}
              onRenameSubmit={onRenameRequest}
              onRenameCancel={onRenameCancel}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function FolderTree({
  folder,
  selectedRequestId,
  selectedFolderId,
  expanded,
  folderExpanded,
  onSelectFolder,
  onSelectRequest,
  onRenameFolder,
  onDeleteFolder,
  onToggleFolder,
  onRunFolder,
  draggedRequestId,
  dropTargetFolderId,
  onRequestDragStart,
  onRequestDragEnd,
  onFolderDragOver,
  onFolderDragLeave,
  onFolderDrop,
  onRequestContextMenu,
  renamingRequestId,
  onRenameRequest,
  onRenameCancel
}: {
  folder: ApiFolder;
  selectedRequestId: string | null;
  selectedFolderId: string | null;
  expanded: boolean;
  folderExpanded: Record<string, boolean>;
  onSelectFolder: (folder: ApiFolder) => void;
  onSelectRequest: (request: ApiRequest) => void;
  onRenameFolder: (folder: ApiFolder) => void;
  onDeleteFolder: (folder: ApiFolder) => void;
  onToggleFolder: (folder: ApiFolder) => void;
  onRunFolder: (folder: ApiFolder) => void;
  draggedRequestId: string | null;
  dropTargetFolderId: string | null;
  onRequestDragStart: (request: ApiRequest) => void;
  onRequestDragEnd: () => void;
  onFolderDragOver: (folder: ApiFolder, requestId: string | null) => void;
  onFolderDragLeave: (folder: ApiFolder) => void;
  onFolderDrop: (folder: ApiFolder, requestId: string | null) => void;
  onRequestContextMenu: (event: React.MouseEvent, request: ApiRequest) => void;
  renamingRequestId: string | null;
  onRenameRequest: (requestId: string, newName: string) => void;
  onRenameCancel: () => void;
}) {
  const selected = selectedFolderId === folder.id;
  const dropActive = draggedRequestId !== null && dropTargetFolderId === folder.id;

  return (
    <div>
      <div
        className={`group flex items-center gap-1 rounded px-2 py-1.5 ${
          selected ? "bg-teal-50 text-teal-800" : "hover:bg-slate-50"
        } ${dropActive ? "bg-amber-50 ring-1 ring-amber-300" : ""}`}
        onDragOver={(event) => {
          const requestId = getDraggedRequestId(event) || draggedRequestId;
          if (!requestId && !hasDraggedRequestType(event)) {
            return;
          }
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          if (requestId) {
            onFolderDragOver(folder, requestId);
          }
        }}
        onDragLeave={(event) => {
          const nextTarget = event.relatedTarget;
          if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
            return;
          }
          onFolderDragLeave(folder);
        }}
        onDrop={(event) => {
          const requestId = getDraggedRequestId(event) || draggedRequestId;
          event.preventDefault();
          onFolderDrop(folder, requestId || null);
        }}
      >
        <button
          type="button"
          className="flex h-6 w-6 items-center justify-center rounded text-slate-400 hover:bg-slate-200 hover:text-slate-600"
          onClick={() => onToggleFolder(folder)}
          aria-label={expanded ? `Collapse folder ${folder.name}` : `Expand folder ${folder.name}`}
          title={expanded ? `Collapse folder ${folder.name}` : `Expand folder ${folder.name}`}
        >
          <ChevronRight size={13} className={`transition-transform ${expanded ? "rotate-90" : ""}`} />
        </button>
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
        <TreeAction label="Run folder" onClick={() => onRunFolder(folder)}>
          <Play size={13} />
        </TreeAction>
        <TreeAction label="Delete folder" onClick={() => onDeleteFolder(folder)}>
          <Trash2 size={13} />
        </TreeAction>
      </div>
      {expanded ? (
        <div className="ml-4 border-l border-slate-200 pl-2">
          {folder.children.map((child) => (
            <FolderTree
              key={child.id}
              folder={child}
              selectedRequestId={selectedRequestId}
              selectedFolderId={selectedFolderId}
              expanded={folderExpanded[child.id] ?? true}
              folderExpanded={folderExpanded}
              onSelectFolder={onSelectFolder}
              onSelectRequest={onSelectRequest}
              onRenameFolder={onRenameFolder}
              onDeleteFolder={onDeleteFolder}
              onToggleFolder={onToggleFolder}
              onRunFolder={onRunFolder}
              draggedRequestId={draggedRequestId}
              dropTargetFolderId={dropTargetFolderId}
              onRequestDragStart={onRequestDragStart}
              onRequestDragEnd={onRequestDragEnd}
              onFolderDragOver={onFolderDragOver}
              onFolderDragLeave={onFolderDragLeave}
              onFolderDrop={onFolderDrop}
              onRequestContextMenu={onRequestContextMenu}
              renamingRequestId={renamingRequestId}
              onRenameRequest={onRenameRequest}
              onRenameCancel={onRenameCancel}
            />
          ))}
          {folder.requests.map((request) => (
            <RequestTreeItem
              key={request.id}
              request={request}
              selected={selectedRequestId === request.id}
              onSelect={onSelectRequest}
              onDragStart={onRequestDragStart}
              onDragEnd={onRequestDragEnd}
              onContextMenu={onRequestContextMenu}
              renaming={renamingRequestId === request.id}
              onRenameSubmit={onRenameRequest}
              onRenameCancel={onRenameCancel}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function RequestTreeItem({
  request,
  selected,
  onSelect,
  onDragStart,
  onDragEnd,
  onContextMenu,
  renaming,
  onRenameSubmit,
  onRenameCancel
}: {
  request: ApiRequest;
  selected: boolean;
  onSelect: (request: ApiRequest) => void;
  onDragStart: (request: ApiRequest) => void;
  onDragEnd: () => void;
  onContextMenu: (event: React.MouseEvent, request: ApiRequest) => void;
  renaming: boolean;
  onRenameSubmit: (requestId: string, newName: string) => void;
  onRenameCancel: () => void;
}) {
  const [editValue, setEditValue] = useState(request.name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renaming && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
    if (!renaming) {
      setEditValue(request.name);
    }
  }, [renaming, request.name]);

  return (
    <div
      className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm ${
        selected ? "bg-teal-600 text-white" : "hover:bg-slate-50"
      }`}
    >
      {renaming ? (
        <input
          ref={inputRef}
          type="text"
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") {
              onRenameSubmit(request.id, editValue);
            } else if (e.key === "Escape") {
              onRenameCancel();
            }
          }}
          onBlur={() => onRenameSubmit(request.id, editValue)}
          className="min-w-0 flex-1 rounded border border-teal-500 px-1 py-0.5 text-sm outline-none"
          autoFocus
        />
      ) : (
        <button
          type="button"
          draggable
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          onClick={() => onSelect(request)}
          onContextMenu={(event) => onContextMenu(event, request)}
          onDragStart={(event) => {
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData(REQUEST_DRAG_DATA_TYPE, request.id);
            event.dataTransfer.setData("text/plain", request.id);
            onDragStart(request);
          }}
          onDragEnd={onDragEnd}
        >
          <FileText size={14} className={selected ? "text-white" : "text-slate-500"} />
          <span className={`font-semibold ${selected ? "text-white" : methodColor(request.method)}`}>{request.method}</span>
          <span className="truncate">{request.name}</span>
        </button>
      )}
    </div>
  );
}

function EnvironmentTreeItem({
  environment,
  selected,
  onSelect,
  onContextMenu,
  renaming,
  onRenameSubmit,
  onRenameCancel
}: {
  environment: ApiEnvironment;
  selected: boolean;
  onSelect: (environmentId: string) => void;
  onContextMenu: (event: React.MouseEvent, environmentId: string) => void;
  renaming: boolean;
  onRenameSubmit: (environmentId: string, newName: string) => void;
  onRenameCancel: () => void;
}) {
  const [editValue, setEditValue] = useState(environment.name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renaming && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
    if (!renaming) {
      setEditValue(environment.name);
    }
  }, [renaming, environment.name]);

  return (
    <div
      className={`mb-1 w-full rounded px-3 py-1.5 text-left text-sm ${
        selected ? "bg-teal-50 font-semibold text-teal-800" : "hover:bg-slate-50"
      }`}
    >
      {renaming ? (
        <input
          ref={inputRef}
          type="text"
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") {
              onRenameSubmit(environment.id, editValue);
            } else if (e.key === "Escape") {
              onRenameCancel();
            }
          }}
          onBlur={() => onRenameSubmit(environment.id, editValue)}
          className="min-w-0 flex-1 rounded border border-teal-500 px-1 py-0.5 text-sm outline-none"
          autoFocus
        />
      ) : (
        <button
          type="button"
          className="flex w-full items-center justify-between gap-2 text-left"
          onClick={() => onSelect(environment.id)}
          onContextMenu={(event) => onContextMenu(event, environment.id)}
        >
          <span className="truncate">{environment.name}</span>
          {environment.active ? (
            <span className="rounded border border-teal-200 bg-teal-50 px-2 py-0.5 text-[11px] font-semibold text-teal-700">
              active
            </span>
          ) : null}
        </button>
      )}
    </div>
  );
}

function CollectionRunnerModal({
  data,
  target,
  initialReport,
  onClose,
  onBeforeRun,
  onRunComplete
}: {
  data: AppData;
  target: CollectionRunnerTarget;
  initialReport: ApiCollectionRunReport | null;
  onClose: () => void;
  onBeforeRun: () => Promise<void>;
  onRunComplete: (report: ApiCollectionRunReport) => Promise<void>;
}) {
  const [environmentId, setEnvironmentId] = useState(data.activeEnvironmentId ?? "");
  const [iterations, setIterations] = useState(1);
  const [delayMs, setDelayMs] = useState(0);
  const [stopOnError, setStopOnError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<ApiCollectionRunReport | null>(initialReport);
  const [requestRows, setRequestRows] = useState(() =>
    flattenRequestsForRunner(data.collections, target).map((request) => ({
      ...request,
      selected: true
    }))
  );

  const selectedCount = requestRows.filter((request) => request.selected).length;

  function moveRequest(index: number, direction: -1 | 1) {
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= requestRows.length) {
      return;
    }

    const nextRows = [...requestRows];
    const [item] = nextRows.splice(index, 1);
    nextRows.splice(nextIndex, 0, item);
    setRequestRows(nextRows);
  }

  async function runCollection() {
    setBusy(true);
    setError(null);
    setReport(null);

    try {
      await onBeforeRun();
      const nextReport = await api<ApiCollectionRunReport>("/api/collection-runs", {
        method: "POST",
        body: JSON.stringify({
          target: {
            type: target.type,
            id: target.id
          },
          activeEnvironmentId: environmentId || null,
          iterations,
          delayMs,
          stopOnError,
          requestIds: requestRows.filter((request) => request.selected).map((request) => request.id)
        })
      });
      setReport(nextReport);
      await onRunComplete(nextReport);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Run failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`Run ${target.type}: ${target.name}`} onClose={onClose}>
      <div className="grid max-h-[78vh] min-h-[560px] grid-cols-[340px_minmax(520px,1fr)] gap-2 overflow-hidden">
        <aside className="min-h-0 overflow-auto rounded border border-slate-200 bg-slate-50 p-2">
          <div className="grid gap-2">
            <label className="grid gap-1 text-sm">
              <span className="font-semibold text-slate-700">Environment</span>
              <select
                className="h-8 rounded border border-slate-300 bg-white px-3 text-sm"
                value={environmentId}
                onChange={(event) => setEnvironmentId(event.target.value)}
              >
                <option value="">No environment</option>
                {data.environments.map((environment) => (
                  <option key={environment.id} value={environment.id}>
                    {environment.name}
                  </option>
                ))}
              </select>
            </label>

            <div className="grid grid-cols-2 gap-2">
              <label className="grid gap-1 text-sm">
                <span className="font-semibold text-slate-700">Iterations</span>
                <input
                  type="number"
                  min={1}
                  max={100}
                  className="h-8 rounded border border-slate-300 bg-white px-3 text-sm"
                  value={iterations}
                  onChange={(event) => setIterations(clamp(Number(event.target.value) || 1, 1, 100))}
                />
              </label>
              <label className="grid gap-1 text-sm">
                <span className="font-semibold text-slate-700">Delay (ms)</span>
                <input
                  type="number"
                  min={0}
                  max={60000}
                  className="h-8 rounded border border-slate-300 bg-white px-3 text-sm"
                  value={delayMs}
                  onChange={(event) => setDelayMs(clamp(Number(event.target.value) || 0, 0, 60000))}
                />
              </label>
            </div>

            <label className="flex items-center gap-2 rounded border border-slate-200 bg-white px-3 py-1.5 text-sm">
              <input
                type="checkbox"
                checked={stopOnError}
                onChange={(event) => setStopOnError(event.target.checked)}
              />
              <span>Stop on runtime error</span>
            </label>

            <div className="rounded border border-slate-200 bg-white">
              <div className="flex items-center justify-between border-b border-slate-200 px-3 py-1.5">
                <span className="text-sm font-semibold text-slate-700">Requests</span>
                <span className="text-xs text-slate-500">{selectedCount} selected</span>
              </div>
              <div className="max-h-[420px] overflow-auto p-2">
                {requestRows.map((request, index) => (
                  <div key={request.id} className="mb-2 rounded border border-slate-200 bg-slate-50 p-2 last:mb-0">
                    <div className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={request.selected}
                        onChange={(event) =>
                          setRequestRows((rows) =>
                            rows.map((row) =>
                              row.id === request.id ? { ...row, selected: event.target.checked } : row
                            )
                          )
                        }
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className={`text-xs font-semibold ${methodColor(request.method)}`}>{request.method}</span>
                          <span className="truncate text-sm font-medium text-slate-800">{request.name}</span>
                        </div>
                        <div className="truncate text-xs text-slate-500">
                          {request.path.length ? request.path.join(" / ") : "Root"}
                        </div>
                      </div>
                      <div className="grid gap-1">
                        <button
                          type="button"
                          className="rounded border border-slate-200 bg-white p-1 text-slate-600 hover:bg-slate-100"
                          onClick={() => moveRequest(index, -1)}
                          aria-label="Move request up"
                        >
                          <ChevronUp size={14} />
                        </button>
                        <button
                          type="button"
                          className="rounded border border-slate-200 bg-white p-1 text-slate-600 hover:bg-slate-100"
                          onClick={() => moveRequest(index, 1)}
                          aria-label="Move request down"
                        >
                          <ChevronDown size={14} />
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <button
              className="inline-flex h-10 items-center justify-center gap-2 rounded bg-teal-600 px-4 text-sm font-semibold text-white hover:bg-teal-700 disabled:opacity-50"
              onClick={() => void runCollection()}
              disabled={busy || selectedCount === 0}
            >
              {busy ? <Loader2 className="animate-spin" size={16} /> : <Play size={16} />}
              Run now
            </button>
            {error ? <div className="rounded border border-rose-200 bg-rose-50 p-2 text-sm text-rose-700">{error}</div> : null}
          </div>
        </aside>

        <div className="min-h-0 overflow-auto pr-1">
          {report ? <CollectionRunReportView report={report} /> : <p className="text-sm text-slate-500">Configure the run and execute it to see the full summary, script logs, and per-request details here.</p>}
        </div>
      </div>
    </Modal>
  );
}

function CollectionRunReportView({ report }: { report: ApiCollectionRunReport }) {
  return (
    <div className="flex min-h-0 flex-col gap-2">
      <EditorSection title="Summary">
        <div className="mb-2 flex flex-wrap gap-2">
          <SummaryChip label="Status" value={report.run.status} tone={report.run.errorCount ? "amber" : "teal"} />
          <SummaryChip label="Steps" value={`${report.run.completedSteps}/${report.run.totalSteps}`} />
          <SummaryChip label="Success" value={String(report.run.successCount)} tone="teal" />
          <SummaryChip label="Errors" value={String(report.run.errorCount)} tone={report.run.errorCount ? "amber" : "slate"} />
        </div>
        <div className="grid gap-2 text-sm text-slate-600">
          <PreviewRow label="Target" value={`${report.run.targetType}: ${report.run.targetName}`} />
          <PreviewRow label="Iterations" value={String(report.run.iterations)} />
          <PreviewRow label="Delay" value={`${report.run.delayMs} ms`} />
          <PreviewRow label="Finished" value={report.run.finishedAt ?? "Running"} />
        </div>
      </EditorSection>

      <EditorSection title="Steps">
        <div className="min-h-0 max-h-[48vh] overflow-auto pr-1">
          <div className="grid gap-2">
            {report.steps.map((step) => (
              <details key={step.id} className="group rounded border border-slate-200 bg-slate-50 p-2" open={Boolean(step.error)}>
                <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-semibold text-slate-700">
                  <ChevronRight className="shrink-0 transition-transform group-open:rotate-90" size={16} />
                  <span>{step.sequence}. {step.requestName}</span>
                  <span className={`rounded-full bg-white px-2 py-0.5 text-xs ${methodColor(step.method)}`}>{step.method}</span>
                  <span className={`rounded-full px-2 py-0.5 text-xs ${step.error ? "bg-rose-100 text-rose-700" : "bg-teal-100 text-teal-700"}`}>
                    {step.error ? "error" : step.status ?? "ok"}
                  </span>
                  <span className="ml-auto text-xs text-slate-500">iteration {step.iteration}</span>
                </summary>
                <div className="mt-2 grid gap-2">
                  <div className="flex flex-wrap gap-2">
                    {step.resolvedUrl ? <SummaryChip label="URL" value={step.resolvedUrl} /> : null}
                    {step.durationMs !== null ? <SummaryChip label="Time" value={`${step.durationMs} ms`} tone="amber" /> : null}
                    {step.sizeBytes !== null ? <SummaryChip label="Size" value={formatSize(step.sizeBytes)} /> : null}
                  </div>
                  {step.error ? (
                    <div className="rounded border border-rose-200 bg-rose-50 p-2 text-sm text-rose-700">{step.error}</div>
                  ) : null}
                  {step.missingVariables.length ? (
                    <div className="rounded border border-amber-200 bg-amber-50 p-2 text-sm text-amber-800">
                      Missing variables: {step.missingVariables.join(", ")}
                    </div>
                  ) : null}
                  <ScriptResultsPanel results={step.scriptResults} />
                  {step.responseBodyPreview ? (
                    <EditorSection title="Response Preview">
                      <pre className="max-h-60 overflow-auto rounded bg-slate-950 p-2 font-mono text-xs text-slate-50">
                        {formatBodyPreview(step.responseBodyPreview)}
                      </pre>
                    </EditorSection>
                  ) : null}
                </div>
              </details>
            ))}
          </div>
        </div>
      </EditorSection>
    </div>
  );
}

function EnvironmentWorkspace({
  data,
  selectedEnvironmentId,
  onSelectEnvironment,
  onBackToRequests,
  onCreateEnvironment,
  onRefresh,
  onDeleteEnvironment
}: {
  data: AppData;
  selectedEnvironmentId: string | null;
  onSelectEnvironment: (environmentId: string | null) => void;
  onBackToRequests: () => void;
  onCreateEnvironment: () => Promise<void>;
  onRefresh: () => Promise<void>;
  onDeleteEnvironment: (environmentId: string) => void;
}) {
  const selectedEnv = data.environments.find((environment) => environment.id === selectedEnvironmentId) ?? null;
  const [globalRows, setGlobalRows] = useState<VariableValue[]>(data.globalVariables);
  const [envRows, setEnvRows] = useState<VariableValue[]>(selectedEnv?.variables ?? []);
  useEffect(() => {
    const nextEnv = data.environments.find((environment) => environment.id === selectedEnvironmentId) ?? null;
    setEnvRows(nextEnv?.variables ?? []);
  }, [data.environments, selectedEnvironmentId]);

  async function deleteEnvironment() {
    if (!selectedEnv) {
      return;
    }

    onDeleteEnvironment(selectedEnv.id);
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
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[var(--surface-2)]">
      <div className="border-b border-slate-200 bg-white p-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-slate-700">Environments</h2>
            <p className="text-xs text-slate-500">Manage global and scoped variables.</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              className="inline-flex h-8 items-center gap-2 rounded border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-700 hover:bg-slate-50"
              onClick={onBackToRequests}
              type="button"
            >
              <ChevronLeft size={15} />
              Back to requests
            </button>
            <button
              className="inline-flex h-8 items-center gap-2 rounded bg-teal-600 px-3 text-sm font-semibold text-white hover:bg-teal-700"
              onClick={() => void onCreateEnvironment()}
              type="button"
            >
              <Plus size={15} />
              New environment
            </button>
          </div>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-2">
          <select
            className="h-8 min-w-64 rounded border border-slate-300 bg-white px-3 text-sm font-semibold"
            value={selectedEnvironmentId ?? ""}
            onChange={(event) => onSelectEnvironment(event.target.value || null)}
            aria-label="Selected environment"
          >
            {data.environments.map((environment) => (
              <option key={environment.id} value={environment.id}>
                {environment.name}
              </option>
            ))}
          </select>
          <button
            className="inline-flex h-8 items-center gap-2 rounded border border-rose-200 bg-white px-3 text-sm font-semibold text-rose-700 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50"
            onClick={deleteEnvironment}
            disabled={!selectedEnv}
            type="button"
          >
            <Trash2 size={15} />
            Delete
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-2">
        <div className="grid gap-2">
          <EditorSection title="Global Variables">
            <VariableTable rows={globalRows} onChange={setGlobalRows} />
            <button
              className="mt-2 inline-flex h-8 items-center gap-2 rounded border border-slate-300 bg-white px-3 text-sm font-semibold hover:bg-slate-50"
              onClick={saveGlobals}
              type="button"
            >
              <Save size={15} />
              Save globals
            </button>
          </EditorSection>

          <EditorSection title="Environment Variables">
            {selectedEnv ? (
              <>
                <VariableTable rows={envRows} onChange={setEnvRows} />
                <button
                  className="mt-2 inline-flex h-8 items-center gap-2 rounded bg-teal-600 px-3 text-sm font-semibold text-white hover:bg-teal-700"
                  onClick={saveEnvironment}
                  type="button"
                >
                  <Save size={15} />
                  Save environment
                </button>
              </>
            ) : (
              <div className="grid gap-2">
                <p className="text-sm text-slate-500">Create an environment to manage scoped variables.</p>
                <button
                  className="inline-flex h-8 w-fit items-center gap-2 rounded bg-teal-600 px-3 text-sm font-semibold text-white hover:bg-teal-700"
                  onClick={() => void onCreateEnvironment()}
                  type="button"
                >
                  <Plus size={15} />
                  Create environment
                </button>
              </div>
            )}
          </EditorSection>
        </div>
      </div>
    </div>
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
            className="h-8 w-5"
            checked={row.enabled}
            onChange={(event) => updateRow(index, { enabled: event.target.checked })}
          />
          <input
            className="h-8 rounded border border-slate-300 px-2 font-mono text-sm"
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
            className="h-8 w-5"
            checked={row.isSecret}
            onChange={(event) => updateRow(index, { isSecret: event.target.checked })}
          />
          <IconButton label="Remove variable" onClick={() => onChange(rows.filter((_, rowIndex) => rowIndex !== index))}>
            <Trash2 size={15} />
          </IconButton>
        </div>
      ))}
      <button
        className="inline-flex h-8 w-fit items-center gap-2 rounded border border-slate-300 bg-white px-3 text-sm font-medium hover:bg-slate-50"
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
      <div className="grid max-h-[78vh] min-h-[560px] grid-cols-[minmax(420px,1fr)_300px] gap-2 overflow-hidden">
        <div className="flex min-h-0 flex-col gap-2">
          <input
            type="file"
            accept=".json,application/json"
            className="text-sm"
            onChange={(event) => void loadFile(event.target.files?.[0] ?? null)}
          />
          <textarea
            className="min-h-0 flex-1 resize-none rounded border border-slate-300 p-2 font-mono text-xs"
            value={rawText}
            onChange={(event) => {
              setRawText(event.target.value);
              setPreview(null);
            }}
            placeholder="Paste a Postman Collection v2.1 or Environment JSON here."
          />
          <div className="flex gap-2">
            <button
              className="inline-flex h-8 items-center gap-2 rounded border border-slate-300 bg-white px-3 text-sm font-semibold hover:bg-slate-50 disabled:opacity-50"
              onClick={previewImport}
              disabled={busy || !rawText.trim()}
            >
              <FileJson size={15} />
              Preview
            </button>
            <button
              className="inline-flex h-8 items-center gap-2 rounded bg-teal-600 px-3 text-sm font-semibold text-white hover:bg-teal-700 disabled:opacity-50"
              onClick={importJson}
              disabled={busy || !preview || preview.type === "unknown"}
            >
              {busy ? <Loader2 className="animate-spin" size={15} /> : <Upload size={15} />}
              Import
            </button>
          </div>
        </div>
        <aside className="overflow-auto rounded border border-slate-200 bg-slate-50 p-2">
          <h3 className="mb-2 text-sm font-semibold">Preview</h3>
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

function SuccessResponse({ response, body }: { response: SendSuccessResponseState; body: string }) {
  const [bodyViewMode, setBodyViewMode] = useState<BodyViewMode>("pretty");
  const [copied, setCopied] = useState(false);
  const [bodySearch, setBodySearch] = useState("");
  const [bodySearchMatch, setBodySearchMatch] = useState(0);
  const bodyRef = useRef<HTMLPreElement | null>(null);

  async function copyBody() {
    try {
      await navigator.clipboard.writeText(body);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  }

  async function downloadBody() {
    try {
      let blob: Blob;
      if (response.bodyBase64) {
        const binary = atob(response.bodyBase64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }
        blob = new Blob([bytes], { type: response.contentType || "application/octet-stream" });
      } else {
        blob = new Blob([body], { type: response.contentType || "text/plain" });
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const ext = response.contentType.includes("pdf") ? "pdf" : response.contentType.includes("json") ? "json" : response.contentType.includes("xml") ? "xml" : response.contentType.includes("html") ? "html" : "bin";
      a.download = `response.${ext}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {
      // ignore
    }
  }

  const bodySearchResults = useMemo(() => {
    if (!bodySearch.trim()) return [];
    const lowerBody = body.toLowerCase();
    const lowerQuery = bodySearch.toLowerCase();
    const indices: number[] = [];
    let idx = 0;
    while (true) {
      const found = lowerBody.indexOf(lowerQuery, idx);
      if (found === -1) break;
      indices.push(found);
      idx = found + 1;
    }
    return indices;
  }, [body, bodySearch]);

  const currentBodySearchMatch = clamp(bodySearchMatch, 0, Math.max(bodySearchResults.length - 1, 0));

  const highlightedBody = useMemo(() => {
    if (!bodySearch.trim() || bodySearchResults.length === 0) return null;
    const parts: ReactNode[] = [];
    let lastIndex = 0;
    for (let i = 0; i < bodySearchResults.length; i++) {
      const matchIdx = bodySearchResults[i];
      if (matchIdx > lastIndex) {
        parts.push(body.slice(lastIndex, matchIdx));
      }
      const isActive = i === currentBodySearchMatch;
      parts.push(
        <mark
          key={matchIdx}
          className={isActive ? "bg-amber-300 text-slate-900" : "bg-yellow-200 text-slate-800"}
        >
          {body.slice(matchIdx, matchIdx + bodySearch.length)}
        </mark>
      );
      lastIndex = matchIdx + bodySearch.length;
    }
    if (lastIndex < body.length) {
      parts.push(body.slice(lastIndex));
    }
    return parts;
  }, [body, bodySearch, bodySearchResults, currentBodySearchMatch]);

  const displayedBody = highlightedBody ?? body;

  return (
    <div className="grid gap-2">
      <ScriptResultsPanel results={response.scriptResults ?? []} />
      <EditorSection title="Response Body">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded border border-slate-200 bg-slate-50 p-1">
            {(["pretty", "edit"] as const).map((mode) => {
              const active = bodyViewMode === mode;

              return (
                <button
                  key={mode}
                  className={`rounded px-3 py-1.5 text-xs font-semibold transition ${
                    active
                      ? "bg-white text-teal-700 shadow-sm"
                      : "text-slate-600 hover:bg-white/70 hover:text-slate-900"
                  }`}
                  onClick={() => setBodyViewMode(mode)}
                  type="button"
                >
                  {mode === "pretty" ? "Pretty" : "Raw"}
                </button>
              );
            })}
          </div>
          <input
            type="text"
            className="h-7 w-40 rounded border border-slate-300 px-2 text-xs font-mono outline-none focus:border-teal-500"
            placeholder="Search in body..."
            value={bodySearch}
            onChange={(event) => { setBodySearch(event.target.value); setBodySearchMatch(0); }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                if (event.shiftKey) {
                  setBodySearchMatch((current) => Math.max(current - 1, 0));
                } else {
                  setBodySearchMatch((current) => Math.min(current + 1, Math.max(bodySearchResults.length - 1, 0)));
                }
              }
            }}
            aria-label="Search in response body"
          />
          {bodySearch.trim() ? (
            <span className="text-xs text-slate-500">
              {bodySearchResults.length > 0
                ? `${currentBodySearchMatch + 1}/${bodySearchResults.length}`
                : "No matches"}
            </span>
          ) : null}
          <button
            className="inline-flex items-center gap-1 rounded px-2.5 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-100"
            onClick={downloadBody}
            type="button"
            title="Download response body"
          >
            <Download size={14} />
            Download
          </button>
          <button
            className="ml-auto inline-flex items-center gap-1 rounded px-2.5 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-100"
            onClick={copyBody}
            type="button"
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        {bodyViewMode === "pretty" ? (
          <PrettyBody
            body={body}
            contentType={response.contentType}
            searchQuery={bodySearch.trim() || undefined}
            searchResults={bodySearchResults.length > 0 ? bodySearchResults : undefined}
            currentSearchMatch={currentBodySearchMatch}
          />
        ) : (
          <pre ref={bodyRef} className="max-h-[560px] overflow-auto whitespace-pre-wrap rounded bg-slate-950 p-2 font-mono text-xs text-slate-50">
            {displayedBody}
          </pre>
        )}
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
  const responseSummary = response && !("error" in response) ? response : null;
  const [showHeadersModal, setShowHeadersModal] = useState(false);

  return (
    <aside className="flex h-full min-h-0 flex-col border-t border-slate-200 bg-white">
      <div className="flex h-8 items-center gap-2 border-b border-slate-200 px-3">
        <span className="shrink-0 text-sm font-semibold text-slate-700">Response</span>
        {responseSummary ? (
          <ResponseSummary response={responseSummary} onOpenHeaders={() => setShowHeadersModal(true)} />
        ) : null}
        {response && "error" in response ? (
          <span className="truncate rounded-full border border-rose-200 bg-rose-50 px-2 py-1 text-xs font-semibold text-rose-700">
            {response.error}
          </span>
        ) : null}
        <div className="ml-auto shrink-0">{busy ? <Loader2 className="animate-spin text-teal-600" size={18} /> : null}</div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-1.5">
        {response ? (
          "error" in response ? (
            <ErrorResponse response={response} />
          ) : (
            <SuccessResponse response={response} body={body} />
          )
        ) : null}
      </div>
      {responseSummary && showHeadersModal ? (
        <ResponseHeadersModal headers={responseSummary.headers} onClose={() => setShowHeadersModal(false)} />
      ) : null}
    </aside>
  );
}

function ErrorResponse({
  response
}: {
  response: SendErrorResponseState;
}) {
  return (
    <div className="grid gap-2">
      <ScriptResultsPanel results={response.scriptResults ?? []} />
      <div className="rounded border border-rose-200 bg-rose-50 p-2 text-sm text-rose-700">
        <div className="font-semibold">{response.error}</div>
        {response.durationMs ? <div>{response.durationMs} ms</div> : null}
      </div>
      {response.missingVariables?.length ? (
        <div className="rounded border border-amber-200 bg-amber-50 p-2 text-sm text-amber-800">
          Missing variables: {response.missingVariables.join(", ")}
        </div>
      ) : null}
      {response.resolvedDraft ? (
        <EditorSection title="Resolved Draft">
          <pre className="rounded bg-slate-950 p-2 font-mono text-xs text-slate-50">
            {JSON.stringify(response.resolvedDraft, null, 2)}
          </pre>
        </EditorSection>
      ) : null}
    </div>
  );
}

function ScriptResultsPanel({ results }: { results: ScriptExecutionResult[] }) {
  if (results.length === 0) {
    return null;
  }

  return (
    <div className="grid gap-2">
      {results.map((result, index) => (
        <details
          key={`${result.phase}-${result.source ?? "request"}-${index}`}
          className={`group rounded border p-2 ${
            result.ok ? "border-teal-200 bg-teal-50" : "border-rose-200 bg-rose-50"
          }`}
          open={!result.ok}
        >
          <summary
            className={`flex cursor-pointer list-none items-center gap-2 text-sm font-semibold ${
              result.ok ? "text-teal-800" : "text-rose-800"
            }`}
          >
            <ChevronRight className="shrink-0 transition-transform group-open:rotate-90" size={16} />
            <span>{result.source ? `${result.source}` : result.phase}</span>
            <span>{result.ok ? "ok" : "failed"}</span>
          </summary>
          <div className="mt-2 grid gap-2">
            {result.error ? <div className="text-sm font-medium text-rose-700">{result.error}</div> : null}
            {result.logs.length ? (
              <pre className="max-h-48 overflow-auto rounded bg-slate-950 p-2 font-mono text-xs text-slate-50">
                {result.logs.join("\n")}
              </pre>
            ) : (
              <div className="text-xs text-slate-500">No logs.</div>
            )}
          </div>
        </details>
      ))}
    </div>
  );
}

function ResponseSummary({
  response,
  onOpenHeaders
}: {
  response: SendResult;
  onOpenHeaders: () => void;
}) {
  return (
    <div className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap">
      <div className="inline-flex items-center gap-2 text-xs text-slate-600">
        <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 ${statusColor(response.status)}`}>
          <span className="uppercase tracking-wide text-[10px] font-medium">Status</span>
          <span className="max-w-[14rem] truncate font-semibold">{response.status} {response.statusText}</span>
        </span>
        <SummaryChip label="Time" value={`${response.durationMs} ms`} tone="amber" />
        <SummaryChip label="Size" value={formatSize(response.sizeBytes)} />
        <SummaryChip label="Type" value={response.contentType || "unknown"} />
        <button
          className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-slate-200 bg-white px-2.5 py-1 font-medium text-slate-600 transition hover:border-slate-300 hover:text-slate-800"
          onClick={onOpenHeaders}
          type="button"
        >
          <span>Headers</span>
          <span className="text-slate-400">{response.headers.length}</span>
        </button>
      </div>
    </div>
  );
}

function ResponseHeadersModal({
  headers,
  onClose
}: {
  headers: KeyValueRow[];
  onClose: () => void;
}) {
  const [rawView, setRawView] = useState(false);

  return (
    <Modal title={`Response Headers (${headers.length})`} onClose={onClose}>
      <div className="mb-2 flex items-center gap-2">
        <div className="inline-flex rounded border border-slate-200 bg-slate-50 p-1">
          {([false, true] as const).map((raw) => {
            const active = rawView === raw;
            return (
              <button
                key={String(raw)}
                className={`rounded px-3 py-1.5 text-xs font-semibold transition ${active ? "bg-white text-teal-700 shadow-sm" : "text-slate-600 hover:bg-white/70"}`}
                onClick={() => setRawView(raw)}
                type="button"
              >
                {raw ? "Raw" : "Preview"}
              </button>
            );
          })}
        </div>
      </div>
      {headers.length ? (
        rawView ? (
          <pre className="max-h-[65vh] overflow-auto rounded bg-slate-950 p-2 font-mono text-xs text-slate-50">
            {headers.map((header) => `${header.key}: ${header.value}`).join("\n")}
          </pre>
        ) : (
          <div className="grid max-h-[65vh] gap-2 overflow-auto text-sm">
            {headers.map((header) => (
              <div
                key={`${header.key}-${header.value}`}
                className="grid gap-1 rounded border border-slate-200 bg-slate-50 p-2 md:grid-cols-[180px_1fr] md:gap-2"
              >
                <span className="font-semibold text-slate-700">{header.key}</span>
                <span className="break-all font-mono text-xs text-slate-700 md:text-sm">{header.value}</span>
              </div>
            ))}
          </div>
        )
      ) : (
        <div className="text-sm text-slate-500">No headers returned.</div>
      )}
    </Modal>
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 p-4">
      <div className="w-full max-w-5xl rounded bg-white shadow-2xl">
        <div className="flex h-10 items-center justify-between border-b border-slate-200 px-4">
          <h2 className="text-sm font-semibold">{title}</h2>
          <button className="rounded px-2 py-1 text-sm text-slate-500 hover:bg-slate-100" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="p-2">{children}</div>
      </div>
    </div>
  );
}

function CookiesModal({
  onClose,
  onNotice
}: {
  onClose: () => void;
  onNotice: (message: string | null) => void;
}) {
  const [cookies, setCookies] = useState<ApiCookie[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyCookieId, setBusyCookieId] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);

  const loadCookies = useCallback(async () => {
    setLoading(true);
    try {
      setCookies(await api<ApiCookie[]>("/api/cookies"));
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "Could not load cookies.");
    } finally {
      setLoading(false);
    }
  }, [onNotice]);

  useEffect(() => {
    void loadCookies();
  }, [loadCookies]);

  async function removeCookie(cookie: ApiCookie) {
    setBusyCookieId(cookie.id);
    try {
      await api(`/api/cookies?id=${encodeURIComponent(cookie.id)}`, { method: "DELETE" });
      setCookies((current) => current.filter((item) => item.id !== cookie.id));
      onNotice(`Cookie "${cookie.name}" deleted.`);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "Could not delete cookie.");
    } finally {
      setBusyCookieId(null);
    }
  }

  async function clearAllCookies() {
    if (!cookies.length) {
      return;
    }

    setClearing(true);
    try {
      await api("/api/cookies", { method: "DELETE" });
      setCookies([]);
      onNotice("Cookies cleared.");
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "Could not clear cookies.");
    } finally {
      setClearing(false);
    }
  }

  return (
    <Modal title={`Cookies (${cookies.length})`} onClose={onClose}>
      <div className="flex max-h-[70vh] flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <div className="text-sm text-slate-500">
            Cookies captured from response headers are sent automatically on matching requests.
          </div>
          <div className="flex shrink-0 gap-2">
            <button
              type="button"
              className="inline-flex h-8 items-center gap-2 rounded border border-slate-300 bg-white px-3 text-sm text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => void loadCookies()}
              disabled={loading}
            >
              {loading ? <Loader2 className="animate-spin" size={15} /> : <RotateCw size={15} />}
              Refresh
            </button>
            <button
              type="button"
              className="inline-flex h-8 items-center gap-2 rounded border border-red-200 bg-red-50 px-3 text-sm text-red-700 hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => void clearAllCookies()}
              disabled={!cookies.length || clearing}
            >
              {clearing ? <Loader2 className="animate-spin" size={15} /> : <Trash2 size={15} />}
              Clear all
            </button>
          </div>
        </div>

        <div className="min-h-0 overflow-auto rounded border border-slate-200">
          {loading ? (
            <LoadingBlock label="Loading cookies" />
          ) : cookies.length ? (
            <table className="min-w-full text-left text-sm">
              <thead className="sticky top-0 bg-slate-50 text-xs uppercase text-slate-500">
                <tr>
                  <th className="px-3 py-1.5 font-semibold">Name</th>
                  <th className="px-3 py-1.5 font-semibold">Value</th>
                  <th className="px-3 py-1.5 font-semibold">Domain</th>
                  <th className="px-3 py-1.5 font-semibold">Path</th>
                  <th className="px-3 py-1.5 font-semibold">Expires</th>
                  <th className="px-3 py-1.5 font-semibold">Flags</th>
                  <th className="w-12 px-2 py-1.5" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {cookies.map((cookie) => (
                  <tr key={cookie.id} className="align-top">
                    <td className="max-w-44 px-3 py-1.5 font-mono font-semibold text-slate-800">
                      <span className="block truncate" title={cookie.name}>{cookie.name}</span>
                    </td>
                    <td className="max-w-60 px-3 py-1.5 font-mono text-slate-600">
                      <span className="block truncate" title={cookie.value}>{cookie.value}</span>
                    </td>
                    <td className="max-w-52 px-3 py-1.5 text-slate-700">
                      <span className="block truncate" title={cookie.domain}>
                        {cookie.hostOnly ? cookie.domain : `.${cookie.domain}`}
                      </span>
                    </td>
                    <td className="px-3 py-1.5 font-mono text-slate-600">{cookie.path}</td>
                    <td className="px-3 py-1.5 text-slate-600">
                      {cookie.expiresAt ? formatDateTime(cookie.expiresAt) : "Session"}
                    </td>
                    <td className="px-3 py-1.5">
                      <div className="flex flex-wrap gap-1">
                        {cookie.httpOnly ? <CookieFlag label="HttpOnly" /> : null}
                        {cookie.secure ? <CookieFlag label="Secure" /> : null}
                        {cookie.sameSite ? <CookieFlag label={`SameSite=${cookie.sameSite}`} /> : null}
                        {cookie.hostOnly ? <CookieFlag label="Host only" /> : null}
                      </div>
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      <IconButton label={`Delete ${cookie.name}`} onClick={() => void removeCookie(cookie)}>
                        {busyCookieId === cookie.id ? <Loader2 className="animate-spin" size={15} /> : <Trash2 size={15} />}
                      </IconButton>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="px-4 py-8 text-center text-sm text-slate-500">No cookies captured yet.</div>
          )}
        </div>
      </div>
    </Modal>
  );
}

function CookieFlag({ label }: { label: string }) {
  return (
    <span className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[11px] font-medium text-slate-600">
      {label}
    </span>
  );
}

function ConfirmDialog({
  message,
  onConfirm,
  onCancel
}: {
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 p-4">
      <div className="w-full max-w-sm rounded bg-white shadow-2xl">
        <div className="p-4">
          <p className="text-sm text-slate-700">{message}</p>
          <div className="mt-6 flex justify-end gap-2">
            <button
              type="button"
              className="h-8 rounded border border-slate-300 bg-white px-4 text-sm text-slate-700 hover:bg-slate-50"
              onClick={onCancel}
            >
              Cancel
            </button>
            <button
              type="button"
              className="h-8 rounded bg-red-600 px-4 text-sm text-white hover:bg-red-700"
              onClick={onConfirm}
            >
              Delete
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function PromptDialog({
  message,
  defaultValue,
  onConfirm,
  onCancel
}: {
  message: string;
  defaultValue: string;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(defaultValue);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 p-4">
      <div className="w-full max-w-sm rounded bg-white shadow-2xl">
        <div className="p-4">
          <p className="mb-2 text-sm text-slate-700">{message}</p>
          <input
            ref={inputRef}
            type="text"
            className="w-full rounded border border-slate-300 px-3 py-1.5 text-sm"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && value) {
                onConfirm(value);
              } else if (event.key === "Escape") {
                onCancel();
              }
            }}
          />
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              className="h-8 rounded border border-slate-300 bg-white px-4 text-sm text-slate-700 hover:bg-slate-50"
              onClick={onCancel}
            >
              Cancel
            </button>
            <button
              type="button"
              className="h-8 rounded bg-teal-600 px-4 text-sm text-white hover:bg-teal-700 disabled:opacity-50"
              onClick={() => onConfirm(value)}
              disabled={!value}
            >
              Confirm
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function EditorSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded border border-slate-200 bg-white p-1.5 shadow-panel">
      <h2 className="mb-1 text-sm font-semibold text-slate-700">{title}</h2>
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
      className="inline-flex h-8 w-8 items-center justify-center rounded border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
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
    <div className="grid justify-items-center gap-2 text-center">
      <p className="text-sm font-semibold text-slate-700">{title}</p>
      <button
        className="inline-flex h-8 items-center gap-2 rounded bg-teal-600 px-3 text-sm font-semibold text-white hover:bg-teal-700"
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
    <div className="flex items-center gap-2 px-2 py-1.5 text-sm text-slate-500">
      <Loader2 className="animate-spin" size={16} />
      {label}
    </div>
  );
}

function SummaryChip({
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
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 ${color}`}>
      <span className="uppercase tracking-wide text-[10px] font-medium">{label}</span>
      <span className="max-w-[14rem] truncate font-semibold">{value}</span>
    </span>
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
  variableLookup = {},
  onChange
}: {
  value: string;
  isSecret: boolean;
  showSecrets: boolean;
  variableLookup?: VariableLookup;
  onChange: (value: string) => void;
}) {
  if (isSecret && !showSecrets) {
    return (
      <input
        className="h-8 rounded border border-slate-300 px-2 font-mono text-sm"
        value={maskSecret(value)}
        readOnly
      />
    );
  }

  return (
    <TokenizedField
      className="px-2"
      value={value}
      onChange={onChange}
      aria-label="Row value"
      variableLookup={variableLookup}
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

function findFolder(collections: ApiCollection[], folderId: string): ApiFolder | null {
  for (const collection of collections) {
    const folder = findFolderInFolders(collection.folders, folderId);
    if (folder) {
      return folder;
    }
  }

  return null;
}

function findFolderPath(collections: ApiCollection[], folderId: string): { collectionId: string; folderIds: string[] } | null {
  for (const collection of collections) {
    const folderIds = findFolderPathInFolders(collection.folders, folderId);
    if (folderIds) {
      return { collectionId: collection.id, folderIds };
    }
  }

  return null;
}

function findFolderPathInFolders(folders: ApiFolder[], folderId: string): string[] | null {
  for (const folder of folders) {
    if (folder.id === folderId) {
      return [folder.id];
    }

    const nested = findFolderPathInFolders(folder.children, folderId);
    if (nested) {
      return [folder.id, ...nested];
    }
  }

  return null;
}

function findFolderInFolders(folders: ApiFolder[], folderId: string): ApiFolder | null {
  for (const folder of folders) {
    if (folder.id === folderId) {
      return folder;
    }

    const nested = findFolderInFolders(folder.children, folderId);
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

function isFolderDescendant(
  collections: ApiCollection[],
  folderId: string | null | undefined,
  ancestorId: string
): boolean {
  if (!folderId) {
    return false;
  }

  const folder = findFolder(collections, ancestorId);
  return folder ? hasFolderDescendant(folder, folderId) : false;
}

function hasFolderDescendant(folder: ApiFolder, folderId: string): boolean {
  for (const child of folder.children) {
    if (child.id === folderId || hasFolderDescendant(child, folderId)) {
      return true;
    }
  }

  return false;
}

function flattenRequestsForRunner(collections: ApiCollection[], target: CollectionRunnerTarget) {
  const rows: Array<{ id: string; name: string; method: HttpMethod; path: string[] }> = [];

  const visitFolder = (folder: ApiFolder, path: string[]) => {
    for (const child of folder.children) {
      visitFolder(child, [...path, child.name]);
    }

    for (const request of folder.requests) {
      rows.push({
        id: request.id,
        name: request.name,
        method: request.method,
        path
      });
    }
  };

  if (target.type === "folder") {
    const folder = findFolder(collections, target.id);
    if (!folder) {
      return rows;
    }
    visitFolder(folder, [folder.name]);
    return rows;
  }

  const collection = collections.find((entry) => entry.id === target.id);
  if (!collection) {
    return rows;
  }

  for (const folder of collection.folders) {
    visitFolder(folder, [folder.name]);
  }
  for (const request of collection.requests) {
    rows.push({
      id: request.id,
      name: request.name,
      method: request.method,
      path: []
    });
  }

  return rows;
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
    preRequestScript: request.preRequestScript,
    postRequestScript: request.postRequestScript,
    auth: { ...request.auth }
  };
}

function cloneDraftDraft(draft: RequestDraft): RequestDraft {
  return {
    id: draft.id,
    collectionId: draft.collectionId,
    folderId: draft.folderId,
    name: draft.name,
    method: draft.method,
    url: draft.url,
    headers: draft.headers.map((row) => ({ ...row })),
    queryParams: draft.queryParams.map((row) => ({ ...row })),
    bodyMode: draft.bodyMode,
    bodyRaw: draft.bodyRaw,
    preRequestScript: draft.preRequestScript,
    postRequestScript: draft.postRequestScript,
    auth: { ...draft.auth }
  };
}

function createOpenRequestTab(request: ApiRequest, tabId = createRequestTabId()): OpenRequestTab {
  return {
    tabId,
    requestId: request.id,
    draft: cloneDraft(request),
    response: null,
    busy: false,
    dirty: false,
    saving: false
  };
}

function createRequestTabId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }

  return `tab-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function cloneSendResponse(response: SendResponseState | null): SendResponseState | null {
  return response ? (JSON.parse(JSON.stringify(response)) as SendResponseState) : null;
}

function fingerprintDraft(draft: RequestDraft) {
  return JSON.stringify(draft);
}

function readStoredRequestTabs(): StoredRequestTabs | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const stored = window.localStorage.getItem(REQUEST_TABS_STORAGE_KEY);
    if (!stored) {
      return null;
    }

    const parsed = JSON.parse(stored) as StoredRequestTabs;
    if (!Array.isArray(parsed.tabs)) {
      return null;
    }

    return {
      tabs: parsed.tabs.filter((tab) => typeof tab.tabId === "string" && typeof tab.requestId === "string"),
      activeTabId: typeof parsed.activeTabId === "string" ? parsed.activeTabId : null
    };
  } catch {
    return null;
  }
}

function restoreRequestTabs(collections: ApiCollection[]): { tabs: OpenRequestTab[]; activeTabId: string | null } {
  const stored = readStoredRequestTabs();

  if (stored) {
    const restoredTabs = stored.tabs.flatMap((tab) => {
      const request = findRequest(collections, tab.requestId);
      return request ? [createOpenRequestTab(request, tab.tabId)] : [];
    });
    const activeTabId = restoredTabs.some((tab) => tab.tabId === stored.activeTabId)
      ? stored.activeTabId
      : restoredTabs[0]?.tabId ?? null;

    return { tabs: restoredTabs, activeTabId };
  }

  const firstRequest = findFirstRequest(collections);
  if (!firstRequest) {
    return { tabs: [], activeTabId: null };
  }

  const firstTab = createOpenRequestTab(firstRequest);
  return { tabs: [firstTab], activeTabId: firstTab.tabId };
}

function reconcileRequestTabsWithData(tabs: OpenRequestTab[], collections: ApiCollection[]) {
  return tabs.flatMap((tab) => {
    const request = findRequest(collections, tab.requestId);
    if (!request) {
      return [];
    }

    if (tab.dirty || tab.saving) {
      return [tab];
    }

    return [
      {
        ...tab,
        draft: cloneDraft(request)
      }
    ];
  });
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

function formatBodyPreview(body: string): string {
  if (body.trim().startsWith("{") || body.trim().startsWith("[")) {
    try {
      return JSON.stringify(JSON.parse(body), null, 2);
    } catch {
      return body;
    }
  }

  return body;
}

function PrettyBody({
  body,
  contentType,
  searchQuery,
  searchResults,
  currentSearchMatch
}: {
  body: string;
  contentType: string;
  searchQuery?: string;
  searchResults?: number[];
  currentSearchMatch?: number;
}) {
  const formatted = formatPrettyBody(body, contentType);
  const language = detectBodyFormat(body, contentType);
  const hasSearch = !!searchQuery && !!searchResults && searchResults.length > 0;

  return (
    <pre className="max-h-[560px] overflow-auto whitespace-pre-wrap rounded border border-slate-800 bg-slate-950 p-2 font-mono text-xs leading-5 text-slate-50">
      {hasSearch ? (
        renderPrettyWithSearch(formatted, searchQuery!, searchResults!, currentSearchMatch ?? 0)
      ) : language === "text" ? (
        formatted
      ) : (
        <code>{renderHighlightedBody(formatted, language)}</code>
      )}
    </pre>
  );
}

function formatPrettyBody(body: string, contentType: string) {
  const format = detectBodyFormat(body, contentType);
  if (format === "json") {
    try {
      return JSON.stringify(JSON.parse(body), null, 2);
    } catch {
      return body;
    }
  }

  if (format === "xml") {
    return prettyPrintXml(body);
  }

  return body;
}

function detectBodyFormat(body: string, contentType: string): BodyFormat {
  const trimmed = body.trim();
  const normalizedContentType = contentType.toLowerCase();

  if (normalizedContentType.includes("json") || trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return "json";
  }

  if (
    normalizedContentType.includes("xml") ||
    normalizedContentType.includes("html") ||
    trimmed.startsWith("<")
  ) {
    return "xml";
  }

  return "text";
}

function prettyPrintXml(xml: string) {
  const cleaned = xml.trim();
  if (!cleaned) {
    return "";
  }

  const tokens = cleaned
    .replace(/>\s+</g, "><")
    .replace(/</g, "\n<")
    .replace(/\n{2,}/g, "\n")
    .split("\n")
    .filter(Boolean);

  let indent = 0;

  return tokens
    .map((token) => {
      const trimmed = token.trim();
      if (!trimmed) {
        return "";
      }

      if (trimmed.startsWith("</")) {
        indent = Math.max(indent - 1, 0);
      }

      const line = `${"  ".repeat(indent)}${trimmed}`;

      if (
        trimmed.startsWith("<") &&
        !trimmed.startsWith("</") &&
        !trimmed.endsWith("/>") &&
        !trimmed.includes("</")
      ) {
        indent += 1;
      }

      return line;
    })
    .join("\n");
}

function renderPrettyWithSearch(
  formatted: string,
  searchQuery: string,
  searchResults: number[],
  currentSearchMatch: number
) {
  const lowerFormatted = formatted.toLowerCase();
  const lowerQuery = searchQuery.toLowerCase();
  const localResults: number[] = [];
  let idx = 0;
  while (true) {
    const found = lowerFormatted.indexOf(lowerQuery, idx);
    if (found === -1) break;
    localResults.push(found);
    idx = found + 1;
  }

  const parts: ReactNode[] = [];
  let lastIdx = 0;
  for (let i = 0; i < localResults.length; i++) {
    const matchStart = localResults[i];
    if (matchStart > lastIdx) {
      parts.push(formatted.slice(lastIdx, matchStart));
    }
    const matchEnd = matchStart + searchQuery.length;
    const isActive = i === currentSearchMatch;
    parts.push(
      <mark
        key={`s${i}`}
        className={isActive ? "bg-amber-300 text-slate-900" : "bg-yellow-200 text-slate-800"}
      >
        {formatted.slice(matchStart, matchEnd)}
      </mark>
    );
    lastIdx = matchEnd;
  }
  if (lastIdx < formatted.length) {
    parts.push(formatted.slice(lastIdx));
  }
  return parts;
}

function renderHighlightedBody(body: string, format: Exclude<BodyFormat, "text">) {
  if (format === "json") {
    return renderJsonHighlight(body);
  }

  return renderXmlHighlight(body);
}

function renderJsonHighlight(body: string) {
  const parts: ReactNode[] = [];
  const regex = /("(?:\\.|[^"\\])*")|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b|(true|false|null)|([{}[\],:])/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(body))) {
    if (match.index > lastIndex) {
      parts.push(body.slice(lastIndex, match.index));
    }

    const [token, stringToken, numberToken, literalToken] = match;
    const nextNonSpace = body.slice(match.index + token.length).match(/\S/)?.[0] ?? "";
    const style = stringToken
      ? { color: nextNonSpace === ":" ? "#7dd3fc" : "#86efac" }
      : numberToken
        ? { color: "#fbbf24" }
        : literalToken === "null"
          ? { color: "#fda4af" }
          : literalToken
            ? { color: "#c4b5fd" }
            : { color: "#94a3b8" };

    parts.push(
      <span key={`${match.index}-${token}`} style={style}>
        {stringToken ? renderVariableTokens(token) : token}
      </span>
    );
    lastIndex = match.index + token.length;
  }

  if (lastIndex < body.length) {
    parts.push(body.slice(lastIndex));
  }

  return <>{parts}</>;
}

function renderXmlHighlight(body: string) {
  const parts: ReactNode[] = [];
  const regex = /(<\/?[^>]+>)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(body))) {
    if (match.index > lastIndex) {
      parts.push(body.slice(lastIndex, match.index));
    }

    parts.push(
      <span key={`${match.index}-${match[0]}`} style={{ color: "#7dd3fc" }}>
        {highlightXmlTag(match[0])}
      </span>
    );
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < body.length) {
    parts.push(body.slice(lastIndex));
  }

  return <>{parts}</>;
}

function highlightXmlTag(tag: string) {
  const pieces: ReactNode[] = [];
  const attrRegex = /(\s+[A-Za-z_:][-A-Za-z0-9_:.]*)(=)("[^"]*"|'[^']*')/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = attrRegex.exec(tag))) {
    if (match.index > lastIndex) {
      pieces.push(tag.slice(lastIndex, match.index));
    }

    pieces.push(
      <span key={`${match.index}-${match[1]}`} style={{ color: "#fbbf24" }}>
        {match[1]}
      </span>
    );
    pieces.push(<span key={`${match.index}-eq`} style={{ color: "#94a3b8" }}>{match[2]}</span>);
    pieces.push(
      <span key={`${match.index}-${match[3]}`} style={{ color: "#86efac" }}>
        {renderVariableTokens(match[3])}
      </span>
    );
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < tag.length) {
    pieces.push(tag.slice(lastIndex));
  }

  return <>{pieces}</>;
}

function renderVariableTokens(value: string) {
  const parts: ReactNode[] = [];
  const regex = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(value))) {
    if (match.index > lastIndex) {
      parts.push(value.slice(lastIndex, match.index));
    }

    parts.push(
      <span key={`${match.index}-${match[0]}`} style={{ color: "#f0abfc", fontWeight: 700 }}>
        {match[0]}
      </span>
    );
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < value.length) {
    parts.push(value.slice(lastIndex));
  }

  return <>{parts}</>;
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

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString();
}

function methodColor(method: string): string {
  switch (method) {
    case "GET": return "text-blue-600";
    case "POST": return "text-green-600";
    case "PUT": return "text-orange-600";
    case "PATCH": return "text-purple-600";
    case "DELETE": return "text-rose-600";
    case "HEAD": return "text-slate-600";
    case "OPTIONS": return "text-cyan-600";
    default: return "text-slate-600";
  }
}

function statusColor(status: number): string {
  if (status >= 200 && status < 300) return "text-green-600 border-green-200 bg-green-50";
  if (status >= 300 && status < 400) return "text-blue-600 border-blue-200 bg-blue-50";
  if (status >= 400 && status < 500) return "text-amber-600 border-amber-200 bg-amber-50";
  if (status >= 500) return "text-rose-600 border-rose-200 bg-rose-50";
  return "text-slate-600 border-slate-200 bg-slate-50";
}

function categorizeError(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes("enotfound") || lower.includes("econnrefused") || lower.includes("econnreset")) {
    return "Connection refused — Is the server running?";
  }
  if (lower.includes("etimedout") || lower.includes("timeout") || lower.includes("timed out")) {
    return "Request timed out — The server did not respond in time.";
  }
  if (lower.includes("dns") || lower.includes("enotfound")) {
    return "DNS lookup failed — Could not resolve the hostname.";
  }
  if (lower.includes("abort") || lower.includes("cancel")) {
    return "Request was cancelled.";
  }
  if (lower.includes("fetch") || lower.includes("network") || lower.includes("cors")) {
    return "Network error — Check the URL or CORS configuration.";
  }
  return message;
}

async function api<T = unknown>(
  url: string,
  options: RequestInit & { allowError?: boolean } = {}
): Promise<T> {
  const method = (options.method ?? "GET").toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD";

  const response = await fetch(url, {
    ...options,
    headers: {
      ...(hasBody ? { "Content-Type": "application/json" } : {}),
      ...(options.headers ?? {})
    }
  });

  const payload = (await response.json().catch(() => ({}))) as T & { error?: string };

  if (!response.ok && !options.allowError) {
    throw new Error(payload.error ?? `Request failed with ${response.status}`);
  }

  return payload as T;
}
