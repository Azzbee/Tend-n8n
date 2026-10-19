import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { TendStore, type LiveBatch } from "../src/engine.ts";
import { PostgresStore } from "../src/postgres-store.ts";
import { postgresTestRuntime } from "./postgres-test-runtime.ts";
import {
  calendarSnapshotDigest,
  normalizeCalendarSnapshot,
  normalizeCalendarEvent,
  normalizeGmailMessage,
  contactIdForEmail,
} from "../src/google-records.ts";
import {
  assertGoogleRead,
  exampleLivePolicy,
  parseLivePolicy,
  calendarWindow,
} from "../src/live-policy.ts";
import { createLiveServer } from "../src/live-api.ts";
import { InternalAuth, verificationHash } from "../src/internal-auth.ts";

const account = "essec-owner@example.invalid",
  eventId = "verified-occurrence-20261019";
const key = "FICTIONAL_ONLY_0123456789_abcdefghijklmnopqrstuvwxyz_ABCD";
const now = new Date("2026-10-19T09:30:01.000Z");
function capture() {
  return {
    calendar_id: account,
    captured_at: "2026-10-19T09:30:00.000Z",
    source_reference:
      "https://calendar.google.com/calendar/u/1/r?eid=" +
      Buffer.from(`${eventId} ${account}`).toString("base64url"),
    event: {
      id: eventId,
      summary: "Weekly review. I will send the slides tomorrow.",
      description: "<b>Meeting context</b>",
      start: {
        dateTime: "2026-10-19T17:00:00+02:00",
        timeZone: "Europe/Paris",
      },
      end: { dateTime: "2026-10-19T17:30:00+02:00", timeZone: "Europe/Paris" },
      organizer: {
        email: "organizer@example.invalid",
        displayName: "Organizer",
      },
      attendees: [
        {
          email: "organizer@example.invalid",
          displayName: "Organizer",
          responseStatus: "accepted",
        },
        {
          email: account,
          displayName: "Owner",
          responseStatus: "accepted",
          self: true,
        },
      ],
    },
  };
}
function policyFor(input: unknown = capture()) {
  return parseLivePolicy({
    ...exampleLivePolicy,
    manual_calendar_snapshots: [
      {
        calendar_id: account,
        event_id: eventId,
        capture_sha256: calendarSnapshotDigest(input),
      },
    ],
  });
}
async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("address");
  return `http://127.0.0.1:${address.port}`;
}

