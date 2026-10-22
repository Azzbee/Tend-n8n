import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  bindCredentials,
  placeholderCredentials,
} from "../src/credential-binding.ts";

type W = Parameters<typeof placeholderCredentials>[0];
const load = (f: string): W =>
  JSON.parse(readFileSync(`workflows/${f}`, "utf8")) as W;
const binding = {
  CONFIGURE_INTERNAL_API_CREDENTIAL_ID: { id: "intA", name: "Internal" },
  CONFIGURE_GMAIL_READONLY_CREDENTIAL_ID: { id: "gmA", name: "Gmail" },
  CONFIGURE_CALENDAR_READONLY_CREDENTIAL_ID: { id: "calA", name: "Calendar" },
};

describe("private credential binding", () => {
  it("finds the placeholder inside the sub-workflow embedded in 11 and 12", () => {
    for (const f of [
      "11-google-gmail-readonly.json",
      "12-google-calendar-readonly.json",
    ])
      expect(placeholderCredentials(load(f))).toContain(
        "Normalize each approved provider record > Normalize and commit approved record (httpHeaderAuth)",
      );
  });

  it("binds nested and top-level placeholders and leaves none behind", () => {
    const bound = bindCredentials(
      load("11-google-gmail-readonly.json"),
      binding,
    );
    expect(placeholderCredentials(bound)).toEqual([]);
    expect(JSON.stringify(bound)).not.toContain("CONFIGURE_");
    const child = bound.nodes.find(
      (n) => n.name === "Normalize each approved provider record",
    )!;
    const inner = JSON.parse(String(child.parameters!.workflowJson)) as W;
    expect(
      inner.nodes.find(
        (n) => n.name === "Normalize and commit approved record",
      )!.credentials,
    ).toEqual({ httpHeaderAuth: { id: "intA", name: "Internal" } });
  });

  it("refuses a binding that would publish a nested placeholder", () => {
    const top = load("11-google-gmail-readonly.json");
    const topOnly: W = JSON.parse(JSON.stringify(top)) as W;
    for (const n of topOnly.nodes)
      for (const type of Object.keys(n.credentials ?? {}))
        n.credentials![type] = { id: "real", name: "real" };
    expect(placeholderCredentials(topOnly).length).toBeGreaterThan(0);
    expect(() =>
      bindCredentials(top, {
        CONFIGURE_GMAIL_READONLY_CREDENTIAL_ID: { id: "gmA", name: "Gmail" },
      }),
    ).toThrow("Unbound credential placeholders");
  });
});
