import { describe, expect, it } from "vitest";
import {
  validatedLinkedInProfileUrl,
  parseSocialPolicy,
  assertSocialRead,
  socialWindow,
  type SocialPolicy,
} from "../src/social-policy.ts";
const example = {
  window_days: 30,
  accounts: [
    {
      source: "whatsapp_personal",
      provider: "unipile",
      account_id: "personal-one",
      owner_identity: "personal-owner",
      owner_verified: true,
      api_base_url: "https://api1.unipile.com:13111",
    },
    {
      source: "whatsapp_business",
      provider: "meta",
      account_id: "waba-one",
      owner_identity: "33123456789",
      owner_verified: true,
      business_phone_number_id: "phone-one",
    },
    {
      source: "linkedin",
      provider: "linkedin",
      account_id: "urn:li:person:owner",
      owner_identity: "urn:li:person:owner",
      owner_verified: true,
      profile_bindings: [
        {
          profile_url: "https://www.linkedin.com/in/owner",
          member_urn: "urn:li:person:owner",
          verified_by: "owner",
        },
      ],
    },
  ],
};
describe("approved social read policy", () => {
  it("is optional and parses only bound, verified accounts", () => {
    expect(parseSocialPolicy(undefined)).toBeUndefined();
    expect(parseSocialPolicy(example)?.accounts).toHaveLength(3);
  });
  it("accepts the authorized Unipile dashboard DSN port", () => {
    const api_base_url = "https://api38.unipile.com:16860";
    expect(
      parseSocialPolicy({
        ...example,
        accounts: [{ ...example.accounts[0], api_base_url }],
      })?.accounts[0],
    ).toMatchObject({ api_base_url });
  });
  it.each([
    "http://api1.unipile.com",
    "https://localhost",
    "https://127.0.0.1",
    "https://api1.unipile.com.evil.invalid",
    "https://api1.unipile.com/path",
    "https://api1.unipile.com?x=1",
    "https://api38.unipile.com:16861",
    "https://api38.unipile.com:444",
    "https://api.linkedin.com:16860",
    "https://attacker.invalid:16860",
    "https://api38.unipile.com.attacker.invalid:16860",
    "https://attacker@api38.unipile.com:16860",
    "https://api38.unipile.com:16860/path",
    "https://api38.unipile.com:16860?key=fixture",
    "https://api38.unipile.com:16860#fragment",
  ])("denies unsafe provider bases: %s", (api_base_url) =>
    expect(() =>
      parseSocialPolicy({
        ...example,
        accounts: [{ ...example.accounts[0], api_base_url }],
      }),
    ).toThrow(),
  );
  it.each([
    { owner_verified: false },
    { provider: "linkedin" },
    { unknown_field: "not-approved" },
    { owner_identity: "" },
  ])("rejects unknown fields and unverifiable bindings", (patch) =>
    expect(() =>
      parseSocialPolicy({
        ...example,
        accounts: [{ ...example.accounts[0], ...patch }],
      }),
    ).toThrow(),
  );
  it("rejects duplicate channels and expanded message windows", () => {
    expect(() => parseSocialPolicy({ ...example, window_days: 90 })).toThrow();
    expect(() =>
      parseSocialPolicy({
        ...example,
        accounts: [example.accounts[0], example.accounts[0]],
      }),
    ).toThrow();
  });
  it("rejects unverified/name-based LinkedIn identity mappings", () => {
    const account = example.accounts[2];
    expect(() =>
      parseSocialPolicy({
        ...example,
        accounts: [
          {
            ...account,
            profile_bindings: [
              {
                profile_url: "Mira",
                member_urn: "urn:li:person:mira",
                verified_by: "owner",
              },
            ],
          },
        ],
      }),
    ).toThrow();
  });
  it("allows only enumerated reads and the configured account", () => {
    const policy = parseSocialPolicy(example) as SocialPolicy;
    expect(
      assertSocialRead(
        policy,
        "whatsapp_personal",
        "personal-one",
        "unipile.messages.list",
      ).provider,
    ).toBe("unipile");
    expect(() =>
      assertSocialRead(
        policy,
        "whatsapp_personal",
        "foreign",
        "unipile.messages.list",
      ),
    ).toThrow();
    for (const operation of [
      "unipile.messages.send",
      "unipile.messages.read",
      "linkedin.memberAuthorizations.create",
      "meta.messages.send",
    ])
      expect(() =>
        assertSocialRead(
          policy,
          "whatsapp_personal",
          "personal-one",
          operation,
        ),
      ).toThrow();
  });
  it("returns exactly the approved rolling thirty days", () =>
    expect(socialWindow(new Date("2026-10-14T12:00:00Z"))).toEqual({
      start: "2026-09-14T12:00:00.000Z",
      end: "2026-10-14T12:00:00.000Z",
    }));
});

