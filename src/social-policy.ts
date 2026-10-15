import type { MessagingSource } from "./messaging-records.ts";
interface AccountBinding {
  account_id: string;
  owner_identity: string;
  owner_verified: true;
}
export interface PersonalWhatsAppAccount extends AccountBinding {
  source: "whatsapp_personal";
  provider: "unipile";
  api_base_url: string;
}
export interface UnipileBusinessWhatsAppAccount extends AccountBinding {
  source: "whatsapp_business";
  provider: "unipile";
  api_base_url: string;
}
export interface BusinessWhatsAppAccount extends AccountBinding {
  source: "whatsapp_business";
  provider: "meta";
  business_phone_number_id: string;
}
export interface LinkedInAccount extends AccountBinding {
  source: "linkedin";
  provider: "linkedin";
  profile_bindings: {
    profile_url: string;
    member_urn: string;
    verified_by: "owner" | "provider";
  }[];
}
export type SocialAccount =
  | PersonalWhatsAppAccount
  | UnipileBusinessWhatsAppAccount
  | BusinessWhatsAppAccount
  | LinkedInAccount;
export interface SocialPolicy {
  window_days: 30;
  accounts: SocialAccount[];
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid social policy object");
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new Error("unknown social policy field");
}
function identity(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 1024 ||
    /\s/u.test(value) ||
    Array.from(value).some(
      (c) => c.charCodeAt(0) < 33 || c.charCodeAt(0) === 127,
    )
  )
    throw new Error("invalid social identity");
  return value;
}
function member(value: unknown): string {
  const text = identity(value);
  if (!/^urn:li:person:[A-Za-z0-9_-]+$/.test(text))
    throw new Error("unverified LinkedIn member");
  return text;
}
function providerBase(value: unknown): string {
  if (typeof value !== "string") throw new Error("invalid provider host");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("invalid provider host");
  }
  if (
    url.protocol !== "https:" ||
    !/^(?:api[0-9]*|[a-z0-9-]+)\.unipile\.com$/.test(url.hostname) ||
    url.username ||
    url.password ||
    !["", "443", "13111", "16860"].includes(url.port) ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("unapproved provider host");
  return url.origin;
}
export function validatedLinkedInProfileUrl(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 2048 ||
    /[\s\\]/u.test(value) ||
    Array.from(value).some(
      (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
    ) ||
    /%(?:0[0-9a-f]|1[0-9a-f]|7f|2f|5c)/i.test(value) ||
    !/^https:\/\/www\.linkedin\.com\/in\/[A-Za-z0-9_.%~-]+\/?$/.test(value) ||
    /%(?![0-9a-f]{2})/i.test(value)
  )
    throw new Error("invalid profile URL");
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new Error("invalid profile URL");
  }
  if (
    Array.from(decoded).some(
      (char) => char.charCodeAt(0) >= 127 && char.charCodeAt(0) <= 159,
    ) ||
    Array.from(value.matchAll(/%([0-9a-f]{2})/gi)).some((match) =>
      /^[A-Za-z0-9._~-]$/.test(
        String.fromCharCode(Number.parseInt(match[1]!, 16)),
      ),
    )
  )
    throw new Error("noncanonical profile URL");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("invalid profile URL");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "www.linkedin.com" ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/in\/[^/]+\/?$/.test(url.pathname)
  )
    throw new Error("unapproved profile URL");
  return value;
}
/** Parsing does not create grants or infer verification from a display name. */
export function parseSocialPolicy(input: unknown): SocialPolicy | undefined {
  if (input === undefined) return undefined;
  const raw = object(input);
  keys(raw, ["window_days", "accounts"]);
  if (
    raw.window_days !== 30 ||
    !Array.isArray(raw.accounts) ||
    raw.accounts.length < 1 ||
    raw.accounts.length > 3
  )
    throw new Error("unapproved social scope");
  const accounts = raw.accounts.map((inputAccount): SocialAccount => {
    const a = object(inputAccount),
      source = a.source;
    const common = [
      "source",
      "provider",
      "account_id",
      "owner_identity",
      "owner_verified",
    ];
    const account_id = identity(a.account_id),
      owner_identity = identity(a.owner_identity);
    if (a.owner_verified !== true)
      throw new Error("social owner verification required");
    const binding: AccountBinding = {
      account_id,
      owner_identity,
      owner_verified: true,
    };
    if (
      (source === "whatsapp_personal" || source === "whatsapp_business") &&
      a.provider === "unipile"
    ) {
      keys(a, [...common, "api_base_url"]);
      return {
        ...binding,
        source,
        provider: "unipile",
        api_base_url: providerBase(a.api_base_url),
      };
    }
    if (source === "whatsapp_business" && a.provider === "meta") {
      keys(a, [...common, "business_phone_number_id"]);
      if (!/^\d{7,15}$/.test(owner_identity))
        throw new Error("invalid business owner identity");
      return {
        ...binding,
        source,
        provider: "meta",
        business_phone_number_id: identity(a.business_phone_number_id),
      };
    }
    if (source === "linkedin" && a.provider === "linkedin") {
      keys(a, [...common, "profile_bindings"]);
      if (member(owner_identity) !== member(account_id))
        throw new Error("LinkedIn owner binding mismatch");
      if (
        !Array.isArray(a.profile_bindings) ||
        a.profile_bindings.length > 10000
      )
        throw new Error("invalid profile bindings");
      const profile_bindings = a.profile_bindings.map((inputBinding) => {
        const b = object(inputBinding);
        keys(b, ["profile_url", "member_urn", "verified_by"]);
        if (
          b.verified_by !== "owner" &&
          !(b.verified_by === "provider" && b.member_urn === owner_identity)
        )
          throw new Error("profile verification required");
        return {
          profile_url: validatedLinkedInProfileUrl(b.profile_url),
          member_urn: member(b.member_urn),
          verified_by: b.verified_by as "owner" | "provider",
        };
      });
      if (
        new Set(profile_bindings.map((b) => b.profile_url.replace(/\/$/, "")))
          .size !== profile_bindings.length
      )
        throw new Error("duplicate profile binding");
      if (
        profile_bindings.filter((b) => b.verified_by === "provider").length > 1
      )
        throw new Error("multiple provider owner profiles");
      return { ...binding, source, provider: "linkedin", profile_bindings };
    }
    throw new Error("unapproved social provider/source");
  });
  if (new Set(accounts.map((a) => a.source)).size !== accounts.length)
    throw new Error("duplicate social source");
  if (
    new Set(accounts.map((a) => JSON.stringify([a.provider, a.account_id])))
      .size !== accounts.length
  )
    throw new Error("duplicate social provider account");
  const whatsappOwners = accounts
    .filter(
      (account) =>
        account.source === "whatsapp_personal" ||
        account.source === "whatsapp_business",
    )
    .map((account) => account.owner_identity.replace(/^\+(?=\d+$)/, ""));
  if (new Set(whatsappOwners).size !== whatsappOwners.length)
    throw new Error("duplicate WhatsApp owner identity");
  return { window_days: 30, accounts };
}
export function socialAccount(
  policy: SocialPolicy,
  source: MessagingSource,
  accountId: string,
): SocialAccount {
  const parsed = parseSocialPolicy(policy)!;
  const account = parsed.accounts.find(
    (a) => a.source === source && a.account_id === accountId,
  );
  if (!account) throw new Error("social account not approved");
  return account;
}
const reads = {
  unipile: [
    "unipile.accounts.get",
    "unipile.chats.list",
    "unipile.chats.get",
    "unipile.messages.list",
    "unipile.messages.get",
  ],
  meta: ["meta.waba.get", "meta.phone_number.get"],
  linkedin: [
    "linkedin.memberSnapshotData.get",
    "linkedin.memberChangeLogs.get",
    "linkedin.memberAuthorizations.get",
  ],
};
export function assertSocialRead(
  policy: SocialPolicy,
  source: MessagingSource,
  accountId: string,
  operation: string,
): SocialAccount {
  const account = socialAccount(policy, source, accountId);
  if (!reads[account.provider].includes(operation))
    throw new Error("social operation denied; reads only");
  return account;
}
export function socialWindow(now: Date): { start: string; end: string } {
  if (!Number.isFinite(now.getTime())) throw new Error("invalid social clock");
  return {
    start: new Date(now.getTime() - 30 * 86400000).toISOString(),
    end: now.toISOString(),
  };
}
