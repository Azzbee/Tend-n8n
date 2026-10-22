import { describe, expect, it } from "vitest";
import type { Commitment } from "../src/engine.ts";
import type { VerifiedContactGroup } from "../src/live-policy.ts";
import {
  annotateThreads,
  askSimilarity,
  collapseThreads,
  linkThreads,
  onePerThread,
  separateFromThread,
  tokenSimilarity,
  type ThreadRow,
} from "../src/promise-threads.ts";

const now = new Date("2026-10-22T09:00:00Z");
function commitment(id: string, over: Partial<Commitment> = {}): Commitment {
  return {
    commitment_id: id,
    owner_id: "owner",
    contact_id: "F17",
    source: "gmail",
    record_key: `rk-${id}`,
    direction: "owed_to_me",
    status: "pending",
    due_date: null,
    evidence_valid: true,
    quote: "I will send the demo by 2026-10-15.",
    action: "send the demo",
    suggested_due: "2026-10-15",
    ...over,
  };
}
const times = (entries: [string, string][]): Map<string, string> =>
  new Map(entries.map(([id, at]) => [`rk-${id}`, at]));
function link(
  commitments: Commitment[],
  extra: {
    rows?: ThreadRow[];
    groups?: VerifiedContactGroup[];
    overrides?: { commitment_id: string; other_commitment_id: string }[];
    at?: Map<string, string>;
    cosine?: (a: string, b: string) => number | null;
    only?: string[];
    limit?: number;
  } = {},
): ThreadRow[] {
  return linkThreads({
    commitments,
    occurredAt:
      extra.at ??
      times(
        commitments.map((c, i) => [c.commitment_id, `2026-10-1${i}T08:00:00Z`]),
      ),
    rows: extra.rows ?? [],
    overrides: extra.overrides ?? [],
    ...(extra.groups ? { groups: extra.groups } : {}),
    ...(extra.cosine ? { cosine: extra.cosine } : {}),
    ...(extra.only ? { only: extra.only } : {}),
    ...(extra.limit !== undefined ? { limit: extra.limit } : {}),
    now,
  });
}

describe("promise thread similarity", () => {
  it("scores the same ask high and a different ask low on normalized tokens", () => {
    expect(tokenSimilarity("send the demo", "Send the demo!")).toBe(1);
    expect(
      tokenSimilarity("send the demo", "send over the demo deck"),
    ).toBeGreaterThanOrEqual(0.7);
    expect(tokenSimilarity("send the demo", "review your demo")).toBeLessThan(
      0.7,
    );
    expect(tokenSimilarity("send the demo", "book a call")).toBe(0);
    expect(tokenSimilarity("send the invoices", "sending the invoice")).toBe(1);
  });
  it("uses cosine only at 0.9 or more with a shared content word (granite scores measured 22 Oct)", () => {
    const measured: Record<string, number> = {
      "send the contract|send the demo": 0.835,
      "pay the invoice|send the invoice": 0.886,
      "introduce you to Sam|make the intro to Sam": 0.92,
      "send the demo|share the demo with you": 0.844,
    };
    const cosine = (a: string, b: string): number | null =>
      measured[`${a}|${b}`] ?? null;
    expect(
      askSimilarity("send the contract", "send the demo", cosine),
    ).toBeNull();
    expect(
      askSimilarity("pay the invoice", "send the invoice", cosine),
    ).toBeNull();
    expect(
      askSimilarity("send the demo", "share the demo with you", cosine),
    ).toBeNull();
    expect(
      askSimilarity("introduce you to Sam", "make the intro to Sam", cosine),
    ).toBe(0.92);
    expect(
      askSimilarity("introduce you to Sam", "make the intro to Sam"),
    ).toBeNull();
  });
});

