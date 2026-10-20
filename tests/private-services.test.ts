import { describe, expect, it, vi } from "vitest";
import {
  createPrivateServices,
  resolvePrivateSearchSelection,
  guardSemanticRecords,
  semanticActorNames,
} from "../src/private-services.ts";
import { exampleLivePolicy, type LivePolicy } from "../src/live-policy.ts";
import { fixtureContacts } from "../src/fixtures.ts";

import type {
  SemanticScope,
  SemanticServiceOptions,
} from "../src/semantic-search.ts";
import type { NormalizedRecord } from "../src/engine.ts";
const captured = vi.hoisted(() => ({ scope: null as SemanticScope | null }));
vi.mock("../src/semantic-search.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/semantic-search.ts")>();
  return {
    ...actual,
    SemanticSearchService: class {
      constructor(options: SemanticServiceOptions) {
        captured.scope = options.scope;
      }
    },
  };
});

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

describe("per-source semantic retention", () => {
  it.each([
    [true, false],
    [false, true],
    [false, false],
    [true, true],
  ])(
    "keeps mail history %s independent of social history %s",
    async (mail, social) => {
      const policy: LivePolicy = {
        ...exampleLivePolicy,
        ...(mail
          ? { history: { version: 1 as const, mode: "all_available" as const } }
          : {}),
        social: {
          window_days: 30,
          ...(social
            ? {
                history: {
                  version: 1 as const,
                  mode: "all_available" as const,
                },
              }
            : {}),
          accounts: [
            {
              source: "whatsapp_personal",
              provider: "unipile",
              account_id: "personal-account",
              owner_identity: "123",
              owner_verified: true,
              api_base_url: "https://api1.unipile.com",
            },
          ],
        },
      };
      const services = createPrivateServices({
        policy,
        store: {} as never,
        postgres: {},
      });
      try {
        const now = new Date("2026-10-20T10:00:00.000Z");
        const raw = { occurred_at: "2024-01-01T10:00:00.000Z" };
        const scope = captured.scope!;
        expect(
          scope
            .expiresAt({ ...raw, source: "gmail" } as NormalizedRecord, now)
            .toISOString(),
        ).toBe(mail ? "2026-11-19T10:00:00.000Z" : "2024-01-31T10:00:00.000Z");
        expect(
          scope
            .expiresAt(
              { ...raw, source: "whatsapp_personal" } as NormalizedRecord,
              now,
            )
            .toISOString(),
        ).toBe(
          social ? "2026-11-19T10:00:00.000Z" : "2024-01-31T10:00:00.000Z",
        );
        expect(
          scope
            .expiresAt(
              {
                ...raw,
                source: "calendar",
                end_at: "2024-01-01T11:00:00.000Z",
              } as NormalizedRecord,
              now,
            )
            .toISOString(),
        ).toBe(mail ? "2026-11-19T10:00:00.000Z" : "2024-01-01T11:00:00.000Z");
      } finally {
        await services.close();
      }
    },
  );
});

describe("semantic actor display names", () => {
  it("uses only the exact owner-scoped actor binding", () => {
    const record = {
      owner_id: "owner",
      record_key: "record",
      actor_identity: "opaque-actor",
      contact_id: "mira",
      contact_ids: ["mira", "alex"],
    } as NormalizedRecord;
    const contacts = [
      {
        owner_id: "owner",
        contact_id: "mira",
        name: "Mira Tan",
        emails: ["opaque-actor"],
      },
      {
        owner_id: "owner",
        contact_id: "alex",
        name: "Alex",
        emails: ["participant"],
      },
      {
        owner_id: "foreign",
        contact_id: "mira",
        name: "Foreign name",
        emails: ["opaque-actor"],
      },
    ];
    expect([...semanticActorNames("owner", [record], contacts)]).toEqual([
      ["record", "Mira Tan"],
    ]);
  });
  it("does not use recipient, unrelated, ambiguous or foreign contact metadata", () => {
    const r = {
      owner_id: "owner",
      record_key: "record",
      actor_identity: "actual-actor",
      contact_id: "mira",
      contact_ids: ["mira"],
    } as NormalizedRecord;
    expect(
      semanticActorNames(
        "owner",
        [r],
        [
          {
            owner_id: "owner",
            contact_id: "mira",
            name: "Mira",
            emails: ["participant"],
          },
        ],
      ).size,
    ).toBe(0);
    expect(
      semanticActorNames(
        "owner",
        [{ ...r, owner_id: "foreign" }],
        [
          {
            owner_id: "owner",
            contact_id: "mira",
            name: "Mira",
            emails: ["actual-actor"],
          },
        ],
      ).size,
    ).toBe(0);
    expect(
      semanticActorNames(
        "owner",
        [r],
        [
          {
            owner_id: "owner",
            contact_id: "mira",
            name: "Mira",
            emails: ["actual-actor"],
          },
          {
            owner_id: "owner",
            contact_id: "mira",
            name: "Other name",
            emails: ["actual-actor"],
          },
        ],
      ).size,
    ).toBe(0);
  });
});