describe("explicit Unipile Business binding", () => {
  const business = {
    ...example.accounts[0],
    source: "whatsapp_business",
    account_id: "business-unipile",
    owner_identity: "business-owner",
  };
  it("permits the approved Business provider without Meta fields", () => {
    const parsed = parseSocialPolicy({
      window_days: 30,
      accounts: [example.accounts[0], business],
    })!;
    expect(parsed.accounts[1]).toMatchObject({
      source: "whatsapp_business",
      provider: "unipile",
      account_id: "business-unipile",
    });
    expect(
      assertSocialRead(
        parsed,
        "whatsapp_business",
        "business-unipile",
        "unipile.messages.list",
      ).provider,
    ).toBe("unipile");
    expect(() =>
      assertSocialRead(
        parsed,
        "whatsapp_business",
        "business-unipile",
        "meta.waba.get",
      ),
    ).toThrow();
    expect(() =>
      parseSocialPolicy({
        window_days: 30,
        accounts: [{ ...business, business_phone_number_id: "not-meta" }],
      }),
    ).toThrow();
  });
  it.each(["unipile", "meta"] as const)(
    "rejects one WhatsApp owner across Personal and %s Business account IDs",
    (provider) => {
      const owner_identity = "33123456789";
      const selectedBusiness =
        provider === "unipile"
          ? { ...business, owner_identity }
          : { ...example.accounts[1], owner_identity };
      expect(() =>
        parseSocialPolicy({
          window_days: 30,
          accounts: [
            { ...example.accounts[0], owner_identity },
            selectedBusiness,
          ],
        }),
      ).toThrow("duplicate WhatsApp owner identity");
    },
  );
  it.each(["unipile", "meta"] as const)(
    "rejects optional leading-plus owner aliases across Personal and %s Business",
    (provider) => {
      const owner_identity = "33123456789";
      const selectedBusiness =
        provider === "unipile"
          ? { ...business, owner_identity }
          : { ...example.accounts[1], owner_identity };
      expect(() =>
        parseSocialPolicy({
          window_days: 30,
          accounts: [
            { ...example.accounts[0], owner_identity: "+" + owner_identity },
            selectedBusiness,
          ],
        }),
      ).toThrow("duplicate WhatsApp owner identity");
    },
  );
  it("preserves exact provider owner strings and does not normalize nonnumeric identities", () => {
    const parsed = parseSocialPolicy({
      window_days: 30,
      accounts: [
        { ...example.accounts[0], owner_identity: "+33123456789" },
        { ...business, owner_identity: "33123456780" },
      ],
    })!;
    expect(parsed.accounts[0]?.owner_identity).toBe("+33123456789");
    expect(
      parseSocialPolicy({
        window_days: 30,
        accounts: [
          { ...example.accounts[0], owner_identity: "+named-owner" },
          { ...business, owner_identity: "named-owner" },
        ],
      })?.accounts,
    ).toHaveLength(2);
  });
  it("rejects one Unipile account bound to both sources", () => {
    expect(() =>
      parseSocialPolicy({
        window_days: 30,
        accounts: [
          example.accounts[0],
          { ...business, account_id: example.accounts[0]!.account_id },
        ],
      }),
    ).toThrow();
  });
});