describe("inspected exact-event Calendar snapshots", () => {
  it("binds exactly one verified owner calendar without widening Google access", () => {
    const policy = policyFor();
    expect(policy.calendar_ids).toEqual(exampleLivePolicy.calendar_ids);
    expect(policy.verified_owner_emails).toEqual(
      exampleLivePolicy.verified_owner_emails,
    );
    expect(() =>
      assertGoogleRead(
        policy,
        policy.account_email,
        "calendar.events.get",
        account,
      ),
    ).toThrow("calendar not approved");
    for (const entry of [
      [],
      [
        policy.manual_calendar_snapshots![0],
        policy.manual_calendar_snapshots![0],
      ],
      [
        {
          ...policy.manual_calendar_snapshots![0],
          calendar_id: "not-an-email",
        },
      ],
      [
        {
          ...policy.manual_calendar_snapshots![0],
          capture_sha256: "not-a-hash",
        },
      ],
      [{ ...policy.manual_calendar_snapshots![0], reconcile: true }],
    ])
      expect(() =>
        parseLivePolicy({ ...policy, manual_calendar_snapshots: entry }),
      ).toThrow();
  });
  it("preserves source, inspection time and snapshot label without inventing provider fields", () => {
    const input = capture(),
      policy = policyFor(input);
    const result = normalizeCalendarSnapshot(input, policy, now);
    expect(result.kind).toBe("accepted");
    if (result.kind !== "accepted") throw new Error("accepted");
    expect(result.record).toMatchObject({
      account_id: account,
      source_record_id: eventId,
      ingestion_mode: "snapshot",
      observed_at: input.captured_at,
      evidence_reference: input.source_reference,
      eligible_for_extraction: false,
      authored_text: "",
      attribution: "direct",
    });
    expect(result.record.contact_ids).toHaveLength(1);
    expect(
      result.identities.some((identity) => identity.identity === account),
    ).toBe(false);
    expect(policy.verified_owner_emails).not.toContain(account);
    expect(result.record.body_text).toContain("Meeting context");
    for (const key of [
      "updated",
      "etag",
      "sequence",
      "recurringEventId",
      "originalStartTime",
    ])
      expect(result.record).not.toHaveProperty(key);
    expect(() =>
      normalizeCalendarEvent(input.event, {
        policy,
        now,
        account_email: policy.account_email,
        calendar_id: account,
      }),
    ).toThrow("calendar not approved");
    expect(
      calendarSnapshotDigest({
        event: input.event,
        source_reference: input.source_reference,
        calendar_id: input.calendar_id,
        captured_at: input.captured_at,
      }),
    ).toBe(calendarSnapshotDigest(input));
  });
  it("rejects uninspected modifications and stale, missing or future capture proof", () => {
    const input = capture(),
      policy = policyFor(input);
    for (const mutation of [
      { ...input, calendar_id: "other@example.invalid" },
      { ...input, event: { ...input.event, id: "another-event" } },
      {
        ...input,
        event: { ...input.event, summary: "Changed uninspected text" },
      },
      { ...input, captured_at: undefined },
      { ...input, inspection_proof: "fake" },
      { ...input, reconcile: true },
    ])
      expect(() => normalizeCalendarSnapshot(mutation, policy, now)).toThrow();
    expect(() =>
      normalizeCalendarSnapshot(
        input,
        policy,
        new Date("2026-10-19T10:30:00.001Z"),
      ),
    ).toThrow("stale");
    expect(() =>
      normalizeCalendarSnapshot(
        input,
        policy,
        new Date("2026-10-19T09:29:59.999Z"),
      ),
    ).toThrow("stale");
  });
  it("rejects misleading source references, cancellations and ambiguous guests even with a matching operator digest", () => {
    const input = capture();
    const malformed = [
      {
        ...input,
        source_reference: "https://attacker.example/calendar/u/1/r?eid=bad",
      },
      {
        ...input,
        source_reference:
          "https://calendar.google.com/calendar/u/1/r?eid=" +
          Buffer.from(`wrong-event ${account}`).toString("base64url"),
      },
      { ...input, event: { ...input.event, status: "cancelled" } },
      {
        ...input,
        event: { ...input.event, start: { dateTime: "2026-10-19T25:00:00Z" } },
      },
      { ...input, event: { ...input.event, end: input.event.start } },
      {
        ...input,
        event: {
          ...input.event,
          attendees: [...input.event.attendees, input.event.attendees[0]],
        },
      },
      {
        ...input,
        event: {
          ...input.event,
          attendees: input.event.attendees.map((a) => ({
            ...a,
            responseStatus: "needsAction",
          })),
        },
      },
      {
        ...input,
        event: {
          ...input.event,
          attendees: input.event.attendees.map((a) => ({ ...a, self: true })),
        },
      },
      {
        ...input,
        event: {
          ...input.event,
          attendees: input.event.attendees.map((a) => ({
            ...a,
            email: a.self ? "unverified@example.invalid" : a.email,
          })),
        },
      },
      {
        ...input,
        event: {
          ...input.event,
          attendees: input.event.attendees.map((a) => ({
            ...a,
            resource: true,
          })),
        },
      },
    ];
    for (const value of malformed) {
      let accepted = false;
      try {
        accepted =
          normalizeCalendarSnapshot(value, policyFor(value), now).kind ===
          "accepted";
      } catch {
        /* Invalid captures fail before storage. */
      }
      expect(accepted).toBe(false);
    }
  });
});

