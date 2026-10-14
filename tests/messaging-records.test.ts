import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import {
  normalizeUnipileMessage,
  normalizeUnipileWebhook,
  normalizeMetaWebhook,
  normalizeLinkedInSnapshot,
  normalizeLinkedInChange,
  verifyMetaSignature,
  type MessagingContext,
} from "../src/messaging-records.ts";
const now = new Date("2026-10-14T12:00:00Z");
const ctx: MessagingContext = {
  principal_id: "owner",
  account_id: "account-one",
  owner_identity: "owner-user",
  now,
  authenticated: { provider: "unipile", account_id: "account-one" },
};
const msg = () => ({
  id: "message-one",
  account_id: "account-one",
  chat_id: "chat-one",
  sender_id: "other-user",
  timestamp: "2026-10-13T12:00:00Z",
  is_sender: false,
  text: "I'll send the draft.",
  attendees: [
    { attendee_provider_id: "owner-user" },
    { attendee_provider_id: "other-user", attendee_name: "Mira" },
  ],
});
const accepted = (result: ReturnType<typeof normalizeUnipileMessage>) => {
  expect(result.kind).toBe("accepted");
  if (result.kind !== "accepted") throw new Error("expected accepted");
  return result;
};
describe("Unipile personal messages", () => {
  it("excludes authenticated system events without accepting them as evidence", () => {
    for (const is_event of [true, 1]) {
      const result = normalizeUnipileMessage(
        { ...msg(), is_event },
        ctx,
        "whatsapp_personal",
      );
      expect(result).toMatchObject({
        kind: "excluded",
        source_record_id: "message-one",
      });
      expect(result).not.toHaveProperty("record");
      expect(
        normalizeUnipileMessage(
          { ...msg(), is_event, account_id: "foreign" },
          ctx,
          "whatsapp_personal",
        ).kind,
      ).toBe("quarantined");
    }
  });
  it("keeps distinct stable quarantine identities without retaining invalid bodies", () => {
    const a = normalizeUnipileMessage(
      { ...msg(), id: "bad-one", is_sender: "bad" },
      ctx,
      "whatsapp_personal",
    );
    const b = normalizeUnipileMessage(
      { ...msg(), id: "bad-two", is_sender: "bad" },
      ctx,
      "whatsapp_personal",
    );
    expect(a).toMatchObject({
      kind: "quarantined",
      source_record_id: "bad-one",
    });
    expect(b).toMatchObject({
      kind: "quarantined",
      source_record_id: "bad-two",
    });
    const unknownA = normalizeUnipileMessage(
      { account_id: "account-one", text: "PRIVATE BAD A" },
      ctx,
      "whatsapp_personal",
    );
    const unknownB = normalizeUnipileMessage(
      { account_id: "account-one", text: "PRIVATE BAD B" },
      ctx,
      "whatsapp_personal",
    );
    if (unknownA.kind === "accepted" || unknownB.kind === "accepted")
      throw new Error("Invalid fixture accepted");
    expect(unknownA.source_record_id).toMatch(/^invalid-record:[a-f0-9]{64}$/);
    expect(unknownB.source_record_id).not.toBe(unknownA.source_record_id);
    expect(JSON.stringify([unknownA, unknownB])).not.toContain("PRIVATE BAD");
  });
  it("honors documented numeric deleted/hidden/event flags", () => {
    expect(
      normalizeUnipileMessage(
        { ...msg(), deleted: 1 },
        ctx,
        "whatsapp_personal",
      ),
    ).toMatchObject({ kind: "deleted", source_record_id: "message-one" });
    expect(
      normalizeUnipileMessage(
        { ...msg(), hidden: 1 },
        ctx,
        "whatsapp_personal",
      ),
    ).toMatchObject({ kind: "invalidated", source_record_id: "message-one" });
    expect(
      normalizeUnipileMessage(
        { ...msg(), is_event: 1 },
        ctx,
        "whatsapp_personal",
      ),
    ).toMatchObject({
      kind: "excluded",
      source_record_id: "message-one",
      reason: "provider_system_event",
    });
    expect(
      normalizeUnipileMessage(
        { ...msg(), deleted: "1" },
        ctx,
        "whatsapp_personal",
      ).kind,
    ).toBe("quarantined");
    expect(
      accepted(
        normalizeUnipileMessage(
          { ...msg(), edited: 1, text: "I'll send the revision." },
          ctx,
          "whatsapp_personal",
        ),
      ).record.body_text,
    ).toContain("revision");
  });
  it("does not renew an already-retained edited message timestamp", () => {
    expect(
      normalizeUnipileMessage(
        { ...msg(), edited: 1 },
        {
          ...ctx,
          original_message_times: { "message-one": "2026-09-01T00:00:00Z" },
        },
        "whatsapp_personal",
      ).kind,
    ).toBe("expired");
  });
  it("binds the account and direction, preserving source provenance", () => {
    const r = accepted(
      normalizeUnipileMessage(msg(), ctx, "whatsapp_personal"),
    );
    expect(r.record.direction).toBe("received");
    expect(r.record.actor_identity).toBe("unipile:account-one:other-user");
    expect(r.record.eligible_for_extraction).toBe(true);
    expect(r.record.source_record_id).toBe("message-one");
    expect(r.record.source).toBe("whatsapp_personal");
  });
  it("never merges display names across IDs or accounts", () => {
    const a = accepted(
      normalizeUnipileMessage(msg(), ctx, "whatsapp_personal"),
    );
    const b = accepted(
      normalizeUnipileMessage(
        {
          ...msg(),
          sender_id: "different",
          attendees: [
            { attendee_provider_id: "owner-user" },
            { attendee_provider_id: "different", attendee_name: "Mira" },
          ],
        },
        ctx,
        "whatsapp_personal",
      ),
    );
    expect(a.contacts[0]?.contact_id).not.toBe(b.contacts[0]?.contact_id);
  });
  it.each([
    { account_id: "foreign" },
    { sender_id: "owner-user", is_sender: false },
    { is_sender: "false" },
    { timestamp: "not-date" },
    { timestamp: "2026-02-30T00:00:00Z" },
    { text: "x".repeat(262145) },
    { timestamp: Number.POSITIVE_INFINITY },
    { is_event: "true" },
    { is_hidden: true },
  ])("quarantines malformed or foreign messages", (patch) =>
    expect(
      normalizeUnipileMessage({ ...msg(), ...patch }, ctx, "whatsapp_personal")
        .kind,
    ).toBe("quarantined"),
  );
  it("requires authenticated binding and rejects expired/future dates", () => {
    expect(
      normalizeUnipileMessage(
        msg(),
        { ...ctx, authenticated: null },
        "whatsapp_personal",
      ).kind,
    ).toBe("quarantined");
    expect(
      normalizeUnipileMessage(
        { ...msg(), timestamp: "2026-09-01T00:00:00Z" },
        ctx,
        "whatsapp_personal",
      ).kind,
    ).toBe("expired");
    expect(
      normalizeUnipileMessage(
        { ...msg(), timestamp: "2026-10-15T00:00:00Z" },
        ctx,
        "whatsapp_personal",
      ).kind,
    ).toBe("quarantined");
  });
  it("keeps authored span offsets valid in the stored text", () => {
    const r = accepted(
      normalizeUnipileMessage(
        { ...msg(), text: " Hi\n  I'll send it.\n> I will write." },
        ctx,
        "whatsapp_personal",
      ),
    );
    for (const span of r.record.authored_spans)
      expect(r.record.authored_text.slice(span.start, span.end)).toBe(
        span.text,
      );
  });
  it("retains group context without extracting obligations", () => {
    const r = accepted(
      normalizeUnipileMessage(
        {
          ...msg(),
          attendees: [...msg().attendees, { attendee_provider_id: "third" }],
        },
        ctx,
        "whatsapp_personal",
      ),
    );
    expect(r.record.attribution).toBe("group");
    expect(r.record.eligible_for_extraction).toBe(false);
  });
  it("unknown chat membership cannot become direct attribution", () => {
    const { attendees: _ignored, ...input } = msg();
    void _ignored;
    expect(
      accepted(normalizeUnipileMessage(input, ctx, "whatsapp_personal")).record
        .attribution,
    ).toBe("unknown");
  });
  it("validates edit event timestamps as well as retained creation time", () => {
    const payload = {
      account_id: "account-one",
      account_type: "WHATSAPP",
      account_info: { user_id: "owner-user" },
      event: "message_edited",
      chat_id: "chat-one",
      message_id: "message-one",
      timestamp: "invalid",
      message: "I'll send it.",
      sender: { attendee_provider_id: "other-user" },
      attendees: msg().attendees,
    };
    expect(
      normalizeUnipileWebhook(
        payload,
        {
          ...ctx,
          original_message_times: { "message-one": "2026-10-13T12:00:00Z" },
        },
        "whatsapp_personal",
      ).kind,
    ).toBe("quarantined");
  });
  it("never renews an expired message through an edit event", () => {
    const payload = {
      account_id: "account-one",
      account_type: "WHATSAPP",
      account_info: { user_id: "owner-user" },
      event: "message_edited",
      chat_id: "chat-one",
      message_id: "message-one",
      timestamp: "2026-10-13T12:00:00Z",
      message: "I'll send it.",
      sender: { attendee_provider_id: "other-user" },
      attendees: msg().attendees,
    };
    expect(
      normalizeUnipileWebhook(payload, ctx, "whatsapp_personal"),
    ).toMatchObject({
      kind: "invalidated",
      reason: "original_message_time_required",
    });
    expect(
      normalizeUnipileWebhook(
        payload,
        {
          ...ctx,
          original_message_times: { "message-one": "2026-09-01T00:00:00Z" },
        },
        "whatsapp_personal",
      ).kind,
    ).toBe("expired");
  });
  it("handles webhook edits and deletion on the same stable message ID", () => {
    const payload = {
      account_id: "account-one",
      account_type: "WHATSAPP",
      account_info: { user_id: "owner-user" },
      event: "message_edited",
      chat_id: "chat-one",
      message_id: "message-one",
      timestamp: "2026-10-13T12:00:00Z",
      message: "I'll send the revised draft.",
      sender: { attendee_provider_id: "other-user" },
      attendees: msg().attendees,
    };
    const r = accepted(
      normalizeUnipileWebhook(
        payload,
        {
          ...ctx,
          original_message_times: { "message-one": "2026-10-13T12:00:00Z" },
        },
        "whatsapp_personal",
      ),
    );
    expect(r.record.source_record_id).toBe("message-one");
    expect(r.record.body_text).toContain("revised");
    expect(
      normalizeUnipileWebhook(
        { ...payload, event: "message_deleted" },
        ctx,
        "whatsapp_personal",
      ),
    ).toMatchObject({ kind: "deleted", source_record_id: "message-one" });
  });
});
const metaCtx: MessagingContext = {
  ...ctx,
  owner_identity: "33123456789",
  authenticated: { provider: "meta", account_id: "account-one" },
  business_phone_number_id: "phone-one",
};
const meta = (message: Record<string, unknown>, field = "messages") => ({
  object: "whatsapp_business_account",
  entry: [
    {
      id: "account-one",
      changes: [
        {
          field,
          value: {
            metadata: { phone_number_id: "phone-one" },
            messages: [message],
          },
        },
      ],
    },
  ],
});
const metaMessage = () => ({
  id: "wamid.one",
  from: "33987654321",
  timestamp: String(Date.parse("2026-10-13T12:00:00Z") / 1000),
  type: "text",
  text: { body: "Je vais envoyer le rapport." },
});
describe("Meta official payloads", () => {
  it("applies inbound edits to original IDs without renewing creation time", () => {
    const edited = {
      ...metaMessage(),
      id: "edit-event",
      type: "edit",
      edit: {
        original_message_id: "wamid.one",
        message: {
          type: "text",
          text: { body: "Je vais envoyer la version corrigée." },
        },
      },
    };
    expect(
      normalizeMetaWebhook(meta(edited), {
        ...metaCtx,
        original_message_times: { "wamid.one": "2026-10-12T12:00:00Z" },
      })[0],
    ).toMatchObject({
      kind: "accepted",
      record: {
        source_record_id: "wamid.one",
        occurred_at: "2026-10-12T12:00:00.000Z",
        body_text: "Je vais envoyer la version corrigée.",
      },
    });
  });
  it("invalidates unsupported edited media and missing original times", () => {
    const edited = {
      ...metaMessage(),
      id: "edit-event",
      type: "edit",
      edit: {
        original_message_id: "wamid.one",
        message: {
          type: "image",
          image: {
            caption: "new caption",
            url: "https://private.invalid/not-fetched",
          },
        },
      },
    };
    expect(normalizeMetaWebhook(meta(edited), metaCtx)[0]).toMatchObject({
      kind: "invalidated",
      source_record_id: "wamid.one",
      reason: "edited_content_unavailable",
    });
    expect(
      normalizeMetaWebhook(
        meta({
          ...edited,
          edit: {
            ...edited.edit,
            message: { type: "text", text: { body: "new body" } },
          },
        }),
        metaCtx,
      )[0],
    ).toMatchObject({
      kind: "invalidated",
      source_record_id: "wamid.one",
      reason: "original_message_time_required",
    });
  });
  it("rejects future-dated edit and revoke triggers", () => {
    const future = {
      ...metaMessage(),
      id: "revoke-event",
      timestamp: String(now.getTime() / 1000 + 3600),
      type: "revoke",
      revoke: { original_message_id: "wamid.one" },
    };
    expect(normalizeMetaWebhook(meta(future), metaCtx)[0]?.kind).toBe(
      "quarantined",
    );
  });
  it("revokes original evidence rather than the webhook event ID", () => {
    expect(
      normalizeMetaWebhook(
        meta({
          ...metaMessage(),
          id: "revoke-event",
          type: "revoke",
          revoke: { original_message_id: "wamid.one" },
        }),
        metaCtx,
      )[0],
    ).toMatchObject({ kind: "deleted", source_record_id: "wamid.one" });
  });
  it("rejects outgoing text disguised as an incoming message", () => {
    expect(
      normalizeMetaWebhook(
        meta({
          ...metaMessage(),
          from: metaCtx.owner_identity,
          to: "33987654321",
        }),
        metaCtx,
      )[0]?.kind,
    ).toBe("quarantined");
  });

  it("verifies exact raw-body HMAC without accepting malformed signatures", () => {
    const body = Buffer.from('{"entry":[]}');
    const signature = `sha256=${createHmac("sha256", "fictional-secret").update(body).digest("hex")}`;
    expect(verifyMetaSignature(body, signature, "fictional-secret")).toBe(true);
    expect(
      verifyMetaSignature(
        Buffer.from("changed"),
        signature,
        "fictional-secret",
      ),
    ).toBe(false);
    expect(verifyMetaSignature(body, "sha256=x", "fictional-secret")).toBe(
      false,
    );
  });
  it("normalizes inbound text and rejects a foreign WABA/phone", () => {
    expect(normalizeMetaWebhook(meta(metaMessage()), metaCtx)[0]).toMatchObject(
      {
        kind: "accepted",
        record: { direction: "received", source: "whatsapp_business" },
      },
    );
    expect(
      normalizeMetaWebhook(meta(metaMessage()), {
        ...metaCtx,
        business_phone_number_id: "foreign",
      })[0]?.kind,
    ).toBe("quarantined");
  });
  it("accepts echoes only when the sender is the bound business owner", () => {
    const echo = {
      ...metaMessage(),
      from: metaCtx.owner_identity,
      to: "33987654321",
    };
    expect(
      normalizeMetaWebhook(meta(echo, "smb_message_echoes"), metaCtx)[0],
    ).toMatchObject({ kind: "accepted", record: { direction: "sent" } });
    expect(
      normalizeMetaWebhook(
        meta(metaMessage(), "smb_message_echoes"),
        metaCtx,
      )[0]?.kind,
    ).toBe("quarantined");
  });
  it("extracts bounded history chunks, never attachments", () => {
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "account-one",
          changes: [
            {
              field: "history",
              value: {
                metadata: { phone_number_id: "phone-one" },
                history: [
                  {
                    threads: [{ id: "33987654321", messages: [metaMessage()] }],
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    expect(normalizeMetaWebhook(payload, metaCtx)[0]).toMatchObject({
      kind: "accepted",
      record: { ingestion_mode: "snapshot" },
    });
    expect(
      normalizeMetaWebhook(
        meta({
          ...metaMessage(),
          type: "image",
          image: { id: "must-not-fetch" },
        }),
        metaCtx,
      )[0]?.kind,
    ).toBe("quarantined");
  });
});
const liCtx: MessagingContext = {
  ...ctx,
  account_id: "urn:li:person:owner",
  owner_identity: "urn:li:person:owner",
  authenticated: { provider: "linkedin", account_id: "urn:li:person:owner" },
};
const liChange = () => ({
  id: 123,
  activityId: "activity-one",
  owner: liCtx.account_id,
  actor: "urn:li:person:other",
  resourceName: "messages",
  resourceId: "message-one",
  method: "CREATE",
  capturedAt: now.getTime() - 1000,
  processedAt: now.getTime(),
  activityStatus: "SUCCESS",
  processedActivity: {
    author: "urn:li:person:other",
    thread: "urn:li:messagingThread:thread-one",
    content: { content: { string: "I'll call you." } },
    "thread~": {
      membership: [
        { identity: liCtx.owner_identity },
        { identity: "urn:li:person:other" },
      ],
    },
  },
});
describe("LinkedIn official portability", () => {
  it("resolves decorated sales identities by member URN, never by name", () => {
    const change = liChange();
    const r = accepted(
      normalizeLinkedInChange(
        {
          ...change,
          processedActivity: {
            ...change.processedActivity,
            "thread~": {
              membership: [
                {
                  identity: "urn:li:salesIdentity:123",
                  "identity~": { member: liCtx.owner_identity },
                },
                { identity: "urn:li:person:other" },
              ],
            },
          },
        },
        liCtx,
      ),
    );
    expect(r.record.attribution).toBe("direct");
  });

  it("binds owner and actor and keeps resource IDs stable across replay", () => {
    const a = accepted(normalizeLinkedInChange(liChange(), liCtx));
    const b = accepted(
      normalizeLinkedInChange(
        { ...liChange(), id: 456, activityStatus: "SUCCESSFUL_REPLAY" },
        liCtx,
      ),
    );
    expect(a.record.source_record_id).toBe(b.record.source_record_id);
    expect(a.record.direction).toBe("received");
    expect(a.record.attribution).toBe("direct");
  });
  it("fails closed on foreign owners, processing failure, actor mismatch and unknown methods", () => {
    for (const patch of [
      { owner: "foreign" },
      { activityStatus: "FAILURE" },
      { actor: "urn:li:person:spoof" },
      { method: "ACTION" },
    ])
      expect(
        normalizeLinkedInChange({ ...liChange(), ...patch }, liCtx).kind,
      ).toBe("quarantined");
  });
  it("uses original creation time for updates instead of reviving expired evidence", () => {
    const change = liChange();
    expect(
      normalizeLinkedInChange({ ...change, method: "UPDATE" }, liCtx),
    ).toMatchObject({
      kind: "invalidated",
      reason: "original_message_time_required",
    });
    expect(
      normalizeLinkedInChange(
        {
          ...change,
          method: "UPDATE",
          processedActivity: {
            ...change.processedActivity,
            createdAt: Date.parse("2026-09-01T00:00:00Z"),
          },
        },
        liCtx,
      ).kind,
    ).toBe("expired");
  });
  it("normalizes delete without requiring removed content", () =>
    expect(
      normalizeLinkedInChange(
        { ...liChange(), method: "DELETE", processedActivity: {} },
        liCtx,
      ),
    ).toMatchObject({ kind: "deleted", source_record_id: "message-one" }));
  it("never attributes snapshot display names without verified profile binding", () => {
    const row = {
      "CONVERSATION ID": "thread-one",
      FROM: "Mira",
      TO: "Adam",
      DATE: "2026-10-13 12:00:00 UTC",
      CONTENT: "I'll call you.",
    };
    expect(normalizeLinkedInSnapshot(row, liCtx).kind).toBe("quarantined");
  });
  it("accepts explicitly bound snapshot profile identities and hashes full-row stable keys", () => {
    const row = {
      "CONVERSATION ID": "thread-one",
      FROM: "https://www.linkedin.com/in/mira",
      TO: "https://www.linkedin.com/in/owner",
      DATE: "2026-10-13T12:00:00Z",
      CONTENT: "I'll call you.",
    };
    const context = {
      ...liCtx,
      linkedin_profile_bindings: {
        [row.FROM]: "urn:li:person:other",
        [row.TO]: liCtx.owner_identity,
      },
    };
    const a = accepted(normalizeLinkedInSnapshot(row, context));
    expect(a.record.source_record_id).toBe(
      accepted(normalizeLinkedInSnapshot(row, context)).record.source_record_id,
    );
    expect(a.record.ingestion_mode).toBe("snapshot");
  });
});

describe("trusted Unipile WhatsApp source", () => {
  it("rejects a missing or non-WhatsApp trusted source at runtime", () => {
    for (const source of [undefined, "linkedin"] as const) {
      expect(() =>
        normalizeUnipileMessage(msg(), ctx, source as never),
      ).toThrow("unapproved_unipile_source");
      expect(() => normalizeUnipileWebhook({}, ctx, source as never)).toThrow(
        "unapproved_unipile_source",
      );
    }
  });
  it.each(["whatsapp_personal", "whatsapp_business"] as const)(
    "keeps %s attribution across all message outcomes",
    (source) => {
      const good = accepted(
        normalizeUnipileMessage({ ...msg(), source: "linkedin" }, ctx, source),
      );
      expect(good.record.source).toBe(source);
      expect(
        normalizeUnipileMessage(msg(), { ...ctx, authenticated: null }, source),
      ).toMatchObject({ source, kind: "quarantined" });
      expect(
        normalizeUnipileMessage(
          { ...msg(), edited: true },
          {
            ...ctx,
            original_message_times: { "message-one": "2020-01-01T00:00:00Z" },
          },
          source,
        ),
      ).toMatchObject({ source, kind: "expired" });
      const group = accepted(
        normalizeUnipileMessage(
          {
            ...msg(),
            attendees: [
              ...msg().attendees,
              { attendee_provider_id: "third-user" },
            ],
          },
          ctx,
          source,
        ),
      );
      expect(group.record.source).toBe(source);
      expect(group.record.eligible_for_extraction).toBe(false);

      for (const [patch, kind] of [
        [{ deleted: true }, "deleted"],
        [{ hidden: true }, "invalidated"],
        [{ is_event: true }, "excluded"],
        [{ sender_id: "owner-user" }, "quarantined"],
        [{ timestamp: "2020-01-01T00:00:00Z" }, "expired"],
      ] as const) {
        expect(
          normalizeUnipileMessage({ ...msg(), ...patch }, ctx, source),
        ).toMatchObject({ source, kind });
      }
      const payload = {
        account_id: ctx.account_id,
        account_type: "WHATSAPP",
        account_info: { user_id: ctx.owner_identity },
        event: "message_received",
        chat_id: "chat-one",
        message_id: "message-one",
        timestamp: "2026-10-13T12:00:00Z",
        sender: { attendee_provider_id: "other-user" },
        message: "I'll send it.",
        attendees: msg().attendees,
      };
      expect(
        accepted(normalizeUnipileWebhook(payload, ctx, source)).record.source,
      ).toBe(source);
      for (const [patch, kind] of [
        [{ event: "message_deleted" }, "deleted"],
        [{ event: "message_edited" }, "invalidated"],
        [{ account_id: "foreign" }, "quarantined"],
        [{ timestamp: "2020-01-01T00:00:00Z" }, "expired"],
      ] as const) {
        expect(
          normalizeUnipileWebhook({ ...payload, ...patch }, ctx, source),
        ).toMatchObject({ source, kind });
      }
    },
  );
});
