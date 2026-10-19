import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TendStore, type NormalizedRecord } from "../src/engine.ts";
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
let store: TendStore;
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
    const source = record();
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
      });
    const output = await prepareNormalReply({
      auth: auth("Prepare a draft for F17"),
      store,
      model: inference,
      clock: now,
    });
    expect(inference).toHaveBeenCalledTimes(2);
    expect(output.reply.preview).toContain("Review-only draft");
    expect(output.reply.ai).toMatchObject({
      status: "validated",
      outbound_sent: false,
      draft: { pending_review: true },
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
      JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).options.num_predict,
    ).toBe(512);
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
