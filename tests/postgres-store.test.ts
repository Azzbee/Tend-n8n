import { describe, it, expect } from "vitest";
import { PostgresStore } from "../src/postgres-store.ts";
describe("Postgres store boundary", () => {
  it("requires a concrete private principal before a connection", async () => {
    await expect(
      PostgresStore.open({
        connectionString: "postgresql://invalid",
        principal: { owner_id: "", user_id: "u", chat_id: "c" },
      }),
    ).rejects.toThrow("principal");
  });
});