describe("linking promise threads", () => {
  it("links the same ask from the same person across email and LinkedIn", () => {
    const g1 = commitment("Cg1", {
      status: "confirmed",
      due_date: "2026-10-15",
    });
    const li1 = commitment("Cli1", { source: "linkedin" });
    const rows = link([g1, li1]);
    expect(
      rows.map((r) => [r.thread_id, r.commitment_id, r.linked_by]),
    ).toEqual([
      ["TCg1", "Cg1", "auto"],
      ["TCg1", "Cli1", "auto"],
    ]);
    expect(rows[1]!.similarity).toBe(1);
    const [thread] = collapseThreads(annotateThreads([g1, li1], rows)).filter(
      (t) => t.thread_id,
    );
    expect(thread!.members.map((m) => m.source)).toEqual(["gmail", "linkedin"]);
    expect(thread!.primary).toMatchObject({
      commitment_id: "Cg1",
      status: "confirmed",
      due_date: "2026-10-15",
    });
    expect(onePerThread(annotateThreads([g1, li1], rows))).toHaveLength(1);
  });
  it("keeps a different person with the same words separate", () => {
    expect(
      link([commitment("A"), commitment("B", { contact_id: "F18" })]),
    ).toEqual([]);
  });
  it("keeps same-name contacts separate unless a verified group joins them", () => {
    const a = commitment("A", { contact_id: "F18" });
    const b = commitment("B", { contact_id: "F19", source: "linkedin" });
    expect(link([a, b])).toEqual([]);
    const group = (proof: string): VerifiedContactGroup => ({
      id: "riley",
      name: "Riley Park",
      verified_at: "2026-10-01T00:00:00Z",
      proof_kind: proof as VerifiedContactGroup["proof_kind"],
      proof_reference: "fixture://proof",
      members: [
        { contact_id: "F18", source: "gmail", account_id: "x", identity: "a" },
        {
          contact_id: "F19",
          source: "linkedin",
          account_id: "y",
          identity: "b",
        },
      ],
    });
    expect(link([a, b], { groups: [group("name_match")] })).toEqual([]);
    expect(link([a, b], { groups: [group("owner_confirmed")] })).toHaveLength(
      2,
    );
    expect(link([a, b], { groups: [group("provider_verified")] })).toHaveLength(
      2,
    );
  });
  it("keeps the same person's different ask separate", () => {
    expect(
      link([
        commitment("A"),
        commitment("B", {
          action: "review the checklist",
          source: "whatsapp_business",
        }),
      ]),
    ).toEqual([]);
  });
  it("needs the same direction, open status, compatible due dates and a 21 day window", () => {
    expect(
      link([commitment("A"), commitment("B", { direction: "owed_by_me" })]),
    ).toEqual([]);
    expect(
      link([commitment("A"), commitment("B", { status: "done" })]),
    ).toEqual([]);
    expect(
      link([commitment("A"), commitment("B", { status: "dismissed" })]),
    ).toEqual([]);
    expect(
      link([commitment("A"), commitment("B", { suggested_due: "2026-10-18" })]),
    ).toEqual([]);
    expect(
      link([commitment("A"), commitment("B", { suggested_due: "2026-10-17" })]),
    ).toHaveLength(2);
    expect(
      link([commitment("A"), commitment("B", { suggested_due: null })]),
    ).toHaveLength(2);
    const far = times([
      ["A", "2026-09-01T08:00:00Z"],
      ["B", "2026-09-23T08:00:00Z"],
    ]);
    expect(
      link(
        [
          commitment("A", { suggested_due: null }),
          commitment("B", { suggested_due: null }),
        ],
        { at: far },
      ),
    ).toEqual([]);
  });
  it("links only the named new commitment, names the thread after the earlier sighting, and caps each pass", () => {
    const old1 = commitment("Z1"),
      old2 = commitment("Z2", { source: "linkedin" }),
      fresh = commitment("A9", { source: "whatsapp_personal" });
    const at = times([
      ["Z1", "2026-10-10T08:00:00Z"],
      ["Z2", "2026-10-11T08:00:00Z"],
      ["A9", "2026-10-12T08:00:00Z"],
    ]);
    // Only the new one is tried, so the two older loose sightings are not backfilled here.
    const rows = link([old1, old2, fresh], { at, only: ["A9"] });
    expect(rows.map((r) => [r.thread_id, r.commitment_id])).toEqual([
      ["TZ1", "Z1"],
      ["TZ1", "A9"],
    ]);
    expect(link([old1, old2, fresh], { at, limit: 0 })).toEqual([]);
  });
  it("adds a third sighting to the existing thread and never re-links an owner split", () => {
    const a = commitment("A"),
      b = commitment("B", { source: "linkedin" }),
      c = commitment("C", { source: "whatsapp_personal" });
    const first = link([a, b]);
    const next = link([a, b, c], { rows: first });
    expect(next).toEqual([
      expect.objectContaining({ thread_id: "TA", commitment_id: "C" }),
    ]);
    const rows = [...first, ...next];
    const split = separateFromThread(rows, "C");
    expect(split.remove).toEqual(["C"]);
    expect(split.overrides).toEqual([
      { commitment_id: "C", other_commitment_id: "A" },
      { commitment_id: "C", other_commitment_id: "B" },
    ]);
    const kept = rows.filter((r) => !split.remove.includes(r.commitment_id));
    expect(link([a, b, c], { rows: kept, overrides: split.overrides })).toEqual(
      [],
    );
    // Splitting a two-member thread dissolves it.
    expect(separateFromThread(first, "B").remove).toEqual(["B", "A"]);
  });
  it("stays valid while one source is valid and counts a closed thread member on its own", () => {
    const a = commitment("A", {
        evidence_valid: false,
        status: "confirmed",
        due_date: "2026-10-15",
      }),
      b = commitment("B", {
        source: "linkedin",
        status: "confirmed",
        due_date: "2026-10-16",
      });
    const rows: ThreadRow[] = ["A", "B"].map((id) => ({
      thread_id: "TA",
      commitment_id: id,
      linked_by: "owner",
      similarity: 1,
      created_at: now.toISOString(),
    }));
    const [thread] = collapseThreads(annotateThreads([a, b], rows));
    expect(thread!.primary).toMatchObject({
      evidence_valid: true,
      due_date: "2026-10-15",
    });
    const done = collapseThreads(
      annotateThreads([a, { ...b, status: "done" }], rows),
    );
    expect(done.map((t) => t.thread_id)).toEqual([null, null]);
  });
});

