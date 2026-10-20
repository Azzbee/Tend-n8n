import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TendStore,
  type NormalizedRecord,
  type Commitment,
} from "../src/engine.ts";
import {
  demoAuth,
  fixtureContacts,
  fixtureIdentities,
  fixtureSources,
} from "../src/fixtures.ts";
import {
  localNormalModel,
  parseNormalIntent,
  prepareNormalReply,
  type NormalModel,
} from "../src/telegram-normal.ts";
import { exampleLivePolicy, type LivePolicy } from "../src/live-policy.ts";
let store: TendStore;
const draftPolicy: LivePolicy = {
  ...exampleLivePolicy,
  principal_id: demoAuth.owner_id,
  calendar_ids: ["demo-calendar"],
};
function approvedGmail(): void {
  vi.spyOn(store, "sourceStatus").mockReturnValue(
    fixtureSources.map((source) =>
      source.source === "gmail"
        ? { ...source, account_id: draftPolicy.account_email, mode: "live" }
        : source,
    ),
  );
}
const now = () => new Date("2026-10-19T12:00:00Z");
const auth = (text: string) => ({ ...demoAuth, text });
const model = (output: unknown): NormalModel => vi.fn(async () => output);
function record(patch: Partial<NormalizedRecord> = {}): NormalizedRecord {
  return {
    owner_id: demoAuth.owner_id,
    source: "gmail",
    account_id: "demo-gmail",
    source_record_id: "message",
    source_thread_id: "thread",
    kind: "message",
    direction: "received",
    actor_identity: "mira@example.invalid",
    participant_identities: ["owner@example.invalid"],
    occurred_at: "2026-10-19T10:00:00Z",
    observed_at: "2026-10-19T11:00:00Z",
    body_text: "The presentation is Friday.",
    authored_text: "The presentation is Friday.",
    authored_spans: [
      { start: 0, end: 27, text: "The presentation is Friday." },
    ],
    evidence_reference: "https://mail.google.com/mail/u/0/#all/thread",
    ingestion_mode: "live",
    coverage_start: "2026-09-19T11:00:00Z",
    coverage_end: "2026-10-19T11:00:00Z",
    cancelled: false,
    record_key: "a".repeat(64),
    content_hash: "b".repeat(64),
    contact_id: "F17",
    contact_ids: ["F17"],
    attribution: "direct",
    eligible_for_extraction: false,
    ...patch,
  };
}
beforeEach(() => {
  store = new TendStore(":memory:");
  store.seed(fixtureContacts, fixtureIdentities, fixtureSources);
});
afterEach(() => {
  vi.restoreAllMocks();
  store.close();
});
describe("normal owner read-only Telegram preparation", () => {
  it("strictly rejects fabricated queries, commands, extra fields and unknown intents", () => {
    for (const output of [
      { intent: "send" },
      { intent: "help", tool: "delete" },
      { intent: "contacts", query: "F17" },
      { intent: "briefing", query: "Alex Chen" },
      { intent: "agenda", window: "forever" },
    ])
      expect(parseNormalIntent(output, "Find Mira")).toBeNull();
    expect(
      parseNormalIntent({ intent: "contacts", query: "MIRA" }, "Trouve Mira"),
    ).toEqual({ intent: "contacts", query: "MIRA" });
  });
  it("uses local classifier output for English and French help paraphrases", async () => {
    for (const text of [
      "Explain all your features",
      "Explique ce que tu peux faire",
    ]) {
      const inference = model({ intent: "help" });
      const output = await prepareNormalReply({
        auth: auth(text),
        store,
        model: inference,
        clock: now,
      });
      expect(output.reply.normal_message).toContain("hold follow-up drafts");
      expect(output.reply.warning).toContain("partial");
      expect(inference).toHaveBeenCalledTimes(1);
    }
  });
  it("constrains the classifier with a closed schema and concrete fictional examples", async () => {
    const inference = model({ intent: "help" });
    await prepareNormalReply({
      auth: auth("What can you do?"),
      store,
      model: inference,
    });
    const request = vi.mocked(inference).mock.calls[0]?.[0];
    expect(request?.format).toMatchObject({
      anyOf: [
        { additionalProperties: false },
        { additionalProperties: false },
        { additionalProperties: false },
      ],
    });
    expect(
      request?.messages.some(
        (m) => m.role === "assistant" && m.content === '{"intent":"help"}',
      ),
    ).toBe(true);
    expect(request?.messages.at(-1)?.content).toBe("What can you do?");
  });
  it("performs no model or read operation after failed owner authorization", async () => {
    const inference = model({ intent: "help" }),
      interactions = vi.spyOn(store, "interactions");
    await expect(
      prepareNormalReply({
        auth: { ...auth("help me"), user_id: "intruder" },
        store,
        model: inference,
      }),
    ).rejects.toThrow("unauthorized");
    expect(inference).not.toHaveBeenCalled();
    expect(interactions).not.toHaveBeenCalled();
  });
  it("returns fixed clarification for mutation and unsupported output without writing", async () => {
    const command = vi.spyOn(store, "command");
    const output = await prepareNormalReply({
      auth: auth("Cancel my promises and send a message"),
      store,
      model: model({ intent: "clarify" }),
    });
    expect(output.reply.normal_message).toContain("explicit slash commands");
    expect(command.mock.calls.map((c) => c[0].text)).toEqual(["/status"]);
  });
  it("fails helpfully on unavailable model and propagates caller cancellation", async () => {
    const output = await prepareNormalReply({
      auth: auth("Tell me things"),
      store,
      model: async () => {
        throw new Error("offline");
      },
    });
    expect(output.reply.normal_message).toContain("unavailable");
    const controller = new AbortController();
    controller.abort(new Error("gone"));
    await expect(
      prepareNormalReply({
        auth: auth("Tell me things"),
        store,
        signal: controller.signal,
        model: model({ intent: "help" }),
      }),
    ).rejects.toThrow("gone");
  });
  it("bounds a hung injected model with the overall timeout signal", async () => {
    const controller = new AbortController();
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(controller.signal);
    const task = prepareNormalReply({
      auth: auth("Tell me things"),
      store,
      model: () => new Promise(() => {}),
    });
    await Promise.resolve();
    controller.abort(new Error("inference deadline"));
    const output = await task;
    expect(timeout).toHaveBeenCalledWith(45000);
    expect(output.reply.normal_message).toContain("unavailable");
  });
  it("does not merge ambiguous names", async () => {
    const one = store.contacts(demoAuth.owner_id)[0]!;
    vi.spyOn(store, "contacts").mockReturnValue([
      { ...one, name: "Mira", contact_id: "F17" },
      { ...one, name: "Mira", contact_id: "F18" },
    ]);
    const output = await prepareNormalReply({
      auth: auth("Brief me about Mira"),
      store,
      model: model({ intent: "briefing", query: "Mira" }),
      clock: now,
    });
    expect(output.reply.contacts_total).toBe(2);
    expect(output.ai_guard).toBeUndefined();
  });
  it("uses Paris day and separates pending proposals from due dates", async () => {
    const meetings = [
      record({
        source: "calendar",
        account_id: "demo-calendar",
        kind: "meeting",
        direction: "event",
        occurred_at: "2026-10-19T22:30:00Z",
        end_at: "2026-10-19T23:00:00Z",
      }),
      record({
        source: "calendar",
        account_id: "demo-calendar",
        kind: "meeting",
        direction: "event",
        occurred_at: "2026-10-19T16:00:00Z",
        end_at: "2026-10-19T17:00:00Z",
      }),
    ];
    vi.spyOn(store, "interactions").mockReturnValue(meetings);
    const output = await prepareNormalReply({
      auth: auth("My meetings today"),
      store,
      model: model({ intent: "agenda", window: "today" }),
      clock: now,
    });
    expect(output.reply.meetings).toEqual([meetings[1]]);
    expect(output.reply.pending).toEqual([]);
    expect(output.record_guards).toHaveLength(1);
  });
  it("runs at most two calls, validates exact quotations and returns held draft", async () => {
    const source = record({ account_id: draftPolicy.account_email });
    approvedGmail();
    vi.spyOn(store, "interactions").mockReturnValue([source]);
    const contact = store
      .contacts(demoAuth.owner_id)
      .find((c) => c.contact_id === "F17")!;
    const inference = vi
      .fn<NormalModel>()
      .mockResolvedValueOnce({
        intent: "draft_preview",
        query: contact.contact_id,
      })
      .mockResolvedValueOnce({
        items: [{ evidence_id: "E1", quote: source.authored_text }],
        draft: {
          text: "Hi Mira, how is preparation for the presentation going?",
        },
      });
    const output = await prepareNormalReply({
      auth: auth("Prepare a draft for F17"),
      store,
      model: inference,
      clock: now,
      policy: draftPolicy,
    });
    expect(inference).toHaveBeenCalledTimes(2);
    expect(output.state_guard).toBeUndefined();
    expect(output.ai_guard?.freshness?.recipient.contact.name).toBe("Mira Tan");
    expect(output.reply.preview).toBe(
      "Hi Mira, how is preparation for the presentation going?",
    );
    expect(vi.mocked(inference).mock.calls[1]?.[0].model).toBe("qwen3:4b");
    expect(output.reply.ai).toMatchObject({
      status: "validated",
      outbound_sent: false,
      draft: {
        pending_review: true,
        style_basis: "neutral",
        prose_fact_verified: false,
        recipient: { name: "Mira Tan" },
      },
    });
    expect(output.record_guards).toEqual([
      { record_key: source.record_key, content_hash: source.content_hash },
    ]);
  });
  it("removes changed evidence before producing a reply", async () => {
    const source = record();
    const records = vi.spyOn(store, "interactions").mockReturnValue([source]);
    let count = 0;
    const inference: NormalModel = async () => {
      if (++count === 1) return { intent: "briefing", query: "F17" };
      records.mockReturnValue([
        { ...source, content_hash: "c".repeat(64), authored_text: "Changed." },
      ]);
      return { items: [{ evidence_id: "E1", quote: source.authored_text }] };
    };
    const output = await prepareNormalReply({
      auth: auth("Brief F17"),
      store,
      model: inference,
      clock: now,
    });
    expect(output.reply.ai).toMatchObject({ status: "fallback", items: [] });
    expect(output.reply.evidence).toEqual([]);
  });
  it("excludes old, cancelled and revoked evidence before the excerpt model", async () => {
    const source = record({ occurred_at: "2026-08-01T10:00:00Z" });
    vi.spyOn(store, "interactions").mockReturnValue([
      source,
      record({ cancelled: true }),
    ]);
    const inference = model({ intent: "briefing", query: "F17" });
    const output = await prepareNormalReply({
      auth: auth("Brief F17"),
      store,
      model: inference,
      clock: now,
    });
    expect(inference).toHaveBeenCalledTimes(1);
    expect(output.reply.evidence).toEqual([]);
    vi.spyOn(store, "sourceStatus").mockReturnValue(
      fixtureSources.map((s) => ({ ...s, status: "revoked" })),
    );
    vi.mocked(store.interactions).mockReturnValue([record()]);
    const revoked = await prepareNormalReply({
      auth: auth("Brief F17"),
      store,
      model: inference,
      clock: now,
    });
    expect(revoked.reply.evidence).toEqual([]);
    expect(inference).toHaveBeenCalledTimes(2);
  });
  it("does not present pending suggested dates as confirmed obligations", async () => {
    const source = record();
    vi.spyOn(store, "interactions").mockReturnValue([source]);
    vi.spyOn(store, "commitments").mockReturnValue([
      {
        owner_id: demoAuth.owner_id,
        contact_id: "F17",
        commitment_id: "C1",
        source: "gmail",
        record_key: source.record_key,
        quote: source.authored_text!,
        action: "Send slides",
        suggested_due: "2026-10-20",
        due_date: null,
        direction: "owed_by_me",
        status: "pending",
        evidence_valid: true,
      },
    ]);
    const output = await prepareNormalReply({
      auth: auth("What do I owe?"),
      store,
      model: model({ intent: "obligations" }),
      clock: now,
    });
    expect(output.reply.commitments).toEqual([]);
    expect(output.reply.pending).toMatchObject([
      { due_date: null, status: "pending", suggested_due: "2026-10-20" },
    ]);
    expect(output.record_guards).toHaveLength(1);
  });
  it("fails closed when a verified identity group changes during inference", async () => {
    const source = record();
    vi.spyOn(store, "interactions").mockReturnValue([source]);
    const group = {
      id: "verified-group",
      name: "Verified Mira",
      verified_at: "2026-10-19T10:00:00Z",
      proof_kind: "owner_confirmed" as const,
      proof_reference: "private-verification",
      members: [
        {
          contact_id: "F17",
          source: "gmail" as const,
          account_id: "demo-gmail",
          identity: "mira@example.invalid",
        },
      ],
    };
    let current: typeof group | null = group;
    let calls = 0;
    const inference: NormalModel = async () => {
      if (++calls === 1) return { intent: "briefing", query: "verified-group" };
      current = null;
      return { items: [{ evidence_id: "E1", quote: source.authored_text }] };
    };
    const output = await prepareNormalReply({
      auth: auth("Brief verified-group"),
      store,
      model: inference,
      clock: now,
      resolveGroup: () => current,
    });
    expect(output.reply.ai).toMatchObject({ status: "fallback", items: [] });
    expect(output.reply.preview).toBeUndefined();
  });
  it("uses only the fixed local model endpoint and bounds generated tokens", async () => {
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(
          JSON.stringify({ message: { content: '{"intent":"help"}' } }),
        ),
      );
    const output = await localNormalModel(
      {
        model: "qwen3:0.6b",
        think: false,
        stream: false,
        format: "json",
        options: { temperature: 0 },
        messages: [],
      },
      new AbortController().signal,
    );
    expect(output).toBe('{"intent":"help"}');
    expect(fetcher.mock.calls[0]?.[0]).toBe("http://127.0.0.1:11434/api/chat");
    expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe("error");
    expect(
      JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).keep_alive,
    ).toBe(0);
    expect(
      JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).options,
    ).toMatchObject({ num_predict: 512, num_ctx: 8192 });
  });
  it("unloads the fixed small model after extractive briefing as well as classification", async () => {
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ message: { content: '{"items":[]}' } })),
      );
    await localNormalModel(
      {
        model: "qwen3:0.6b",
        think: false,
        stream: false,
        format: "json",
        options: { temperature: 0 },
        messages: [
          { role: "system", content: "Select exact briefing excerpts only." },
          { role: "user", content: '{"evidence":[]}' },
        ],
      },
      new AbortController().signal,
    );
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({
      model: "qwen3:0.6b",
      keep_alive: 0,
      options: { num_ctx: 8192, num_predict: 512 },
    });
  });
  it("rejects oversized streamed model responses", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("x".repeat(65537)),
    );
    await expect(
      localNormalModel(
        {
          model: "qwen3:0.6b",
          think: false,
          stream: false,
          format: "json",
          options: { temperature: 0 },
          messages: [],
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow("too large");
  });
});