it("accepts provider-verified owner profile provenance but rejects inferred contact URNs", () => {
  const owner = {
    ...example.accounts[2],
    profile_bindings: [
      {
        profile_url: "https://www.linkedin.com/in/fixture-owner/",
        member_urn: "urn:li:person:owner",
        verified_by: "provider",
      },
    ],
  };
  expect(
    parseSocialPolicy({ window_days: 30, accounts: [owner] })?.accounts[0],
  ).toMatchObject({ profile_bindings: [{ verified_by: "provider" }] });
  for (const patch of [
    { verified_by: "guessed" },
    { verified_by: "provider", member_urn: "urn:li:person:other" },
    { profile_url: "https://www.linkedin.com/in/owner\\suffix" },
    { profile_url: " https://www.linkedin.com/in/owner" },
    { profile_url: "https://www.linkedin.com/in/owner%2fother" },
  ])
    expect(() =>
      parseSocialPolicy({
        window_days: 30,
        accounts: [
          {
            ...owner,
            profile_bindings: [{ ...owner.profile_bindings[0], ...patch }],
          },
        ],
      }),
    ).toThrow();
  expect(() =>
    parseSocialPolicy({
      window_days: 30,
      accounts: [
        {
          ...owner,
          profile_bindings: [
            owner.profile_bindings[0],
            {
              ...owner.profile_bindings[0],
              profile_url: "https://www.linkedin.com/in/fixture-owner",
            },
          ],
        },
      ],
    }),
  ).toThrow("duplicate profile binding");
});

it("rejects all raw and encoded ASCII controls and profile path aliases", () => {
  const bad = [
    ...Array.from(
      { length: 33 },
      (_, i) =>
        `https://www.linkedin.com/in/fixture${String.fromCharCode(i === 32 ? 127 : i)}peer`,
    ),
    ...Array.from(
      { length: 33 },
      (_, i) =>
        `https://www.linkedin.com/in/fixture%${(i === 32 ? 127 : i).toString(16).padStart(2, "0")}peer`,
    ),
    "https://www.linkedin.com/in/%61dam",
    "https://www.linkedin.com/in/fixture%2epeer",
    "https://www.linkedin.com/in/fixture%C2%85peer",
    "https://www.linkedin.com/in/fixture%C2%9fpeer",
    "https://www.linkedin.com/in/fixture%ffpeer",
    "https://www.linkedin.com/a/../in/fixture-peer",
    "https://www.linkedin.com/in/a/../fixture-peer",
    "https://www.linkedin.com/in/%2e%2e/in/fixture-peer",
    "https://www.linkedin.com/in/fixture-peer?query=1",
    "https://www.linkedin.com/in/fixture-peer#fragment",
    "https://www.linkedin.com:443/in/fixture-peer",
    "https://user@www.linkedin.com/in/fixture-peer",
  ];
  for (const profile_url of bad) {
    expect(() => validatedLinkedInProfileUrl(profile_url)).toThrow();
    expect(() =>
      parseSocialPolicy({
        window_days: 30,
        accounts: [
          {
            ...example.accounts[2],
            profile_bindings: [
              {
                profile_url,
                member_urn: "urn:li:person:owner",
                verified_by: "provider",
              },
            ],
          },
        ],
      }),
    ).toThrow();
  }
  expect(
    validatedLinkedInProfileUrl("https://www.linkedin.com/in/fixture-peer/"),
  ).toBe("https://www.linkedin.com/in/fixture-peer/");
});

it("allows only one independently provider-verified owner profile per account", () => {
  expect(() =>
    parseSocialPolicy({
      window_days: 30,
      accounts: [
        {
          ...example.accounts[2],
          profile_bindings: [
            {
              profile_url: "https://www.linkedin.com/in/fixture-owner",
              member_urn: "urn:li:person:owner",
              verified_by: "provider",
            },
            {
              profile_url: "https://www.linkedin.com/in/another-owner-url",
              member_urn: "urn:li:person:owner",
              verified_by: "provider",
            },
          ],
        },
      ],
    }),
  ).toThrow("multiple provider owner profiles");
});
