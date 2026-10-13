import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InternalAuth } from "../src/internal-auth.ts";

const fictionalKey =
  "FICTIONAL_ONLY_0123456789_abcdefghijklmnopqrstuvwxyz_ABCD";
describe("private internal credential", () => {
  it("fails closed before human setup and stores only a verification hash", () => {
    const dir = mkdtempSync(join(tmpdir(), "tend-hash-")),
      file = join(dir, "auth.json");
    try {
      const auth = new InternalAuth(file);
      expect(auth.verify("Bearer " + fictionalKey)).toBe(false);
      expect(() => auth.configure(fictionalKey, "wrong nonce")).toThrow();
      auth.configure(fictionalKey, auth.setupNonce);
      expect(auth.verify("Bearer " + fictionalKey)).toBe(true);
      expect(auth.verify(fictionalKey)).toBe(true);
      expect(auth.verify(" " + fictionalKey)).toBe(false);
      expect(auth.verify(fictionalKey + "wrong")).toBe(false);
      expect(auth.verify("Bearer " + fictionalKey + "wrong")).toBe(false);
      expect(readFileSync(file, "utf8")).not.toContain(fictionalKey);
      expect(statSync(file).mode & 0o077).toBe(0);
      expect(new InternalAuth(file).verify("Bearer " + fictionalKey)).toBe(
        true,
      );
      expect(() => auth.configure(fictionalKey, auth.setupNonce)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("rejects short and repetitive keys", () => {
    const auth = new InternalAuth();
    expect(() => auth.configure("short", auth.setupNonce)).toThrow();
    expect(() => auth.configure("x".repeat(50), auth.setupNonce)).toThrow();
  });
});
