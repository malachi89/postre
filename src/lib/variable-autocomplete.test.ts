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

  it("extends the replacement through existing closing braces", () => {
    expect(findVariableAutocompleteMatch("{{}}/attachments/estimate/527152", 2, 2)).toEqual({
      query: "",
      replaceFrom: 0,
      replaceTo: 4
    });

    expect(
      applyVariableAutocomplete(
        "{{}}/attachments/estimate/527152",
        {
          query: "",
          replaceFrom: 0,
          replaceTo: 4
        },
        "context"
      )
    ).toEqual({
      value: "{{context}}/attachments/estimate/527152",
      selection: 11
    });
  });

  it("uses the whole token as the query when the cursor is inside it", () => {
    expect(findVariableAutocompleteMatch("{{context}}/attachments/estimate/527152", 2, 2)).toEqual({
      query: "context",
      replaceFrom: 0,
      replaceTo: 11
    });
  });
});
