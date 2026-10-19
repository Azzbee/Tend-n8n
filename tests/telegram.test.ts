import { describe, it, expect } from "vitest";
import vm from "node:vm";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TendStore } from "../src/engine.ts";
import {
  fixtureContacts,
  fixtureIdentities,
  fixtureSources,
  fixtureRecords,
  demoAuth,
} from "../src/fixtures.ts";
import {
  telegramGuardCode,
  telegramReplyCode,
  configuredGuard,
  configuredLiveGuard,
  telegramLiveGuardCode,
  telegramLiveReplyCode,
} from "../src/telegram.ts";
const update = {
  update_id: 1,
  message: {
    message_id: 1,
    from: { id: 424242, is_bot: false },
    chat: { id: 424242, type: "private" },
    text: "/status",
  },
};
const run = (
  input: unknown,
  code = configuredGuard("424242", "424242"),
): unknown =>
  vm.runInNewContext(`(function(){${code}})()`, {
    $input: { first: () => ({ json: input }) },
  });
describe("normal private Telegram entry and presentation", () => {
  const guard = configuredLiveGuard(
    "424242",
    "424242",
    "private-owner",
    "private-control",
  );
  it("admits normal owner text only in the live private guard", () => {
    for (const text of [
      "Explain all your features",
      "Quels rendez-vous ai-je aujourd’hui ?",
    ]) {
      const message = { ...update, message: { ...update.message, text } };
      expect(run(message)).toEqual([]);
      expect(run(message, guard)).toEqual([
        expect.objectContaining({
          json: expect.objectContaining({
            help: false,
            command: expect.objectContaining({ text }),
          }),
        }),
      ]);
      expect(
        run(
          {
            ...message,
            message: {
              ...message.message,
              chat: { id: 424242, type: "group" },
            },
          },
          guard,
        ),
      ).toEqual([]);
      expect(
        run(
          {
            ...message,
            message: { ...message.message, from: { id: 999, is_bot: false } },
          },
          guard,
        ),
      ).toEqual([]);
    }
    expect(
      run({ ...update, message: { ...update.message, text: "   " } }, guard),
    ).toEqual([]);
    expect(
      run(
        { ...update, message: { ...update.message, text: "x".repeat(501) } },
        guard,
      ),
    ).toEqual([]);
  });
  it("escapes normal replies, states zero pending proposals and retains the enrolled destination", () => {
    const result = vm.runInNewContext(
      `(function(){${telegramLiveReplyCode}})()`,
      {
        $input: {
          first: () => ({
            json: {
              outbound_sent: false,
              normal_message: "Your <private> agenda & promises",
              commitments: [],
              pending: [],
              chat_id: "foreign",
              warning: "Coverage is partial.",
            },
          }),
        },
        $: () => ({
          first: () => ({ json: { reply_chat_id: "424242", help: false } }),
        }),
      },
    ) as { json: { chat_id: string; text: string } }[];
    expect(result[0]!.json.chat_id).toBe("424242");
    expect(result[0]!.json.text).toContain(
      "Your &lt;private&gt; agenda &amp; promises",
    );
    expect(result[0]!.json.text).toContain(
      "Confirmed obligations: 0. Pending proposals: 0.",
    );
    expect(result[0]!.json.text).toContain("Coverage is partial.");
  });
  it("puts generated prose before sources and avoids duplicate previews", () => {
    const result = vm.runInNewContext(
      `(function(){${telegramLiveReplyCode}})()`,
      {
        $input: {
          first: () => ({
            json: {
              normal_message: "Held draft",
              preview: "Hi Mira, how is the project going?",
              ai: {
                draft: {
                  text: "Hi Mira, how is the project going?",
                  label: "AI-written draft. Check facts before sending",
                  recipient: { name: "Mira" },
                  style_basis: "neutral",
                },
              },
              evidence: [
                {
                  source: "gmail",
                  text: "Notes are ready",
                  reference: "tend-source:notes",
                },
              ],
              sources: [{ source: "gmail", status: "partial" }],
              warning: "Coverage is partial.",
            },
          }),
        },
        $: () => ({ first: () => ({ json: { reply_chat_id: "424242" } }) }),
      },
    ) as { json: { text: string } }[];
    const text = result[0]!.json.text;
    expect(text.indexOf("Hi Mira")).toBeLessThan(text.indexOf("Evidence:"));
    expect(text.match(/Hi Mira/g)).toHaveLength(1);
    expect(text).toContain("Check facts before sending");
    expect(text).toContain("Coverage is partial.");
  });
  it("labels ranked search and separates unconfirmed priority proposals", () => {
    const result = vm.runInNewContext(
      `(function(){${telegramLiveReplyCode}})()`,
      {
        $input: {
          first: () => ({
            json: {
              normal_message: "Priority review",
              search_results: [
                {
                  date: "2026-10-19",
                  source: "gmail",
                  attribution: "direct",
                  text: "<notes>",
                  reference: "tend-source:notes",
                },
              ],
              priorities: [
                {
                  kind: "review_suggestion",
                  reason: "Recent message, urgency unverified",
                  date: "2026-10-19",
                  source: "gmail",
                  text: "Review notes",
                  reference: "tend-source:notes",
                },
              ],
              priority_pending: [
                {
                  text: "Proposed report",
                  source: "gmail",
                  reference: "tend-source:proposal",
                },
              ],
              pending_total: 1,
            },
          }),
        },
        $: () => ({ first: () => ({ json: { reply_chat_id: "424242" } }) }),
      },
    ) as { json: { text: string } }[];
    expect(result[0]!.json.text).toContain("&lt;notes&gt;");
    expect(result[0]!.json.text).toContain(
      "Unconfirmed proposals (not deadlines): 1 shown of 1",
    );
    expect(result[0]!.json.text).not.toContain("Owed to you");
  });
});
describe("Telegram owner boundary", () => {
  it("fails closed until both owner IDs are configured", () =>
    expect(run(update, telegramGuardCode)).toEqual([]));
  it("accepts only the exact owner in the exact private chat", () => {
    expect(run(update)).toEqual([
      {
        json: {
          reply_chat_id: "424242",
          help: false,
          telegram_update_id: 1,
          telegram_channel_id: "tend-course-control",
          command: {
            owner_id: "demo-owner",
            user_id: "demo-user",
            chat_id: "demo-private",
            chat_type: "private",
            text: "/status",
          },
        },
      },
    ]);
    expect(
      run({
        ...update,
        message: { ...update.message, from: { id: 999, is_bot: false } },
      }),
    ).toEqual([]);
    expect(
      run({
        ...update,
        message: { ...update.message, chat: { id: 999, type: "private" } },
      }),
    ).toEqual([]);
    expect(
      run({
        ...update,
        message: { ...update.message, chat: { id: 424242, type: "group" } },
      }),
    ).toEqual([]);
  });
  it("requires a nonnegative safe integer update ID before authorizing", () => {
    for (const update_id of [
      undefined,
      -1,
      1.5,
      "1",
      NaN,
      Number.MAX_SAFE_INTEGER + 1,
    ])
      expect(run({ ...update, update_id })).toEqual([]);
  });
  it("drops bots/attachments and gives help only to the owner for unknown commands", () => {
    expect(
      run({
        ...update,
        message: { ...update.message, from: { id: 424242, is_bot: true } },
      }),
    ).toEqual([]);
    expect(
      run({
        ...update,
        message: { ...update.message, text: undefined, photo: [] },
      }),
    ).toEqual([]);
    expect(
      run({ ...update, message: { ...update.message, text: "/send someone" } }),
    ).toEqual([
      expect.objectContaining({
        json: expect.objectContaining({ help: true }),
      }),
    ]);
    expect(run({ callback_query: { from: { id: 424242 } } })).toEqual([]);
  });
  it("never takes its reply recipient from an API/model response", () => {
    const output = vm.runInNewContext(`(function(){${telegramReplyCode}})()`, {
      $input: {
        first: () => ({
          json: {
            chat_id: "attacker",
            recipient: "attacker",
            data: "fictional",
          },
        }),
      },
      $: () => ({
        first: () => ({ json: { reply_chat_id: "424242", help: false } }),
      }),
    });
    expect(output[0].json.chat_id).toBe("424242");
    expect(output[0].json.text).toContain("Course demo • fictional data");
  });
  it("formats readable replies and enforces Telegram's conservative length cap", () => {
    const runReply = (
      reply: unknown,
      help = false,
    ): { json: { text: string } }[] =>
      vm.runInNewContext(`(function(){${telegramReplyCode}})()`, {
        $input: { first: () => ({ json: reply }) },
        $: () => ({
          first: () => ({ json: { reply_chat_id: "424242", help } }),
        }),
      }) as { json: { text: string } }[];
    const status = runReply({
      counts: { interactions: 7, commitments: 2 },
      sources: [{ source: "gmail", mode: "fixture", status: "ready" }],
    })[0]!.json.text;
    expect(status).toContain("Source records: 7");
    expect(status).toContain("gmail: ready, fixture");
    expect(status).not.toContain('"counts"');
    expect(
      runReply({ error: "private stack trace or token" })[0]!.json.text,
    ).not.toContain("stack trace");
    expect(runReply({}, true)[0]!.json.text).toContain("/prep F17");
    const long = runReply({ preview: "🙂".repeat(5000) })[0]!.json.text;
    expect(long.length).toBeLessThanOrEqual(3900);
    expect(long).toContain("Reply shortened");
    const proposed = runReply({
      pending: [
        {
          commitment_id: "C1",
          action: "send demo",
          status: "pending",
          direction: "owed_to_me",
          due_date: null,
          suggested_due: "2026-10-15",
        },
      ],
    })[0]!.json.text;
    expect(proposed).toContain("proposed date 2026-10-15 (unconfirmed)");
    expect(proposed).not.toContain("due 2026-10-15");
    const markup = runReply({
      preview: "<a href='https://bad.invalid'>do not parse & link</a>",
    })[0]!.json.text;
    expect(markup).toContain("&lt;a");
    expect(markup).toContain("&amp;");
    expect(markup).not.toContain("<a");
  });
});
describe("persistent Telegram command replay boundary", () => {
  it("rejects duplicate updates before processing and after reopening SQLite", () => {
    const directory = mkdtempSync(join(tmpdir(), "tend-telegram-replay-"));
    const path = join(directory, "data.sqlite");
    let store = new TendStore(path);
    try {
      store.seed(fixtureContacts, fixtureIdentities, fixtureSources);
      const record = fixtureRecords[0]!;
      store.ingest(record);
      const candidate = store.addCandidate(record, {
        quote: record.body_text,
        action: "send the demo",
        suggested_due: "2026-10-15",
      });
      const command = {
        ...demoAuth,
        text: `/confirm ${candidate.commitment_id} 2026-10-15`,
      };
      expect(
        store.telegramCommand(command, "tend-course-control", 100),
      ).toHaveProperty("accepted", true);
      expect(
        store.telegramCommand(command, "tend-course-control", 100),
      ).toEqual({ accepted: false });
      store.close();
      store = new TendStore(path);
      expect(
        store.telegramCommand(
          { ...command, text: `/done ${candidate.commitment_id}` },
          "tend-course-control",
          100,
        ),
      ).toEqual({ accepted: false });
      expect(store.commitments("demo-owner")[0]!.status).toBe("confirmed");
      store.acknowledgeTelegramReply(command, "tend-course-control", 100, 1);
      expect(
        store.telegramCommand(command, "tend-course-control", 100),
      ).toEqual({ accepted: false });
      expect(
        store.telegramCommand(
          { ...command, text: `/done ${candidate.commitment_id}` },
          "tend-course-control",
          101,
        ).reply,
      ).toHaveProperty("status", "done");
      expect(
        store.telegramCommand(
          { ...command, text: `/done ${candidate.commitment_id}` },
          "tend-course-control",
          102,
        ).reply,
      ).toHaveProperty("status", "done");
      expect(() =>
        store.telegramCommand(
          { ...command, user_id: "foreign" },
          "tend-course-control",
          103,
        ),
      ).toThrow("unauthorized");
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("private Google Telegram boundary", () => {
  it("fails closed unconfigured and allows owner contact lookup with live principal", () => {
    expect(run(update, telegramLiveGuardCode)).toEqual([]);
    const code = configuredLiveGuard(
      "424242",
      "424242",
      "fictional-owner",
      "fictional-live-channel",
    );
    const result = run(
      {
        ...update,
        message: { ...update.message, text: "/contacts Same Name" },
      },
      code,
    ) as {
      json: { help: boolean; command: { owner_id: string; text: string } };
    }[];
    expect(result[0]?.json.help).toBe(false);
    expect(result[0]?.json.command.owner_id).toBe("fictional-owner");
    expect(result[0]?.json.command.text).toBe("/contacts Same Name");
    expect(
      run(
        {
          ...update,
          message: { ...update.message, chat: { id: 424242, type: "group" } },
        },
        code,
      ),
    ).toEqual([]);
  });
  it("labels private coverage, ambiguous contacts and proposed dates without recipient spoofing", () => {
    const output = vm.runInNewContext(
      `(function(){${telegramLiveReplyCode}})()`,
      {
        $input: {
          first: () => ({
            json: {
              chat_id: "spoof",
              contacts: [
                {
                  name: "<Same>",
                  contact_id: "E1",
                  emails: ["a@example.invalid"],
                },
              ],
              contacts_total: 2,
              unavailable_record_count: 3,
              extraction_review_count: 2,
              unverified_commitment_count: 1,
              meetings: [
                {
                  occurred_at: "2026-10-13T22:00:00Z",
                  end_at: "2026-10-14T22:00:00Z",
                  all_day: true,
                  body_text: "Fictional all-day event",
                },
              ],
              lookup_note: "Ambiguous name",
              sources: [
                {
                  source: "gmail",
                  status: "partial",
                  mode: "live",
                  coverage_start: "2026-09-14",
                  coverage_end: "2026-10-14",
                },
              ],
              pending: [
                {
                  commitment_id: "C1",
                  suggested_due: "2026-10-15",
                  due_date: null,
                  status: "pending",
                },
              ],
            },
          }),
        },
        $: () => ({
          first: () => ({ json: { reply_chat_id: "424242", help: false } }),
        }),
      },
    ) as { json: { chat_id: string; text: string } }[];
    expect(output[0]?.json.chat_id).toBe("424242");
    const text = output[0]!.json.text;
    expect(text).toContain(
      "Unvalidated extraction attempts needing review: 2.",
    );
    expect(text).toContain("Promises with unavailable evidence: 1.");
    expect(text).toContain("Tend • private assistant");
    expect(text).toContain("a@example.invalid");
    expect(text).toContain("Unavailable source records needing review: 3");
    expect(text).toContain("All-day 2026-10-14 (end-exclusive 2026-10-15)");
    expect(text).toContain("Window: 2026-09-14 to 2026-10-14");
    expect(text).toContain("proposed date");
    expect(text).not.toContain("fictional data");
    expect(text).toContain("&lt;Same&gt;");
  });
});