describe("bounded context search and requested priorities", () => {
  function promise(
    source: NormalizedRecord,
    patch: Partial<Commitment> = {},
  ): Commitment {
    return {
      owner_id: demoAuth.owner_id,
      contact_id: "F17",
      commitment_id: source.record_key,
      source: source.source,
      record_key: source.record_key,
      quote: source.body_text,
      action: "Review project",
      suggested_due: "2026-10-20",
      due_date: "2026-10-19",
      direction: "owed_by_me",
      status: "confirmed",
      evidence_valid: true,
      ...patch,
    };
  }
  it("accepts only literal owner search keywords and a closed digest intent", () => {
    expect(
      parseNormalIntent(
        { intent: "search", query: "Secure Horizons" },
        "Find messages about Secure Horizons",
      ),
    ).toEqual({ intent: "search", query: "Secure Horizons" });
    expect(
      parseNormalIntent(
        { intent: "search", query: "private passwords" },
        "Find messages about Secure Horizons",
      ),
    ).toBeNull();
    expect(
      parseNormalIntent({ intent: "digest" }, "What should I focus on?"),
    ).toEqual({ intent: "digest" });
    expect(
      parseNormalIntent({ intent: "digest", send: true }, "Daily briefing"),
    ).toBeNull();
  });
  it("ranks matching keywords then recency, caps ten results and leaves identities separate", async () => {
    const records = Array.from({ length: 12 }, (_, i) =>
      record({
        record_key: String(i).padStart(64, "0"),
        contact_id: i % 2 ? "F17" : "F18",
        contact_ids: [i % 2 ? "F17" : "F18"],
        occurred_at: `2026-10-19T${String(i).padStart(2, "0")}:00:00Z`,
        body_text:
          i === 0
            ? "Secure Horizons Secure Horizons Secure Horizons"
            : "Secure Horizons project",
        attribution: i === 10 ? "group" : "direct",
      }),
    );
    vi.spyOn(store, "interactions").mockReturnValue(records);
    const inference = model({ intent: "search", query: "Secure Horizons" });
    const output = await prepareNormalReply({
      auth: auth("Find Secure Horizons"),
      store,
      model: inference,
      clock: now,
    });
    const results = output.reply.search_results as {
      text: string;
      date: string;
      attribution: string;
    }[];
    expect(results).toHaveLength(10);
    expect(results[0]!.text).toBe(records[0]!.body_text);
    expect(results[1]!.date).toBe(records[11]!.occurred_at);
    expect(results.some((entry) => entry.attribution === "group")).toBe(true);
    expect(output.record_guards).toHaveLength(10);
    expect(output.reply).not.toHaveProperty("contact");
    expect(output.reply.search_note).toContain("Not complete semantic search");
    expect(inference).toHaveBeenCalledTimes(1);
  });
  it("filters foreign owners, unapproved accounts, old, future and cancelled search records", async () => {
    approvedGmail();
    const good = record({
      account_id: draftPolicy.account_email,
      body_text: "Secure Horizons",
    });
    vi.spyOn(store, "interactions").mockReturnValue([
      good,
      { ...good, owner_id: "another-owner" },
      { ...good, account_id: "unapproved@example.invalid" },
      { ...good, occurred_at: "2026-09-01T10:00:00Z" },
      { ...good, occurred_at: "2026-10-20T10:00:00Z" },
      { ...good, cancelled: true },
    ]);
    const output = await prepareNormalReply({
      auth: auth("Find Secure Horizons"),
      store,
      model: model({ intent: "search", query: "Secure Horizons" }),
      clock: now,
      policy: draftPolicy,
    });
    expect(output.reply.search_results).toHaveLength(1);
    expect(output.record_guards).toHaveLength(1);
  });
  it("keeps approved cross-source hits distinct and unknown attribution visible", async () => {
    const first = record({
      body_text: "Secure Horizons",
      attribution: "unknown",
      contact_ids: [],
    });
    const second = record({
      body_text: "Secure Horizons",
      source: "whatsapp_business",
      account_id: "demo-whatsapp_business",
      record_key: "c".repeat(64),
      contact_id: "another-channel",
      contact_ids: ["another-channel"],
    });
    vi.spyOn(store, "interactions").mockReturnValue([first, second]);
    const output = await prepareNormalReply({
      auth: auth("Find Secure Horizons"),
      store,
      model: model({ intent: "search", query: "Secure Horizons" }),
      clock: now,
    });
    expect(output.reply.search_results).toMatchObject([
      { source: "gmail", attribution: "unknown" },
      { source: "whatsapp_business", attribution: "direct" },
    ]);
    expect(output.reply).not.toHaveProperty("contacts");
    expect(output.reply).not.toHaveProperty("commitments");
  });
  it("says no imported match rather than claiming the accounts contain none", async () => {
    vi.spyOn(store, "interactions").mockReturnValue([record()]);
    const output = await prepareNormalReply({
      auth: auth("Find Secure Horizons"),
      store,
      model: model({ intent: "search", query: "Secure Horizons" }),
      clock: now,
    });
    expect(output.reply.search_results).toEqual([]);
    expect(output.reply.normal_message).toContain("No imported keyword match");
    expect(output.reply.normal_message).toContain("does not establish absence");
  });
  it("ranks confirmed due items before meetings and labels received suggestions without urgency", async () => {
    const overdue = record({ record_key: "a".repeat(64) });
    const due = record({ record_key: "c".repeat(64) });
    const meeting = record({
      record_key: "d".repeat(64),
      source: "calendar",
      account_id: "demo-calendar",
      kind: "meeting",
      direction: "event",
      occurred_at: "2026-10-19T16:00:00Z",
      end_at: "2026-10-19T17:00:00Z",
    });
    const message = record({ record_key: "e".repeat(64) });
    const pending = record({
      record_key: "f".repeat(64),
      attribution: "direct",
    });
    vi.spyOn(store, "interactions").mockReturnValue([
      message,
      pending,
      meeting,
      due,
      overdue,
    ]);
    vi.spyOn(store, "commitments").mockReturnValue([
      promise(due),
      promise(overdue, { due_date: "2026-10-18" }),
      promise(pending, { status: "pending", due_date: null }),
    ]);
    const command = vi.spyOn(store, "command");
    const inference = model({ intent: "digest" });
    const output = await prepareNormalReply({
      auth: auth("What should I focus on?"),
      store,
      model: inference,
      clock: now,
    });
    expect(output.reply.priorities).toMatchObject([
      { kind: "confirmed_overdue" },
      { kind: "confirmed_due" },
      { kind: "meeting" },
      {
        kind: "review_suggestion",
        reason: expect.stringContaining("not verified urgency"),
      },
    ]);
    expect(output.reply.priority_pending).toMatchObject([
      { kind: "unconfirmed_proposal", date: null },
    ]);
    expect(output.reply).not.toHaveProperty("pending");
    expect(output.record_guards).toHaveLength(5);
    expect(command.mock.calls.map(([request]) => request.text)).toEqual([
      "/status",
    ]);
    expect(inference).toHaveBeenCalledTimes(1);
  });
  it("caps priority and unconfirmed entries at five and omits old/group/owner-authored suggestions", async () => {
    const records = Array.from({ length: 8 }, (_, i) =>
      record({ record_key: i.toString(16).repeat(64) }),
    );
    vi.spyOn(store, "interactions").mockReturnValue(records);
    vi.spyOn(store, "commitments").mockReturnValue(
      records.map((source) => promise(source)),
    );
    const output = await prepareNormalReply({
      auth: auth("Daily briefing"),
      store,
      model: model({ intent: "digest" }),
      clock: now,
    });
    expect(output.reply.priorities).toHaveLength(5);
    expect(output.reply.priority_pending).toEqual([]);
    expect(output.record_guards).toHaveLength(5);
    vi.mocked(store.commitments).mockReturnValue([]);
    vi.mocked(store.interactions).mockReturnValue([
      record({ attribution: "group" }),
      record({ attribution: "unknown" }),
      record({ direction: "sent" }),
      record({ occurred_at: "2026-10-15T10:00:00Z" }),
      record({ owner_id: "other" }),
    ]);
    const excluded = await prepareNormalReply({
      auth: auth("Daily briefing"),
      store,
      model: model({ intent: "digest" }),
      clock: now,
    });
    expect(excluded.reply.priorities).toEqual([]);
  });
  it("binds personalised prose to a real email-member display name and guards style dependencies", async () => {
    approvedGmail();
    const source = record({ account_id: draftPolicy.account_email });
    const style = record({
      account_id: draftPolicy.account_email,
      record_key: "c".repeat(64),
      content_hash: "d".repeat(64),
      direction: "sent",
      actor_identity: draftPolicy.account_email,
      body_text: "Salut Mira, comment tu vas ?",
      authored_text: "Salut Mira, comment tu vas ?",
      authored_spans: [
        { start: 0, end: 27, text: "Salut Mira, comment tu vas ?" },
      ],
      participant_identities: ["mira@example.invalid"],
    });
    vi.spyOn(store, "interactions").mockReturnValue([source, style]);
    const group = {
      id: "verified-group",
      name: "Owner-confirmed identity",
      verified_at: "2026-10-19T10:00:00Z",
      proof_kind: "owner_confirmed" as const,
      proof_reference: "reviewed",
      members: [
        {
          contact_id: "F17",
          source: "gmail" as const,
          account_id: draftPolicy.account_email,
          identity: "mira@example.invalid",
        },
      ],
    };
    const inference = vi
      .fn<NormalModel>()
      .mockResolvedValueOnce({ intent: "draft_preview", query: group.id })
      .mockResolvedValueOnce({
        items: [{ evidence_id: "E1", quote: source.authored_text }],
        draft: {
          text: "Salut Mira, comment avance ta préparation pour la présentation ?",
        },
      });
    const output = await prepareNormalReply({
      auth: auth("Prépare un brouillon pour verified-group"),
      store,
      model: inference,
      clock: now,
      policy: draftPolicy,
      resolveGroup: () => group,
    });
    expect(output.reply.preview).toBe(
      "Salut Mira, comment avance ta préparation pour la présentation ?",
    );
    expect(output.reply.ai).toMatchObject({
      draft: {
        style_basis: "recipient_examples",
        recipient: { contact_id: "verified-group", name: "Mira Tan" },
        prose_fact_verified: false,
      },
    });
    expect(output.reply.normal_message).toBe(
      "AI-written draft. Check facts before sending",
    );
    expect(output.record_guards).toEqual(
      expect.arrayContaining([
        { record_key: source.record_key, content_hash: source.content_hash },
        { record_key: style.record_key, content_hash: style.content_hash },
      ]),
    );
    expect(inference).toHaveBeenCalledTimes(2);
  });
  it("does not present a generated draft when no approved policy was supplied", async () => {
    vi.spyOn(store, "interactions").mockReturnValue([record()]);
    const inference = vi
      .fn<NormalModel>()
      .mockResolvedValueOnce({ intent: "draft_preview", query: "F17" })
      .mockResolvedValueOnce({
        items: [{ evidence_id: "E1", quote: record().authored_text }],
      });
    const output = await prepareNormalReply({
      auth: auth("Draft for F17"),
      store,
      model: inference,
      clock: now,
    });
    expect(output.reply.preview).toBeUndefined();
    expect(output.reply.ai).toMatchObject({ draft: null });
  });
  it("labels promises owed to the owner separately from promises owed by the owner", async () => {
    const source = record();
    vi.spyOn(store, "interactions").mockReturnValue([source]);
    vi.spyOn(store, "commitments").mockReturnValue([
      promise(source, { direction: "owed_to_me" }),
    ]);
    const output = await prepareNormalReply({
      auth: auth("Daily briefing"),
      store,
      model: model({ intent: "digest" }),
      clock: now,
    });
    expect(output.reply.priorities).toMatchObject([
      {
        direction: "owed_to_me",
        reason: expect.stringContaining("owed to you"),
      },
    ]);
  });
  it("omits ended meetings while preserving ongoing and upcoming meetings", async () => {
    vi.spyOn(store, "interactions").mockReturnValue([
      record({
        source: "calendar",
        account_id: "demo-calendar",
        kind: "meeting",
        direction: "event",
        occurred_at: "2026-10-19T09:00:00Z",
        end_at: "2026-10-19T10:00:00Z",
      }),
      record({
        record_key: "c".repeat(64),
        source: "calendar",
        account_id: "demo-calendar",
        kind: "meeting",
        direction: "event",
        occurred_at: "2026-10-19T11:00:00Z",
        end_at: "2026-10-19T13:00:00Z",
      }),
    ]);
    const output = await prepareNormalReply({
      auth: auth("Daily briefing"),
      store,
      model: model({ intent: "digest" }),
      clock: now,
    });
    expect(output.reply.priorities).toHaveLength(1);
    expect(output.record_guards[0]?.record_key).toBe("c".repeat(64));
  });
  it("preserves all-day and end-time metadata for priority presentation", async () => {
    const meeting = record({
      source: "calendar",
      account_id: "demo-calendar",
      kind: "meeting",
      direction: "event",
      occurred_at: "2026-10-19T22:00:00Z",
      end_at: "2026-10-20T22:00:00Z",
      all_day: true,
    });
    vi.spyOn(store, "interactions").mockReturnValue([meeting]);
    const output = await prepareNormalReply({
      auth: auth("Daily briefing"),
      store,
      model: model({ intent: "digest" }),
      clock: now,
    });
    expect(output.reply.priorities).toMatchObject([
      {
        kind: "meeting",
        date: meeting.occurred_at,
        end_at: meeting.end_at,
        all_day: true,
      },
    ]);
  });
  it("reports unavailable older obligation evidence without extending the approved window", async () => {
    const source = record({ occurred_at: "2026-08-01T10:00:00Z" });
    vi.spyOn(store, "interactions").mockReturnValue([source]);
    vi.spyOn(store, "commitments").mockReturnValue([promise(source)]);
    const output = await prepareNormalReply({
      auth: auth("Daily briefing"),
      store,
      model: model({ intent: "digest" }),
      clock: now,
    });
    expect(output.reply.priorities).toEqual([]);
    expect(output.reply.priority_unavailable_count).toBe(1);
    expect(output.reply.normal_message).toContain("No eligible priorities");
    expect(output.reply.normal_message).toContain("does not establish");
    expect(output.record_guards).toEqual([]);
  });
  it("clarifies an oversized stored display name and rejects a 600-character owner request", async () => {
    const contacts = store.contacts(demoAuth.owner_id);
    vi.spyOn(store, "contacts").mockReturnValue(
      contacts.map((contact) =>
        contact.contact_id === "F17"
          ? { ...contact, name: "M".repeat(201) }
          : contact,
      ),
    );
    const inference = model({ intent: "draft_preview", query: "F17" });
    const output = await prepareNormalReply({
      auth: auth("Draft for F17"),
      store,
      model: inference,
      clock: now,
      policy: draftPolicy,
    });
    expect(output.reply.normal_message).toContain("display name needs review");
    expect(output.reply.preview).toBeUndefined();
    expect(inference).toHaveBeenCalledTimes(1);
    await expect(
      prepareNormalReply({
        auth: auth("x".repeat(600)),
        store,
        model: inference,
      }),
    ).rejects.toThrow("Invalid normal message");
    expect(inference).toHaveBeenCalledTimes(1);
  });
  it("uses a named verified social member or neutral wording instead of a generic group label", async () => {
    const source = record({
      source: "whatsapp_business",
      account_id: "demo-whatsapp_business",
      actor_identity: "peer-identity",
    });
    vi.spyOn(store, "interactions").mockReturnValue([source]);
    const contacts = vi.spyOn(store, "contacts").mockReturnValue([
      {
        owner_id: demoAuth.owner_id,
        contact_id: "F17",
        name: "Mira Tan",
        emails: ["peer-identity"],
      },
    ]);
    const group = {
      id: "verified-group",
      name: "Owner-confirmed identity",
      verified_at: "2026-10-19T10:00:00Z",
      proof_kind: "owner_confirmed" as const,
      proof_reference: "reviewed",
      members: [
        {
          contact_id: "F17",
          source: "whatsapp_business" as const,
          account_id: "demo-whatsapp_business",
          identity: "peer-identity",
        },
      ],
    };
    const makeModel = () =>
      vi
        .fn<NormalModel>()
        .mockResolvedValueOnce({ intent: "briefing", query: "verified-group" })
        .mockResolvedValueOnce({
          items: [{ evidence_id: "E1", quote: source.authored_text }],
        });
    const named = await prepareNormalReply({
      auth: auth("Brief verified-group"),
      store,
      model: makeModel(),
      clock: now,
      resolveGroup: () => group,
    });
    expect(named.reply.contact).toMatchObject({ name: "Mira Tan" });
    contacts.mockReturnValue([
      {
        owner_id: demoAuth.owner_id,
        contact_id: "F17",
        name: "+33600000000",
        emails: ["peer-identity"],
      },
    ]);
    const neutral = await prepareNormalReply({
      auth: auth("Brief verified-group"),
      store,
      model: makeModel(),
      clock: now,
      resolveGroup: () => group,
    });
    expect(neutral.reply.contact).toMatchObject({ name: "this contact" });
  });
  it("uses fixed context, token and lifetime bounds for the approved local writing model", async () => {
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ message: { content: "{}" } })),
      );
    await localNormalModel(
      {
        model: "qwen3:4b",
        think: false,
        stream: false,
        format: "json",
        options: { temperature: 0 },
        messages: [],
      },
      new AbortController().signal,
    );
    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({
      keep_alive: 0,
      think: false,
      stream: false,
      options: { num_ctx: 8192, num_predict: 1024, temperature: 0 },
    });
    await expect(
      localNormalModel(
        {
          model: "remote-model" as "qwen3:4b",
          think: false,
          stream: false,
          format: "json",
          options: { temperature: 0 },
          messages: [],
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow("Unapproved");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("semantic normal-message retrieval", () => {
  it("returns paraphrase evidence with canonical guards and rejects injected foreign matches", async () => {
    const canonical = record({
      body_text: "Please arrange accommodation near the conference venue.",
    });
    vi.spyOn(store, "interactions").mockReturnValue([canonical]);
    const retrieve = vi.fn(async () => ({
      records: [
        canonical,
        record({ record_key: "f".repeat(64), owner_id: "foreign" }),
      ],
      coverage: { indexed: 1 },
    }));
    const result = await prepareNormalReply({
      auth: auth("Find hotel logistics"),
      store,
      model: model({ intent: "search", query: "hotel logistics" }),
      clock: now,
      semanticSearch: retrieve,
    });
    expect(result.reply.search_mode).toBe("semantic");
    expect(result.reply.search_results).toHaveLength(1);
    expect(result.record_guards).toEqual([
      {
        record_key: canonical.record_key,
        content_hash: canonical.content_hash,
      },
    ]);
    expect(retrieve).toHaveBeenCalledTimes(1);
  });
  it("labels lexical fallback when embeddings are unavailable", async () => {
    vi.spyOn(store, "interactions").mockReturnValue([
      record({ body_text: "hotel logistics" }),
    ]);
    const result = await prepareNormalReply({
      auth: auth("Find hotel logistics"),
      store,
      model: model({ intent: "search", query: "hotel logistics" }),
      clock: now,
      semanticSearch: async () => {
        throw new Error("offline");
      },
    });
    expect(result.reply.search_mode).toBe("keyword");
    expect(result.reply.search_note).toContain("Semantic search unavailable");
    expect(result.reply.search_results).toHaveLength(1);
  });
});

it("shows a validated semantic passage beyond the message opening", async () => {
  const passage = "Book rooms near the conference";
  const canonical = record({ body_text: "x".repeat(700) + passage });
  vi.spyOn(store, "interactions").mockReturnValue([canonical]);
  const result = await prepareNormalReply({
    auth: auth("Find hotel logistics"),
    store,
    model: model({ intent: "search", query: "hotel logistics" }),
    clock: now,
    semanticSearch: async () => ({
      records: [canonical],
      matches: [
        {
          record_key: canonical.record_key,
          start: 700,
          end: 700 + passage.length,
          text: passage,
          similarity: 0.8,
        },
      ],
    }),
  });
  expect(result.reply.search_results).toMatchObject([{ text: passage }]);
});

it("uses labelled keyword fallback for an empty unfinished semantic index", async () => {
  vi.spyOn(store, "interactions").mockReturnValue([
    record({ body_text: "hotel logistics" }),
  ]);
  const result = await prepareNormalReply({
    auth: auth("Find hotel logistics"),
    store,
    model: model({ intent: "search", query: "hotel logistics" }),
    clock: now,
    semanticSearch: async () => ({
      records: [],
      coverage: { state: "indexing", pending: 5 },
    }),
  });
  expect(result.reply.search_mode).toBe("keyword");
  expect(result.reply.search_note).toContain("Semantic index is partial");
  expect(result.reply.search_results).toHaveLength(1);
});
