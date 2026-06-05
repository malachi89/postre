import { describe, expect, it } from "vitest";
import {
  applyVariableAutocomplete,
  findVariableAutocompleteMatch,
  getVariableSuggestions
} from "@/lib/variable-autocomplete";

describe("variable autocomplete", () => {
  it("finds a trigger after typing double braces", () => {
    expect(findVariableAutocompleteMatch("Bearer {{tok", 12, 12)).toEqual({
      query: "tok",
      replaceFrom: 7,
      replaceTo: 12
    });
  });

  it("ignores non-collapsed selections", () => {
    expect(findVariableAutocompleteMatch("{{token}}", 0, 9)).toBeNull();
  });

  it("returns suggestions prioritizing prefix matches", () => {
    const suggestions = getVariableSuggestions(
      {
        authToken: { value: "secret", isSecret: true },
        baseUrl: { value: "https://api.example", isSecret: false },
        token: { value: "plain", isSecret: false }
      },
      "tok"
    );

    expect(suggestions.map((suggestion) => suggestion.key)).toEqual(["token", "authToken"]);
  });

  it("replaces the partial token with the selected variable", () => {
    expect(
      applyVariableAutocomplete(
        "https://api.example/{{bas",
        {
          query: "bas",
          replaceFrom: 20,
          replaceTo: 25
        },
        "baseUrl"
      )
    ).toEqual({
      value: "https://api.example/{{baseUrl}}",
      selection: 31
    });
  });
});