describe("promise threads in the store", async () => {
  const { createDeskFixtureStore, deskFixtureRecords } =
    await import("../src/desk-fixture.ts");
  const { exampleLivePolicy } = await import("../src/live-policy.ts");
  const owner = exampleLivePolicy.principal_id;
  const auth = {
    owner_id: owner,
    user_id: "live-owner",
    chat_id: "live-private",
    chat_type: "private",
  };
  const g1 = deskFixtureRecords.find((r) => r.source_record_id === "g1")!;
  // Fictional extra sightings: same words from other people, and the same person's other channel.
  function sighting(
    id: string,
    actor: string,
    contact: string,
    text = g1.body_text,
  ): typeof g1 {
    return {
      ...g1,
      source_record_id: id,
      source_thread_id: `thread-${id}`,
      actor_identity: actor,
      contact_ids: [contact],
      body_text: text,
      authored_text: text,
      authored_spans: [{ start: 0, end: text.length, text }],
      evidence_reference: `tend-source:gmail/owner%40example.invalid/${id}`,
      occurred_at: "2026-10-13T08:25:00Z",
    };
  }
  function store() {
    const s = createDeskFixtureStore();
    s.seed(
      [],
      [
        {
          owner_id: owner,
          contact_id: "F18",
          identity: "riley@example.invalid",
        },
        {
          owner_id: owner,
          contact_id: "F19",
          identity: "riley.park@example.invalid",
        },
      ],
      [],
    );
    return s;
  }
  function add(
    s: ReturnType<typeof store>,
    raw: typeof g1,
    action = "send the demo",
  ) {
    s.ingest(raw);
    return s.addCandidate(raw, {
      quote: raw.body_text,
      action,
      suggested_due: "2026-10-15",
    });
  }
  const byRecord = (s: ReturnType<typeof store>, id: string) => {
    const key = s
      .interactions(owner)
      .find((r) => r.source_record_id === id)!.record_key;
    return s.commitments(owner).find((c) => c.record_key === key)!;
  };

  it("links Mira's g1 and li1 into one thread and keeps the other fixture promises apart", () => {
    const s = store();
    try {
      const a = byRecord(s, "g1"),
        b = byRecord(s, "li1");
      expect(a.thread_id).toBeDefined();
      expect(b.thread_id).toBe(a.thread_id);
      expect(byRecord(s, "g2").thread_id).toBeUndefined();
      expect(byRecord(s, "wp2").thread_id).toBeUndefined();
      expect(
        s.threadRows(owner).map((r) => [r.commitment_id, r.linked_by]),
      ).toEqual([
        [a.commitment_id, "auto"],
        [b.commitment_id, "auto"],
      ]);
      expect(s.counts(owner).commitments).toBe(3);
    } finally {
      s.close();
    }
  });
  it("keeps a different person and an unverified same-name contact separate, even with the same words", () => {
    const s = store();
    try {
      add(s, sighting("r1", "riley@example.invalid", "F18"));
      add(s, sighting("r2", "riley.park@example.invalid", "F19"));
      for (const id of ["r1", "r2"])
        expect(byRecord(s, id).thread_id).toBeUndefined();
      // A verified group joins the two Riley Park identities; names alone never did.
      s.linkPromiseThreads(owner, [
        {
          id: "riley",
          name: "Riley Park",
          verified_at: "2026-10-01T00:00:00Z",
          proof_kind: "owner_confirmed",
          proof_reference: "fixture://proof",
          members: [
            {
              contact_id: "F18",
              source: "gmail",
              account_id: "x",
              identity: "riley@example.invalid",
            },
            {
              contact_id: "F19",
              source: "gmail",
              account_id: "x",
              identity: "riley.park@example.invalid",
            },
          ],
        },
      ]);
      expect(byRecord(s, "r1").thread_id).toBeDefined();
      expect(byRecord(s, "r2").thread_id).toBe(byRecord(s, "r1").thread_id);
      expect(byRecord(s, "r1").thread_id).not.toBe(byRecord(s, "g1").thread_id);
    } finally {
      s.close();
    }
  });
  it("keeps the same person's different ask separate", () => {
    const s = store();
    try {
      add(
        s,
        sighting(
          "m2",
          "mira@example.invalid",
          "F17",
          "I will book the venue by 2026-10-15.",
        ),
        "book the venue",
      );
      expect(byRecord(s, "m2").thread_id).toBeUndefined();
    } finally {
      s.close();
    }
  });
  it("counts the thread once in /today and /status, confirms and links once, and closes every sighting with /done", () => {
    const s = store();
    try {
      const li1 = byRecord(s, "li1");
      // li1 is a pending sighting of the confirmed g1 promise, so /today does not ask about it again.
      const today = s.command({ ...auth, text: "/today" }) as unknown as {
        pending: { commitment_id: string }[];
      };
      expect(today.pending.map((c) => c.commitment_id)).toEqual([
        byRecord(s, "wp2").commitment_id,
      ]);
      const status = s.command({ ...auth, text: "/status" }) as unknown as {
        counts: { commitments: number };
      };
      expect(status.counts.commitments).toBe(3);
      s.command({ ...auth, text: `/confirm ${li1.commitment_id} 2026-10-15` });
      expect(byRecord(s, "li1").status).toBe("confirmed");
      expect(s.threadRows(owner).every((r) => r.linked_by === "owner")).toBe(
        true,
      );
      s.command({ ...auth, text: `/done ${byRecord(s, "g1").commitment_id}` });
      expect([byRecord(s, "g1").status, byRecord(s, "li1").status]).toEqual([
        "done",
        "done",
      ]);
    } finally {
      s.close();
    }
  });
  it("splits on Not the same ask, remembers the override and never re-links", () => {
    const s = store();
    try {
      const li1 = byRecord(s, "li1");
      expect(
        s.command({ ...auth, text: `/separate ${li1.commitment_id}` }),
      ).toMatchObject({
        separated: li1.commitment_id,
      });
      expect(byRecord(s, "li1").thread_id).toBeUndefined();
      expect(byRecord(s, "g1").thread_id).toBeUndefined();
      expect(s.linkPromiseThreads(owner)).toEqual([]);
      expect(byRecord(s, "li1").thread_id).toBeUndefined();
      expect(() =>
        s.command({ ...auth, text: `/separate ${li1.commitment_id}` }),
      ).toThrow("invalid transition");
      expect(s.counts(owner).commitments).toBe(4);
    } finally {
      s.close();
    }
  });
});

