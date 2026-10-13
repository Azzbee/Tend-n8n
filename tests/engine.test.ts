import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  TendStore,
  normalizeRecord,
  validateCandidate,
  retryDelay,
} from "../src/engine.ts";
import {
  fixtureRecords,
  fixtureSources,
  fixtureContacts,
  fixtureIdentities,
  demoAuth,
} from "../src/fixtures.ts";
let store: TendStore;
beforeEach(() => {
  store = new TendStore(":memory:");
  store.seed(fixtureContacts, fixtureIdentities, fixtureSources);
});
afterEach(() => store.close());
describe("evidence and persistence", () => {
  it("ingests five adapters and replays without duplication", () => {
    for (const r of fixtureRecords) store.ingest(r);
    const n = store.counts();
    for (const r of fixtureRecords) store.ingest(r);
    expect(store.counts()).toEqual(n);
    expect(n.interactions).toBe(7);
  });
  it("rejects invalid date, unresolved identity and group records", () => {
    const r = fixtureRecords[0]!;
    expect(() =>
      normalizeRecord(
        { ...r, occurred_at: "2026-02-30T08:00:00Z" },
        fixtureIdentities,
      ),
    ).toThrow();
    expect(() =>
      normalizeRecord(
        { ...r, actor_identity: "missing@example.invalid" },
        fixtureIdentities,
      ),
    ).toThrow();
    expect(() =>
      normalizeRecord({ ...r, kind: "group_message" }, fixtureIdentities),
    ).toThrow();
  });
  it("keeps identical text on separate channels", () => {
    const a = fixtureRecords[0]!;
    const b = {
      ...a,
      source: "linkedin" as const,
      account_id: "demo-linkedin",
      source_record_id: "forwarded",
      ingestion_mode: "snapshot" as const,
    };
    store.ingest(a);
    store.ingest(b);
    expect(store.counts().interactions).toBe(2);
  });
  it("does not merge contacts by same name", () => {
    expect(() => store.resolveContact("demo-owner", "Riley Park")).toThrow(
      "ambiguous",
    );
    expect(store.resolveContact("demo-owner", "F17").contact_id).toBe("F17");
  });
  it("returns stale and snapshot coverage with a partial briefing", () => {
    for (const r of fixtureRecords) store.ingest(r);
    const response = store.command({ ...demoAuth, text: "/prep F17" });
    expect(response.coverage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "whatsapp_personal",
          status: "stale",
        }),
        expect.objectContaining({ source: "linkedin", mode: "snapshot" }),
      ]),
    );
    expect(JSON.stringify(response)).not.toContain("No recent contact");
  });
  it("rejects another owner or group chat before data retrieval", () => {
    expect(() => store.command({ ...demoAuth, user_id: "intruder" })).toThrow(
      "unauthorized",
    );
    expect(() => store.command({ ...demoAuth, chat_type: "group" })).toThrow(
      "unauthorized",
    );
    expect(() => store.command({ ...demoAuth, owner_id: "other" })).toThrow(
      "unauthorized",
    );
  });
  it("does not advance source cursor on rejected record", () => {
    const before = store.sourceStatus("demo-owner");
    expect(() =>
      store.ingestBatch(
        [{ ...fixtureRecords[0]!, observed_at: "not-a-date" }],
        "cursor-next",
      ),
    ).toThrow();
    expect(store.sourceStatus("demo-owner")).toEqual(before);
  });
  it("updates a cancelled calendar event without closing a promise", () => {
    const message = fixtureRecords[0]!;
    store.ingest(message);
    const commitment = store.addCandidate(message, {
      quote: message.body_text,
      action: "send the demo",
      suggested_due: "2026-10-15",
    });
    store.command({
      ...demoAuth,
      text: `/confirm ${commitment.commitment_id} 2026-10-15`,
    });
    store.ingest(fixtureRecords[3]!);
    store.ingest({ ...fixtureRecords[3]!, cancelled: true });
    const r = store.command({ ...demoAuth, text: "/prep F17" });
    expect(JSON.stringify(r)).not.toContain("2026-10-16T10:00:00Z");
    expect(
      store
        .commitments("demo-owner")
        .find((c) => c.commitment_id === commitment.commitment_id)?.status,
    ).toBe("confirmed");
  });
});
describe("model output boundary and explicit state", () => {
  const proposed = {
    quote: "I will send the demo by 2026-10-15.",
    action: "send the demo",
    suggested_due: "2026-10-15",
  };
  it("validates quoted evidence and leaves candidate pending", () => {
    const r = fixtureRecords[0]!;
    store.ingest(r);
    const c = store.addCandidate(r, proposed);
    expect(c.status).toBe("pending");
    expect(store.command({ ...demoAuth, text: "/today" }).commitments).toEqual(
      [],
    );
    expect(() =>
      store.command({ ...demoAuth, text: `/draft ${c.commitment_id}` }),
    ).toThrow("unconfirmed draft");
  });
  it("rejects fabricated quotes, dates, action and tool fields", () => {
    const r = fixtureRecords[0]!;
    expect(() =>
      validateCandidate(r, { ...proposed, quote: "I will pay 100." }),
    ).toThrow();
    expect(() =>
      validateCandidate(r, { ...proposed, suggested_due: "2026-10-17" }),
    ).toThrow();
    expect(() =>
      validateCandidate(r, { ...proposed, action: "send money" }),
    ).toThrow();
    expect(() =>
      validateCandidate(r, { ...proposed, recipient: "attacker" }),
    ).toThrow();
  });
  it("confirms, previews and completes only by authorized commands; retries are idempotent", () => {
    const r = fixtureRecords[0]!;
    store.ingest(r);
    const c = store.addCandidate(r, proposed);
    const cmd = { ...demoAuth, text: `/confirm ${c.commitment_id} 2026-10-15` };
    store.command(cmd);
    store.command(cmd);
    const draft = store.command({
      ...demoAuth,
      text: `/draft ${c.commitment_id}`,
    });
    expect(draft.outbound_sent).toBe(false);
    expect(draft).toHaveProperty("preview");
    store.command({ ...demoAuth, text: `/done ${c.commitment_id}` });
    expect(
      store.command({ ...demoAuth, text: `/done ${c.commitment_id}` }),
    ).toHaveProperty("status", "done");
    expect(() =>
      store.command({ ...demoAuth, text: `/cancel ${c.commitment_id}` }),
    ).toThrow("transition");
  });
  it("asks the contact for progress only on an incoming promise", () => {
    const record = fixtureRecords[0]!;
    store.ingest(record);
    const candidate = store.addCandidate(record, proposed);
    store.command({
      ...demoAuth,
      text: `/confirm ${candidate.commitment_id} 2026-10-15`,
    });
    const before = store.commitments("demo-owner");
    const draft = store.command({
      ...demoAuth,
      text: `/draft ${candidate.commitment_id}`,
    });
    expect(candidate.direction).toBe("owed_to_me");
    expect(draft.preview).toContain("Could you confirm progress?");
    expect(draft.preview).toContain(candidate.quote);
    expect(draft.evidence).toBe(candidate.record_key);
    expect(draft.outbound_sent).toBe(false);
    expect(store.commitments("demo-owner")).toEqual(before);
  });
  it("previews an owner update for an outgoing promise without inventing progress", () => {
    const record = fixtureRecords.find((r) => r.direction === "sent")!;
    store.ingest(record);
    const candidate = store.addCandidate(record, {
      quote: record.body_text,
      action: "review your demo",
      suggested_due: "2026-10-16",
    });
    store.command({
      ...demoAuth,
      text: `/confirm ${candidate.commitment_id} 2026-10-16`,
    });
    const before = store.commitments("demo-owner");
    const draft = store.command({
      ...demoAuth,
      text: `/draft ${candidate.commitment_id}`,
    });
    expect(candidate.direction).toBe("owed_by_me");
    expect(draft.preview).toContain("Update on my promise");
    expect(draft.preview).toContain(candidate.quote);
    expect(draft.preview).toContain("[Add my actual progress before sending]");
    expect(draft.preview).not.toContain("Could you confirm progress?");
    expect(draft.preview).not.toMatch(/\b(?:done|completed|finished|sent)\b/i);
    expect(draft.evidence).toBe(candidate.record_key);
    expect(draft.outbound_sent).toBe(false);
    expect(store.commitments("demo-owner")).toEqual(before);
  });
  it("keeps prompt-injection text as inert data", () => {
    const r = fixtureRecords[6]!;
    store.ingest(r);
    expect(store.counts().commitments).toBe(0);
    expect(store.command({ ...demoAuth, text: "/status" }).outbound_sent).toBe(
      false,
    );
  });
  it("revocation invalidates evidence-derived candidates", () => {
    const r = fixtureRecords[0]!;
    store.ingest(r);
    const c = store.addCandidate(r, proposed);
    store.revokeSource("demo-owner", "gmail");
    expect(() =>
      store.command({
        ...demoAuth,
        text: `/confirm ${c.commitment_id} 2026-10-15`,
      }),
    ).toThrow("transition");
  });
  it("models bounded retries and respects Retry-After", () => {
    expect(retryDelay(0, "3")).toBe(3000);
    expect(retryDelay(1, null)).toBe(1000);
    expect(() => retryDelay(3, null)).toThrow("retry limit");
    expect(() => retryDelay(0, "999")).toThrow("retry budget");
  });
});
describe("evidence refresh", () => {
  it("invalidates a confirmed commitment when its source text changes", () => {
    const r = fixtureRecords[0]!;
    store.ingest(r);
    const c = store.addCandidate(r, {
      quote: r.body_text,
      action: "send the demo",
      suggested_due: "2026-10-15",
    });
    store.command({
      ...demoAuth,
      text: `/confirm ${c.commitment_id} 2026-10-15`,
    });
    store.ingest({ ...r, body_text: "The proposal was withdrawn." });
    expect(store.commitments("demo-owner")[0]?.status).toBe("invalidated");
    expect(() =>
      store.command({ ...demoAuth, text: `/draft ${c.commitment_id}` }),
    ).toThrow();
  });
  it("rejects reversed coverage windows", () => {
    expect(() =>
      normalizeRecord(
        { ...fixtureRecords[0]!, coverage_start: "2026-10-20T00:00:00Z" },
        fixtureIdentities,
      ),
    ).toThrow("coverage");
  });
  it("passes a full same-name query to ambiguity checking", () => {
    expect(() =>
      store.command({ ...demoAuth, text: "/prep Riley Park" }),
    ).toThrow("ambiguous");
  });
});
it("invalidates commitments when evidence direction changes", () => {
  const r = fixtureRecords[0]!;
  store.ingest(r);
  const c = store.addCandidate(r, {
    quote: r.body_text,
    action: "send the demo",
    suggested_due: "2026-10-15",
  });
  store.command({
    ...demoAuth,
    text: `/confirm ${c.commitment_id} 2026-10-15`,
  });
  store.ingest({
    ...r,
    direction: "sent",
    actor_identity: "owner@example.invalid",
    participant_identities: ["mira@example.invalid"],
  });
  expect(store.commitments("demo-owner")[0]?.status).toBe("invalidated");
});
it("lists upcoming uncancelled meetings in today", () => {
  store.ingest(fixtureRecords[3]!);
  const r = store.command({ ...demoAuth, text: "/today" });
  expect(r.meetings).toHaveLength(1);
  store.ingest({ ...fixtureRecords[3]!, cancelled: true });
  expect(store.command({ ...demoAuth, text: "/today" }).meetings).toEqual([]);
});
it("compares meeting instants rather than offset timestamp strings", () => {
  store.ingest({
    ...fixtureRecords[3]!,
    occurred_at: "2026-10-20T01:00:00+02:00",
  });
  expect(store.command({ ...demoAuth, text: "/today" }).meetings).toHaveLength(
    1,
  );
  store.ingest({
    ...fixtureRecords[3]!,
    occurred_at: "2026-10-12T23:30:00-02:00",
  });
  expect(store.command({ ...demoAuth, text: "/today" }).meetings).toHaveLength(
    1,
  );
});
describe("review boundaries", () => {
  it("rejects unresolved and multiple group participants", () => {
    expect(() =>
      normalizeRecord(
        {
          ...fixtureRecords[1]!,
          participant_identities: [
            "mira@example.invalid",
            "stranger@example.invalid",
          ],
        },
        fixtureIdentities,
      ),
    ).toThrow();
    expect(() =>
      normalizeRecord(
        {
          ...fixtureRecords[0]!,
          participant_identities: ["stranger@example.invalid"],
        },
        fixtureIdentities,
      ),
    ).toThrow();
  });
  it("redacts revoked source evidence from all returned candidates", () => {
    const r = fixtureRecords[0]!;
    store.ingest(r);
    store.addCandidate(r, {
      quote: r.body_text,
      action: "send the demo",
      suggested_due: "2026-10-15",
    });
    store.revokeSource("demo-owner", "gmail");
    expect(JSON.stringify(store.command(demoAuth))).not.toContain(
      "I will send the demo",
    );
    expect(store.commitments("demo-owner")[0]?.quote).toBe("");
  });
  it("retains terminal owner state while invalidating its evidence", () => {
    const r = fixtureRecords[0]!;
    store.ingest(r);
    const c = store.addCandidate(r, {
      quote: r.body_text,
      action: "send the demo",
      suggested_due: "2026-10-15",
    });
    store.command({
      ...demoAuth,
      text: `/confirm ${c.commitment_id} 2026-10-15`,
    });
    store.command({ ...demoAuth, text: `/done ${c.commitment_id}` });
    store.ingest({ ...r, body_text: "The source was edited." });
    expect(store.commitments("demo-owner")[0]?.status).toBe("done");
  });
  it("rejects another account/mode and quoted reply attribution", () => {
    expect(() =>
      store.ingest({ ...fixtureRecords[0]!, account_id: "unregistered" }),
    ).toThrow();
    expect(() =>
      validateCandidate(
        {
          ...fixtureRecords[0]!,
          body_text: "Earlier Mira said: I will send the demo by 2026-10-15.",
        },
        {
          quote: fixtureRecords[0]!.body_text,
          action: "send the demo",
          suggested_due: "2026-10-15",
        },
      ),
    ).toThrow();
  });
  it("rejects extra state-command arguments", () => {
    expect(() =>
      store.command({ ...demoAuth, text: "/status surprise" }),
    ).toThrow("arguments");
  });
});
