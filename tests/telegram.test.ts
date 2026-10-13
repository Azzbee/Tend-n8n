import { describe, it, expect } from "vitest";
import vm from "node:vm";
import {
  telegramGuardCode,
  telegramReplyCode,
  configuredGuard,
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
describe("Telegram owner boundary", () => {
  it("fails closed until both owner IDs are configured", () =>
    expect(run(update, telegramGuardCode)).toEqual([]));
  it("accepts only the exact owner in the exact private chat", () => {
    expect(run(update)).toEqual([
      {
        json: {
          reply_chat_id: "424242",
          help: false,
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
  });
});
