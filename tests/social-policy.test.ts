import { describe, expect, it } from "vitest";
import {
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
  it.each([
    "http://api1.unipile.com",
    "https://localhost",
    "https://127.0.0.1",
    "https://api1.unipile.com.evil.invalid",
    "https://api1.unipile.com/path",
    "https://api1.unipile.com?x=1",
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
