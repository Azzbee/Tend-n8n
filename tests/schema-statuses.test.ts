import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// The proposed schema must accept every commitment status the engine writes.
describe("proposed commitments schema", () => {
  it("allows the dismissed status that /dismiss and the Desk write", () => {
    const sql = readFileSync("schema/001-tend.sql", "utf8");
    const check =
      /CREATE TABLE commitments[\s\S]*?status text NOT NULL CHECK\(status IN \(([^)]*)\)\)/.exec(
        sql,
      )![1]!;
    const allowed = check.split(",").map((s) => s.trim().replace(/'/g, ""));
    for (const status of [
      "pending",
      "confirmed",
      "done",
      "cancelled",
      "dismissed",
      "invalidated",
    ])
      expect(allowed).toContain(status);
  });
});
