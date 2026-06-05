export interface VariableLookupEntry {
  value: string;
  isSecret: boolean;
}

export type VariableLookupLike = Record<string, VariableLookupEntry>;

export interface VariableAutocompleteMatch {
  query: string;
  replaceFrom: number;
  replaceTo: number;
}

export interface VariableSuggestion extends VariableLookupEntry {
  key: string;
}

const VARIABLE_TRIGGER_PATTERN = /\{\{\s*([A-Za-z0-9_.-]*)$/;
const VARIABLE_SUFFIX_PATTERN = /^([A-Za-z0-9_.-]*)(\s*\}\})?/;

export function findVariableAutocompleteMatch(
  text: string,
  selectionStart: number,
  selectionEnd: number
): VariableAutocompleteMatch | null {
  if (selectionStart !== selectionEnd) {
    return null;
  }

  const prefix = text.slice(0, selectionStart);
  const match = VARIABLE_TRIGGER_PATTERN.exec(prefix);

  if (!match || match.index === undefined) {
    return null;
  }

  const suffix = VARIABLE_SUFFIX_PATTERN.exec(text.slice(selectionEnd));
  const suffixQuery = suffix?.[1] ?? "";
  const suffixClose = suffix?.[2] ?? "";

  return {
    query: `${match[1] ?? ""}${suffixQuery}`,
    replaceFrom: match.index,
    replaceTo: selectionEnd + suffixQuery.length + suffixClose.length
  };
}

export function getVariableSuggestions(
  variableLookup: VariableLookupLike,
  query: string
): VariableSuggestion[] {
  const normalizedQuery = query.trim().toLowerCase();

  return Object.entries(variableLookup)
    .filter(([key]) => {
      if (!normalizedQuery) {
        return true;
      }

      return key.toLowerCase().includes(normalizedQuery);
    })
    .sort(([leftKey], [rightKey]) => {
      const left = leftKey.toLowerCase();
      const right = rightKey.toLowerCase();
      const leftStartsWith = normalizedQuery ? left.startsWith(normalizedQuery) : false;
      const rightStartsWith = normalizedQuery ? right.startsWith(normalizedQuery) : false;

      if (leftStartsWith !== rightStartsWith) {
        return leftStartsWith ? -1 : 1;
      }

      return leftKey.localeCompare(rightKey);
    })
    .map(([key, entry]) => ({
      key,
      value: entry.value,
      isSecret: entry.isSecret
    }));
}

export function applyVariableAutocomplete(
  text: string,
  match: VariableAutocompleteMatch,
  variableKey: string
) {
  const replacement = `{{${variableKey}}}`;
  const value = `${text.slice(0, match.replaceFrom)}${replacement}${text.slice(match.replaceTo)}`;

  return {
    value,
    selection: match.replaceFrom + replacement.length
  };
}
