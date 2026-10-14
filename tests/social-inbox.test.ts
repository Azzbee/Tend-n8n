import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import {
  SocialInbox,
  SocialInboxError,
  type SocialInboxOptions,
} from "../src/social-inbox.ts";
import type { SocialPolicy } from "../src/social-policy.ts";
import { postgresTestRuntime } from "./postgres-test-runtime.ts";
import { PostgresStore } from "../src/postgres-store.ts";
import { normalizeMetaWebhook } from "../src/messaging-records.ts";

const principal = {
  owner_id: "inbox-owner",
  user_id: "inbox-user",
  chat_id: "inbox-chat",
};
const policy: SocialPolicy = {
  window_days: 30,
  accounts: [
    {
      source: "whatsapp_business",
      provider: "meta",
      account_id: "fictional-waba",
      owner_identity: "33123456789",
      owner_verified: true,
      business_phone_number_id: "fictional-phone",
    },
  ],
};
const secret = "fictional-hmac-only";
let now = new Date("2026-10-14T12:00:00Z");
let runtime: Awaited<ReturnType<typeof postgresTestRuntime>>;
let pool: Pool;
let inbox: SocialInbox;
let options: SocialInboxOptions;
function message(
  id = "wamid.one",
  at = new Date(now.getTime() - 60000),
  text = "Je vais envoyer le rapport.",
) {
  return {
    id,
    from: "33987654321",
    timestamp: String(Math.floor(at.getTime() / 1000)),
    type: "text",
    text: { body: text },
  };
}
function envelope(messages: unknown[] = [message()], field = "messages") {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "fictional-waba",
        changes: [
          {
            field,
            value: {
              metadata: { phone_number_id: "fictional-phone" },
              messages,
            },
          },
        ],
      },
    ],
  };
}
function wire(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value));
}
function signature(body: Buffer): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}
async function accept(value: unknown = envelope()) {
  const body = wire(value);
  return inbox.acceptMeta(body, signature(body), secret);
}
async function row() {
  return (
    await pool.query(
      "SELECT * FROM live_social_inbox ORDER BY received_at,event_id LIMIT 1",
    )
  ).rows[0] as Record<string, unknown> | undefined;
}
async function count(): Promise<number> {
  return Number(
    (await pool.query("SELECT count(*) AS n FROM live_social_inbox")).rows[0]
      ?.n,
  );
}

