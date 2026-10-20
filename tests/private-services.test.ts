import { describe, expect, it } from "vitest";
import {
  resolvePrivateSearchSelection,
  guardSemanticRecords,
} from "../src/private-services.ts";
import { exampleLivePolicy } from "../src/live-policy.ts";
import { fixtureContacts } from "../src/fixtures.ts";

describe("private semantic integration boundary", () => {
  it("rejects arbitrary selectors rather than broadening a search", async () => {
    await expect(
      resolvePrivateSearchSelection(
        "foreign",
        exampleLivePolicy,
        fixtureContacts.map((c) => ({ ...c, emails: [] })),
        [],
      ),
    ).rejects.toThrow();
  });
  it("keeps canonical evidence when retrieval returns another owner or changed hash", () => {
    const canonical = { owner_id: "owner", record_key: "a", content_hash: "b" };
    expect(
      guardSemanticRecords(
        [canonical as never],
        [{ ...canonical, owner_id: "foreign" } as never],
      ),
    ).toEqual([]);
    expect(
      guardSemanticRecords(
        [canonical as never],
        [{ ...canonical, content_hash: "changed" } as never],
      ),
    ).toEqual([]);
    expect(
      guardSemanticRecords(
        [canonical as never],
        [canonical as never, canonical as never],
      ),
    ).toEqual([canonical]);
  });
  it("rejects revoked combined identity membership", async () => {
    const policy = {
      ...exampleLivePolicy,
      verified_contact_groups: [
        {
          id: "group:verified",
          name: "Example",
          verified_at: "2026-10-01T00:00:00Z",
          proof_kind: "provider_verified" as const,
          proof_reference: "fixture",
          members: [
            {
              source: "gmail" as const,
              account_id: "mail",
              contact_id: "F17",
              identity: "mira@example.invalid",
            },
          ],
        },
      ],
    };
    await expect(
      resolvePrivateSearchSelection(
        "group:verified",
        policy,
        fixtureContacts.map((c) => ({
          ...c,
          emails: ["mira@example.invalid"],
        })),
        [],
      ),
    ).rejects.toThrow();
  });
});