describe("outreach on promise threads", async () => {
  const { createDeskFixtureStore } = await import("../src/desk-fixture.ts");
  const { exampleLivePolicy } = await import("../src/live-policy.ts");
  const { planOutreach } = await import("../src/outreach.ts");
  const { snapshotOf, FIXTURE_OUTREACH_CLOCK } =
    await import("../src/outreach-service.ts");
  it("proposes one follow-up per thread, keyed by its earliest confirmed sighting", () => {
    const store = createDeskFixtureStore();
    try {
      const owner = exampleLivePolicy.principal_id;
      const key = (id: string): string =>
        store.interactions(owner).find((r) => r.source_record_id === id)!
          .record_key;
      const byRecord = (id: string) =>
        store.commitments(owner).find((c) => c.record_key === key(id))!;
      store.command({
        owner_id: owner,
        user_id: "live-owner",
        chat_id: "live-private",
        chat_type: "private",
        text: `/confirm ${byRecord("li1").commitment_id} 2026-10-15`,
      });
      const overdue = planOutreach(
        snapshotOf(store, owner),
        new Date(FIXTURE_OUTREACH_CLOCK),
        [],
      ).proposals.filter((p) => p.reason === "overdue_owed_to_you");
      expect(overdue.map((p) => p.item_key)).toEqual([
        `overdue_owed_to_you:${byRecord("g1").commitment_id}`,
      ]);
    } finally {
      store.close();
    }
  });
});

describe("embedding similarity for promise threads", async () => {
  const { actionCosine } = await import("../src/promise-threads.ts");
  it("gives a cosine only when the local model answers, and lets tokens decide otherwise", async () => {
    expect(await actionCosine(undefined, ["send the demo"])).toBeUndefined();
    expect(
      await actionCosine(
        { embed: () => Promise.reject(new Error("offline")) },
        ["offline only text"],
      ),
    ).toBeUndefined();
    const cosine = await actionCosine(
      {
        embed: (text: string) =>
          Promise.resolve(text.includes("demo") ? [1, 0] : [0, 1]),
      },
      ["send the demo", "review your demo", "share the pilot checklist"],
    );
    expect(cosine!("send the demo", "review your demo")).toBe(1);
    expect(cosine!("send the demo", "share the pilot checklist")).toBe(0);
    expect(cosine!("send the demo", "never embedded")).toBeNull();
  });
});
