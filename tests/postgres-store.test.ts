import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { PostgresStore } from "../src/postgres-store.ts";
describe("Postgres store boundary", () => {
  it("loads in the production Node strip-only runtime without opening a database", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--input-type=module",
        "-e",
        `await import(${JSON.stringify(new URL("../src/postgres-store.ts", import.meta.url).href)}); console.log("postgres-module-loaded");`,
      ],
      { encoding: "utf8", timeout: 10000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.stderr).not.toContain("ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX");
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("postgres-module-loaded");
  });
  it("requires a concrete private principal before a connection", async () => {
    await expect(
      PostgresStore.open({
        connectionString: "postgresql://invalid",
        principal: { owner_id: "", user_id: "u", chat_id: "c" },
      }),
    ).rejects.toThrow("principal");
  });
});