describe("snapshot import API and actual store parity", () => {
  let runtime: Awaited<ReturnType<typeof postgresTestRuntime>>;
  beforeAll(async () => {
    runtime = await postgresTestRuntime();
  }, 60000);
  afterAll(() => runtime?.close());
  for (const backend of ["sqlite", "postgres"] as const)
    it(`${backend}: imports one partial snapshot idempotently, keeps API polls separate and expires it`, async () => {
      const input = capture(),
        policy = policyFor(input),
        principal = {
          owner_id: policy.principal_id,
          user_id: "live-owner",
          chat_id: "live-private",
        };
      let clock = now;
      const store: TendStore | PostgresStore =
        backend === "sqlite"
          ? new TendStore(":memory:", {
              mode: "live",
              principal,
              clock: () => clock,
            })
          : await PostgresStore.open({
              connectionString: runtime.connectionString,
              principal,
              clock: () => clock,
            });
      const schoolContact = contactIdForEmail(principal.owner_id, account);
      const existingMail = normalizeGmailMessage(
        {
          id: "existing-school-mail",
          threadId: "existing-school-thread",
          internalDate: String(now.getTime()),
          labelIds: ["INBOX"],
          payload: {
            mimeType: "text/plain",
            headers: [
              { name: "From", value: account },
              { name: "To", value: policy.account_email },
            ],
            body: {
              data: Buffer.from("Existing school correspondence.").toString(
                "base64url",
              ),
            },
          },
        },
        { policy, now, account_email: policy.account_email },
      );
      if (existingMail.kind !== "accepted")
        throw new Error("accepted existing mail");
      await store.seed(
        [
          {
            owner_id: principal.owner_id,
            contact_id: schoolContact,
            name: "Existing school identity",
          },
        ],
        [
          {
            owner_id: principal.owner_id,
            identity: account,
            contact_id: schoolContact,
          },
        ],
        [
          {
            owner_id: principal.owner_id,
            source: "gmail",
            account_id: policy.account_email,
            mode: "live",
            last_success: null,
            status: "partial",
            cursor: null,
            coverage_start: existingMail.record.coverage_start,
            coverage_end: existingMail.record.coverage_end,
          },
        ],
      );
      await store.seed(existingMail.contacts, existingMail.identities, []);
      await store.ingest(existingMail.record);
      const server = createLiveServer({
        policy,
        store,
        auth: new InternalAuth(undefined, verificationHash(key)),
        clock: () => clock,
      });
      const base = await listen(server),
        headers = {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        };
      clock = new Date("2026-10-19T09:45:00.000Z");
      const post = (body: unknown, supplied = headers) =>
        fetch(base + "/api/live/calendar-snapshot", {
          method: "POST",
          headers: supplied,
          body: JSON.stringify(body),
        });
      try {
        expect(
          (
            await post(input, {
              Authorization: "",
              "Content-Type": "application/json",
            })
          ).status,
        ).toBe(401);
        expect((await post({ ...input, reconcile: true })).status).toBe(400);
        expect(
          (
            await post({
              ...input,
              source_reference: "https://example.invalid",
            })
          ).status,
        ).toBe(400);
        expect((await post(input)).status).toBe(200);
        const firstImportState = await store.sourceStatus(principal.owner_id);
        const repeated = await post(input);
        expect(repeated.status).toBe(200);
        expect(await store.sourceStatus(principal.owner_id)).toEqual(
          firstImportState,
        );
        expect(await repeated.json()).toMatchObject({
          accepted: 0,
          ingestion_mode: "snapshot",
          coverage: "partial manual snapshot",
          provider_api_verified: false,
        });
        expect(
          (await store.resolveContact(principal.owner_id, account)).contact_id,
        ).toBe(schoolContact);
        expect(policy.verified_owner_emails).toEqual(
          exampleLivePolicy.verified_owner_emails,
        );
        const state = (await store.sourceStatus(principal.owner_id)).find(
          (s) => s.account_id === account,
        )!;
        expect(state).toMatchObject({
          mode: "snapshot",
          status: "partial",
          evidence_incomplete: true,
          pagination_complete: false,
          last_success: null,
          coverage_start: calendarWindow(policy, clock).start,
          coverage_end: calendarWindow(policy, clock).end,
        });
        const auth = { ...principal, chat_type: "private", text: "/today" };
        const today = await store.command(auth);
        expect(today.meetings).toEqual([
          expect.objectContaining({
            account_id: account,
            ingestion_mode: "snapshot",
            observed_at: input.captured_at,
            coverage: "partial manual snapshot",
          }),
        ]);
        const prep = await store.command({
          ...auth,
          text: "/prep organizer@example.invalid",
        });
        expect(prep.evidence).toEqual([
          expect.objectContaining({
            ingestion_mode: "snapshot",
            observed_at: input.captured_at,
            coverage: "partial manual snapshot",
          }),
        ]);
        expect((await store.counts(principal.owner_id)).commitments).toBe(0);
        const record = (await store.interactions(principal.owner_id)).find(
          (record) => record.source === "calendar",
        )!;
        await expect(
          Promise.resolve().then(() =>
            store.addCandidate(record, {
              quote: input.event.summary,
              action: "Send slides",
              suggested_due: null,
            }),
          ),
        ).rejects.toThrow();
        for (let i = 0; i < 4; i++) {
          const result = await fetch(
            base + "/api/live/sync-state?source=calendar",
            { headers },
          );
          expect(result.status).toBe(200);
          expect(
            ((await result.json()) as { calendar_id: string }).calendar_id,
          ).not.toBe(account);
        }
        const snapshotResult = normalizeCalendarSnapshot(input, policy, now);
        if (snapshotResult.kind !== "accepted") throw new Error("accepted");
        const batch: LiveBatch = {
          owner_id: principal.owner_id,
          source: "calendar",
          account_id: account,
          records: [snapshotResult.record],
          contacts: snapshotResult.contacts,
          identities: snapshotResult.identities,
          cursor: null,
          expected_cursor: null,
          complete: false,
          reconcile: false,
          evidence_incomplete: true,
          coverage_start: state.coverage_start,
          coverage_end: state.coverage_end,
          seen_record_ids: [eventId],
        };
        for (const mutation of [
          { reconcile: true },
          { complete: true },
          { removed_record_ids: [eventId] },
          { cursor: "fake-page" },
          { records: [] },
        ])
          await expect(
            Promise.resolve().then(() =>
              store.commitLiveBatch({ ...batch, ...mutation }),
            ),
          ).rejects.toThrow("single partial calendar snapshot");
        const mail = normalizeGmailMessage(
          {
            id: "school-mail-after-snapshot",
            threadId: "school-thread",
            internalDate: String(now.getTime()),
            labelIds: ["INBOX"],
            payload: {
              mimeType: "text/plain",
              headers: [
                { name: "From", value: account },
                { name: "To", value: policy.account_email },
              ],
              body: {
                data: Buffer.from("School calendar information.").toString(
                  "base64url",
                ),
              },
            },
          },
          { policy, now, account_email: policy.account_email },
        );
        expect(mail.kind).toBe("accepted");
        if (mail.kind !== "accepted") throw new Error("accepted mail");
        expect(mail.record.direction).toBe("received");
        expect(mail.record.contact_ids).toContain(schoolContact);
        await store.seed(mail.contacts, mail.identities, []);
        await store.ingest(mail.record);
        expect(
          (await store.resolveContact(principal.owner_id, account)).contact_id,
        ).toBe(schoolContact);
        clock = new Date("2026-10-26T16:00:00.000Z");
        expect(
          (await fetch(base + "/api/live/status", { headers })).status,
        ).toBe(200);
        expect(
          (await store.interactions(principal.owner_id)).filter(
            (record) => record.source === "calendar",
          ),
        ).toHaveLength(0);
        expect((await store.counts(principal.owner_id)).commitments).toBe(0);
        await expect(
          Promise.resolve().then(() =>
            store.resolveContact(
              principal.owner_id,
              "organizer@example.invalid",
            ),
          ),
        ).rejects.toThrow("unknown contact");
        expect(
          (await store.resolveContact(principal.owner_id, account)).contact_id,
        ).toBe(schoolContact);
        await store.seed(
          [
            {
              owner_id: principal.owner_id,
              contact_id: "replacement-organizer",
              name: "Replacement identity probe",
            },
          ],
          [
            {
              owner_id: principal.owner_id,
              identity: "organizer@example.invalid",
              contact_id: "replacement-organizer",
            },
          ],
          [],
        );
        expect(
          (
            await store.resolveContact(
              principal.owner_id,
              "organizer@example.invalid",
            )
          ).contact_id,
        ).toBe("replacement-organizer");
        expect(await store.telegramDeliveryCounts()).toMatchObject({
          sent: 0,
          reply_pending: 0,
        });
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await store.close();
      }
    }, 60000);
  for (const backend of ["sqlite", "postgres"] as const)
    it(`${backend}: rejects direct ingestion into non-calendar snapshot accounts`, async () => {
      const policy = {
        ...exampleLivePolicy,
        principal_id: "negative-snapshot-owner-" + backend,
      };
      const principal = {
        owner_id: policy.principal_id,
        user_id: "live-owner",
        chat_id: "live-private",
      };
      const store: TendStore | PostgresStore =
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
      try {
        const result = normalizeGmailMessage(
          {
            id: "negative-snapshot-mail",
            threadId: "negative-thread",
            internalDate: String(now.getTime()),
            labelIds: ["INBOX"],
            payload: {
              mimeType: "text/plain",
              headers: [
                { name: "From", value: account },
                { name: "To", value: policy.account_email },
              ],
              body: {
                data: Buffer.from("Read-only source content").toString(
                  "base64url",
                ),
              },
            },
          },
          { policy, now, account_email: policy.account_email },
        );
        if (result.kind !== "accepted")
          throw new Error("accepted Gmail fixture");
        await store.seed(result.contacts, result.identities, [
          {
            owner_id: principal.owner_id,
            source: "gmail",
            account_id: policy.account_email,
            mode: "snapshot",
            last_success: null,
            status: "partial",
            coverage_start: result.record.coverage_start,
            coverage_end: result.record.coverage_end,
            cursor: null,
          },
        ]);
        await expect(
          Promise.resolve().then(() =>
            store.ingest({ ...result.record, ingestion_mode: "snapshot" }),
          ),
        ).rejects.toThrow();
        expect((await store.counts(principal.owner_id)).interactions).toBe(0);
      } finally {
        await store.close();
      }
    }, 60000);
});