describe("authenticated filtered PostgreSQL Meta inbox", () => {
  beforeAll(async () => {
    runtime = await postgresTestRuntime();
    pool = new Pool({ connectionString: runtime.connectionString });
    await pool.query(
      readFileSync(
        new URL("../schema/002-live-runtime.sql", import.meta.url),
        "utf8",
      ),
    );
    await pool.query("INSERT INTO live_runtime_principal VALUES($1,$2,$3)", [
      principal.owner_id,
      principal.user_id,
      principal.chat_id,
    ]);
    const state = {
      owner_id: principal.owner_id,
      source: "whatsapp_business",
      account_id: "fictional-waba",
      mode: "live",
      status: "partial",
    };
    await pool.query(
      "INSERT INTO live_accounts VALUES($1,'whatsapp_business','fictional-waba',$2::jsonb)",
      [principal.owner_id, JSON.stringify(state)],
    );
    options = {
      connectionString: runtime.connectionString,
      principal,
      policy,
      account_id: "fictional-waba",
      max_body_bytes: 1048576,
      clock: () => now,
    };
    inbox = await SocialInbox.open(options);
    await pool.query("CREATE TABLE consumer_marks(id text PRIMARY KEY)");
  }, 60000);
  afterAll(async () => {
    if (inbox) await inbox.close();
    if (pool) await pool.end();
    runtime?.close();
  });
  beforeEach(async () => {
    now = new Date("2026-10-14T12:00:00Z");
    await pool.query("TRUNCATE live_social_inbox,consumer_marks");
    await pool.query("TRUNCATE live_records CASCADE");
    await pool.query(
      "UPDATE live_accounts SET state=jsonb_set(state,'{status}','\"partial\"') WHERE owner_id=$1",
      [principal.owner_id],
    );
  });
  it("authenticates before persistence, deduplicates concurrent delivery, and survives reopening", async () => {
    const receipts = await Promise.all(
      Array.from({ length: 6 }, () => accept()),
    );
    expect(new Set(receipts.map((item) => item.event_id)).size).toBe(1);
    expect(receipts.filter((item) => !item.duplicate)).toHaveLength(1);
    expect(await count()).toBe(1);
    const stored = await row();
    expect(stored?.body_hash).toBe(receipts[0]?.event_id);
    expect(JSON.stringify(stored)).not.toContain(secret);
    expect(stored?.payload).toMatchObject({
      results: [
        {
          kind: "accepted",
          record: { body_text: "Je vais envoyer le rapport." },
        },
      ],
    });
    await inbox.close();
    inbox = await SocialInbox.open(options);
    expect(await accept()).toMatchObject({
      duplicate: true,
      event_id: receipts[0]?.event_id,
    });
  });
  it("rejects bad signatures, malformed JSON and byte budgets without rows", async () => {
    const body = wire(envelope());
    await expect(
      inbox.acceptMeta(body, "sha256=" + "0".repeat(64), secret),
    ).rejects.toMatchObject({ code: "invalid_signature", status: 403 });
    await expect(
      inbox.acceptMeta(body, signature(Buffer.from("different")), secret),
    ).rejects.toThrow("invalid_signature");
    for (const malformed of [Buffer.from("{"), Buffer.from([255])])
      await expect(
        inbox.acceptMeta(malformed, signature(malformed), secret),
      ).rejects.toMatchObject({ code: "invalid_json", status: 400 });
    const oversized = Buffer.alloc(1048577);
    await expect(
      inbox.acceptMeta(oversized, signature(oversized), secret),
    ).rejects.toMatchObject({ code: "body_over_budget", status: 413 });
    expect(await count()).toBe(0);
  });
  it("rejects foreign and mixed WABA or phone bindings before retaining any record", async () => {
    const foreign = envelope();
    foreign.entry[0]!.id = "foreign-waba";
    const mixed = envelope();
    mixed.entry.push(foreign.entry[0]!);
    const phone = envelope();
    phone.entry[0]!.changes[0]!.value.metadata.phone_number_id =
      "foreign-phone";
    const mixedPhones = envelope();
    mixedPhones.entry[0]!.changes.push(phone.entry[0]!.changes[0]!);
    for (const value of [foreign, mixed, phone, mixedPhones])
      await expect(accept(value)).rejects.toBeInstanceOf(SocialInboxError);
    expect(await count()).toBe(0);
    await expect(
      SocialInbox.open({
        ...options,
        principal: { ...principal, user_id: "foreign-user" },
      }),
    ).rejects.toThrow("principal_mismatch");
  });
  it("retains only approved-window normalized history and safe quarantine metadata", async () => {
    const body = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "fictional-waba",
          changes: [
            {
              field: "history",
              value: {
                metadata: { phone_number_id: "fictional-phone" },
                history: [
                  {
                    threads: [
                      {
                        id: "33987654321",
                        messages: [
                          message(
                            "old",
                            new Date("2026-06-01T12:00:00Z"),
                            "OUT_OF_SCOPE_SECRET_TEXT",
                          ),
                          message("recent"),
                        ],
                      },
                    ],
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    await accept(body);
    const stored = await row();
    expect(JSON.stringify(stored)).not.toContain("OUT_OF_SCOPE_SECRET_TEXT");
    expect(stored?.payload).toMatchObject({
      results: [
        { kind: "expired", source_record_id: "old" },
        { kind: "accepted", record: { source_record_id: "recent" } },
      ],
      progress: { entries: 1, changes: 1, fields: ["history"] },
    });
    await pool.query("TRUNCATE live_social_inbox");
    await accept(
      envelope([
        {
          ...message(),
          type: "image",
          image: { caption: "UNSUPPORTED_PRIVATE_CAPTION" },
        },
      ]),
    );
    expect(JSON.stringify(await row())).not.toContain(
      "UNSUPPORTED_PRIVATE_CAPTION",
    );
    expect((await row())?.payload).toMatchObject({
      results: [{ kind: "quarantined", reason: "unsupported_message_type" }],
    });
  });
  it("refuses unsupported WABA-only account or disconnect callbacks without phone binding", async () => {
    await expect(
      accept({
        object: "whatsapp_business_account",
        entry: [
          {
            id: "fictional-waba",
            changes: [
              { field: "account_update", value: { event: "DISCONNECTED" } },
            ],
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "foreign_or_invalid_phone", status: 403 });
    expect(await count()).toBe(0);
  });
  it("permits stale registered sources but rechecks mode and database peer on every delivery", async () => {
    await pool.query(
      "UPDATE live_accounts SET state=jsonb_set(state,'{status}','\"stale\"') WHERE owner_id=$1",
      [principal.owner_id],
    );
    expect(await accept()).toMatchObject({ status: "pending" });
    try {
      await pool.query(
        "UPDATE live_accounts SET state=jsonb_set(state,'{mode}','\"fixture\"') WHERE owner_id=$1",
        [principal.owner_id],
      );
      await expect(accept(envelope([message("wrong-mode")]))).rejects.toThrow(
        "unregistered_live_account",
      );
      await pool.query(
        "UPDATE live_accounts SET state=jsonb_set(state,'{mode}','\"live\"') WHERE owner_id=$1",
        [principal.owner_id],
      );
      await pool.query(
        "UPDATE live_runtime_principal SET user_id='foreign-peer' WHERE owner_id=$1",
        [principal.owner_id],
      );
      await expect(accept(envelope([message("wrong-peer")]))).rejects.toThrow(
        "principal_mismatch",
      );
    } finally {
      await pool.query(
        "UPDATE live_accounts SET state=jsonb_set(state,'{mode}','\"live\"') WHERE owner_id=$1",
        [principal.owner_id],
      );
      await pool.query(
        "UPDATE live_runtime_principal SET user_id=$2 WHERE owner_id=$1",
        [principal.owner_id, principal.user_id],
      );
    }
    expect(await count()).toBe(1);
  });
  it("expires text before its30day boundary or24h and exposes resync counts", async () => {
    await accept(
      envelope([
        message(
          "near-boundary",
          new Date(now.getTime() - 30 * 86400000 + 1000),
        ),
      ]),
    );
    expect((await row())?.expires_at).toEqual(new Date(now.getTime() + 1000));
    now = new Date(now.getTime() + 1001);
    expect(await inbox.expire()).toBe(1);
    expect(await row()).toMatchObject({
      status: "expired",
      payload: null,
      needs_resync: true,
    });
    expect(await inbox.audit()).toMatchObject({
      expired: 1,
      needs_resync: 1,
      processed: 0,
    });
    expect(await inbox.claim()).toBeNull();
    await pool.query("TRUNCATE live_social_inbox");
    await accept();
    now = new Date(now.getTime() + 86400001);
    expect(await inbox.claim()).toBeNull();
    expect(await row()).toMatchObject({ status: "expired", payload: null });
  });
  it("uses canonical original timestamps so edits cannot renew old message retention", async () => {
    const original = normalizeMetaWebhook(
      envelope([
        message(
          "original-old",
          new Date(now.getTime() - 30 * 86400000 + 60000),
        ),
      ]),
      {
        principal_id: principal.owner_id,
        account_id: "fictional-waba",
        owner_identity: "33123456789",
        now,
        authenticated: { provider: "meta", account_id: "fictional-waba" },
        business_phone_number_id: "fictional-phone",
      },
    )[0];
    if (original?.kind !== "accepted")
      throw new Error("Invalid fictional original");
    const canonical = await PostgresStore.open({
      connectionString: runtime.connectionString,
      principal,
      clock: () => now,
    });
    try {
      await canonical.seed(original.contacts, original.identities, []);
      await canonical.ingest(original.record);
    } finally {
      await canonical.close();
    }
    now = new Date(now.getTime() + 120000);
    await accept(
      envelope([
        {
          ...message("edit-event", now),
          type: "edit",
          edit: {
            original_message_id: "original-old",
            message: { type: "text", text: { body: "DO_NOT_RETAIN_OLD_EDIT" } },
          },
        },
      ]),
    );
    expect((await row())?.payload).toMatchObject({
      results: [{ kind: "expired", source_record_id: "original-old" }],
    });
    expect(JSON.stringify(await row())).not.toContain("DO_NOT_RETAIN_OLD_EDIT");
  });
  it("claims distinct rows concurrently and blocks stale leases after expiry", async () => {
    await accept(envelope([message("one")]));
    await accept(envelope([message("two")]));
    const claims = await Promise.all([inbox.claim(1), inbox.claim(1)]);
    expect(claims.every(Boolean)).toBe(true);
    expect(new Set(claims.map((lease) => lease?.event_id)).size).toBe(2);
    expect(await inbox.claim()).toBeNull();
    now = new Date(now.getTime() + 1001);
    const reclaimed = await inbox.claim(1);
    expect(reclaimed).not.toBeNull();
    const old = claims.find(
      (lease) => lease?.event_id === reclaimed?.event_id,
    )!;
    await expect(inbox.complete(old!, async () => undefined)).rejects.toThrow(
      "lease_lost",
    );
    expect(reclaimed?.lease_id).not.toBe(old?.lease_id);
  });
  it("commits consumer SQL and scrubbed receipt together, rolling both back on failure", async () => {
    await accept();
    const lease = await inbox.claim();
    expect(lease).not.toBeNull();
    await expect(
      inbox.complete(lease!, async (client) => {
        await client.query(
          "INSERT INTO consumer_marks VALUES('must-rollback')",
        );
        throw new Error("fictional consumer failure");
      }),
    ).rejects.toMatchObject({ retryable: true, status: 503 });
    expect(
      (await pool.query("SELECT count(*) AS n FROM consumer_marks")).rows[0]?.n,
    ).toBe("0");
    expect(await row()).toMatchObject({
      status: "leased",
      payload: expect.any(Object),
    });
    await inbox.complete(lease!, async (client, payload) => {
      expect(payload.results[0]?.kind).toBe("accepted");
      await client.query("INSERT INTO consumer_marks VALUES('committed')");
    });
    expect(await row()).toMatchObject({
      status: "processed",
      payload: null,
      lease_id: null,
    });
    expect(
      (await pool.query("SELECT count(*) AS n FROM consumer_marks")).rows[0]?.n,
    ).toBe("1");
    expect(await accept()).toMatchObject({
      duplicate: true,
      status: "processed",
    });
  });
  it("does not complete a lease that expires during the SQL callback", async () => {
    await accept();
    const lease = await inbox.claim(1);
    await expect(
      inbox.complete(lease!, async (client) => {
        await client.query("INSERT INTO consumer_marks VALUES('late')");
        now = new Date(now.getTime() + 1001);
      }),
    ).rejects.toThrow("lease_lost");
    expect(
      (await pool.query("SELECT count(*) AS n FROM consumer_marks")).rows[0]?.n,
    ).toBe("0");
  });
  it("backs off failed attempts and scrubs after5 failures with visible resync state", async () => {
    await accept();
    for (let attempt = 1; attempt <= 5; attempt++) {
      const lease = await inbox.claim();
      expect(lease).not.toBeNull();
      await inbox.fail(lease!);
      expect(await inbox.claim()).toBeNull();
      now = new Date(now.getTime() + 60000);
    }
    expect(await row()).toMatchObject({
      status: "failed",
      attempts: 5,
      payload: null,
      needs_resync: true,
    });
    expect(await inbox.audit()).toMatchObject({ failed: 1, needs_resync: 1 });
  });
  it("purges pending and claimed payload atomically when the source is revoked", async () => {
    await accept();
    const lease = await inbox.claim();
    await pool.query(
      "UPDATE live_accounts SET state=jsonb_set(state,'{status}','\"revoked\"') WHERE owner_id=$1",
      [principal.owner_id],
    );
    expect(await row()).toMatchObject({
      status: "revoked",
      payload: null,
      lease_id: null,
    });
    await expect(accept()).rejects.toThrow("source_revoked");
    await expect(inbox.claim()).rejects.toThrow("source_revoked");
    await expect(inbox.complete(lease!, async () => undefined)).rejects.toThrow(
      "source_revoked",
    );
  });
  it("rejects capacity without acknowledgment, but still acknowledges persisted duplicates", async () => {
    const receipt = await accept();
    await pool.query(
      "INSERT INTO live_social_inbox(owner_id,account_id,event_id,body_hash,payload,received_at,expires_at,status,available_at) SELECT $1,'fictional-waba',lpad(i::text,64,'0'),lpad(i::text,64,'0'),'{}'::jsonb,$2::timestamptz,$2::timestamptz+interval '24 hours','pending',$2::timestamptz FROM generate_series(1,499) i",
      [principal.owner_id, now],
    );
    expect(await accept()).toMatchObject({
      duplicate: true,
      event_id: receipt.event_id,
    });
    await expect(
      accept(envelope([message("over-capacity")])),
    ).rejects.toMatchObject({
      code: "inbox_full",
      status: 503,
      retryable: true,
    });
    expect(await count()).toBe(500);
  });
  it("does not acknowledge or retain a write when a precommit database operation fails", async () => {
    await pool.query(
      "CREATE OR REPLACE FUNCTION reject_test_inbox_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fictional precommit failure'; END $$; CREATE CONSTRAINT TRIGGER reject_test_inbox AFTER INSERT ON live_social_inbox DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_test_inbox_insert()",
    );
    try {
      await expect(accept()).rejects.toMatchObject({
        code: "storage_unavailable",
        status: 503,
        retryable: true,
      });
      expect(await count()).toBe(0);
    } finally {
      await pool.query(
        "DROP TRIGGER reject_test_inbox ON live_social_inbox; DROP FUNCTION reject_test_inbox_insert()",
      );
    }
  });
});
