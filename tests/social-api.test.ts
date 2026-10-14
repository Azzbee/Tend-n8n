import {
  afterAll,
  beforeAll,
  beforeEach,
  afterEach,
  describe,
  it,
  expect,
} from "vitest";
import { randomUUID } from "node:crypto";
import { TendStore } from "../src/engine.ts";
import { PostgresStore } from "../src/postgres-store.ts";
import type { LiveStore } from "../src/live-store.ts";
import { handleSocialSync } from "../src/social-api.ts";
import { parseSocialPolicy } from "../src/social-policy.ts";
import type { SocialSyncRequest } from "../src/social-sync.ts";
import { postgresTestRuntime } from "./postgres-test-runtime.ts";
const now = new Date("2026-10-14T12:00:00Z"),
  start = "2026-09-14T12:00:00.000Z",
  end = now.toISOString();
const policy = parseSocialPolicy({
  window_days: 30,
  accounts: [
    {
      source: "whatsapp_personal",
      provider: "unipile",
      account_id: "personal-one",
      owner_identity: "owner-user",
      owner_verified: true,
      api_base_url: "https://api1.unipile.com:13111",
    },
  ],
})!;
const message = () => ({
  id: "message-one",
  account_id: "personal-one",
  chat_id: "thread-one",
  sender_id: "other-user",
  timestamp: "2026-10-13T12:00:00Z",
  is_sender: false,
  text: "I'll send it.",
  attendees: [
    { attendee_provider_id: "owner-user" },
    { attendee_provider_id: "other-user" },
  ],
});
const page = (): SocialSyncRequest => ({
  source: "whatsapp_personal",
  account_id: "personal-one",
  format: "unipile_messages",
  items: [message()],
  cursor: "page-two",
  expected_cursor: null,
  complete: false,
  coverage_start: start,
  coverage_end: end,
  reconcile: false,
});
let runtime: Awaited<ReturnType<typeof postgresTestRuntime>>;
beforeAll(async () => {
  runtime = await postgresTestRuntime();
}, 90000);
afterAll(() => runtime?.close());
describe.each(["sqlite", "postgres"] as const)(
  "protected social sync %s",
  (backend) => {
    let store: TendStore | LiveStore, owner: string;
    beforeEach(async () => {
      owner = "social-test-" + randomUUID();
      const principal = { owner_id: owner, user_id: "user", chat_id: "chat" };
      store =
        backend === "sqlite"
          ? new TendStore(":memory:", {
              mode: "live",
              principal,
              clock: () => now,
            })
          : await PostgresStore.open({
              connectionString: runtime.connectionString,
              principal,
              clock: () => now,
            });
      await store.seed(
        [],
        [],
        [
          {
            owner_id: owner,
            source: "whatsapp_personal",
            account_id: "personal-one",
            mode: "live",
            last_success: null,
            status: "partial",
            coverage_start: start,
            coverage_end: end,
            cursor: null,
          },
        ],
      );
    });
    afterEach(async () => {
      await store?.close();
    });
    const options = (request: unknown) => ({
      policy,
      store,
      principal_id: owner,
      now,
      request,
    });
    it("commits accepted provider records, completes only valid pages and safely replays", async () => {
      const request = { ...page(), cursor: null, complete: true };
      const first = await handleSocialSync(options(request));
      expect(first).toMatchObject({
        accepted: 1,
        quarantined: 0,
        removed: 0,
        complete: true,
        status: "current",
      });
      expect(JSON.stringify(first)).not.toContain("send it");
      expect(JSON.stringify(first)).not.toContain("owner-user");
      expect(await handleSocialSync(options(request))).toMatchObject({
        accepted: 0,
        complete: true,
        page_hash: first.page_hash,
      });
      expect(await store.counts(owner)).toEqual({
        interactions: 1,
        commitments: 0,
      });
    });
    it("keeps quarantined pages incomplete and rejects malformed envelopes before writes", async () => {
      expect(
        await handleSocialSync(
          options({
            ...page(),
            items: [{ ...message(), sender_id: "foreign" }],
            cursor: null,
            complete: true,
          }),
        ),
      ).toMatchObject({
        accepted: 0,
        quarantined: 1,
        complete: false,
        status: "partial",
      });
      await expect(
        handleSocialSync(
          options({ ...page(), arbitrary_host: "https://evil.invalid" }),
        ),
      ).rejects.toThrow("field");
      expect((await store.counts(owner)).interactions).toBe(0);
    });
    it("uses only approved account/current window and rejects revoked channels", async () => {
      await expect(
        handleSocialSync(options({ ...page(), account_id: "foreign" })),
      ).rejects.toThrow("approved");
      await expect(
        handleSocialSync(
          options({ ...page(), coverage_start: "2026-09-15T12:00:00.000Z" }),
        ),
      ).rejects.toThrow("window");
      await store.revokeSource(owner, "whatsapp_personal");
      await expect(handleSocialSync(options(page()))).rejects.toThrow(
        "revoked",
      );
    });
    it("keeps cursor and records unchanged when a provider page races", async () => {
      await handleSocialSync(options(page()));
      await expect(
        handleSocialSync(
          options({
            ...page(),
            items: [{ ...message(), id: "message-two" }],
            cursor: "third",
          }),
        ),
      ).rejects.toThrow("cursor");
      expect((await store.counts(owner)).interactions).toBe(1);
      expect((await store.sourceStatus(owner))[0]!.cursor).toBe("page-two");
    });
    it("removes genuinely deleted evidence and preserves original time on edited events", async () => {
      await handleSocialSync(options(page()));
      const edit = {
        account_id: "personal-one",
        account_type: "WHATSAPP",
        account_info: { user_id: "owner-user" },
        event: "message_edited",
        message_id: "message-one",
        chat_id: "thread-one",
        timestamp: "2026-10-14T11:00:00Z",
        message: "I'll share it.",
        sender: { attendee_provider_id: "other-user" },
        attendees: [
          { attendee_provider_id: "owner-user" },
          { attendee_provider_id: "other-user" },
        ],
      };
      const request = {
        ...page(),
        format: "unipile_webhook" as const,
        items: [edit],
        expected_cursor: "page-two",
        cursor: "third",
      };
      expect(await handleSocialSync(options(request))).toMatchObject({
        accepted: 1,
      });
      expect(
        (
          await store.originalMessageTimes(
            owner,
            "whatsapp_personal",
            "personal-one",
          )
        )["message-one"],
      ).toBe("2026-10-13T12:00:00.000Z");
      expect(
        await handleSocialSync(
          options({
            ...request,
            items: [{ ...edit, event: "message_deleted" }],
            expected_cursor: "third",
            cursor: null,
            complete: true,
          }),
        ),
      ).toMatchObject({ accepted: 0, removed: 1, complete: true });
      expect((await store.counts(owner)).interactions).toBe(0);
    });
  },
);
