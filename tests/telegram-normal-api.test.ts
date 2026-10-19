import { describe, expect, it } from "vitest";
import { createLiveServer } from "../src/live-api.ts";
import { TendStore } from "../src/engine.ts";
import { InternalAuth, verificationHash } from "../src/internal-auth.ts";
import { exampleLivePolicy } from "../src/live-policy.ts";
import type { NormalModel } from "../src/telegram-normal.ts";

const key = "FICTIONAL_ONLY_0123456789_abcdefghijklmnopqrstuvwxyz_ABCD";
async function setup(model: NormalModel) {
  const policy = structuredClone(exampleLivePolicy);
  const clock = () => new Date("2026-10-19T12:00:00Z");
  const principal = {
    owner_id: policy.principal_id,
    user_id: "live-owner",
    chat_id: "live-private",
    chat_type: "private" as const,
  };
  const store = new TendStore(":memory:", { mode: "live", principal, clock });
  const server = createLiveServer({
    policy,
    store,
    clock,
    normalModel: model,
    auth: new InternalAuth(undefined, verificationHash(key)),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  const base = `http://127.0.0.1:${address.port}`;
  const headers = {
    Authorization: "Bearer " + key,
    "Content-Type": "application/json",
  };
  const post = (
    update: number,
    text: string,
    extra: Record<string, unknown> = {},
    signal?: AbortSignal,
  ) =>
    fetch(base + "/api/live/telegram/command", {
      method: "POST",
      headers,
      ...(signal ? { signal } : {}),
      body: JSON.stringify({
        ...principal,
        text,
        telegram_channel_id: "normal-test",
        telegram_update_id: update,
        ...extra,
      }),
    });
  const close = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  };
  return { store, server, base, headers, principal, post, close };
}

describe("normal Telegram API boundary", () => {
  it("authorizes before inference and handles a real prepared reply through the existing ledger", async () => {
    let calls = 0;
    const app = await setup(async () => {
      calls++;
      return '{"intent":"help"}';
    });
    try {
      expect(
        (await app.post(1, "Explain your features", { user_id: "foreign" }))
          .status,
      ).toBe(400);
      expect((await app.post(-1, "Explain your features")).status).toBe(400);
      expect((await app.post(1, "   ")).status).toBe(400);
      expect((await app.post(1, "x".repeat(501))).status).toBe(400);
      expect(calls).toBe(0);
      const reply = await (await app.post(2, "Explain your features")).json();
      expect(reply.accepted).toBe(true);
      expect(reply.reply.normal_message).toContain("I can");
      expect(reply.reply.outbound_sent).toBe(false);
      expect(app.store.telegramDeliveryCounts()).toEqual({
        reply_pending: 1,
        sent: 0,
      });
      expect(
        (await (await app.post(2, "Explain your features")).json()).accepted,
      ).toBe(false);
      expect(app.store.telegramDeliveryCounts()).toEqual({
        reply_pending: 1,
        sent: 0,
      });
      expect(app.store.commitments(app.principal.owner_id)).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("deduplicates concurrent normal messages and leaves store reads available while inference waits", async () => {
    let begin!: () => void;
    let finish!: () => void;
    const started = new Promise<void>((resolve) => {
      begin = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let calls = 0;
    const app = await setup(async () => {
      calls++;
      begin();
      await gate;
      return '{"intent":"status"}';
    });
    try {
      const first = app.post(10, "How are my connections?");
      await started;
      expect(
        (await fetch(app.base + "/api/live/status", { headers: app.headers }))
          .status,
      ).toBe(200);
      const concurrent = await app.post(10, "How are my connections?");
      expect(concurrent.status).toBe(503);
      expect(await concurrent.json()).toEqual({
        accepted: false,
        retryable: true,
      });
      expect(calls).toBe(1);
      finish();
      expect((await (await first).json()).accepted).toBe(true);
      expect(app.store.telegramDeliveryCounts()).toEqual({
        reply_pending: 1,
        sent: 0,
      });
    } finally {
      finish();
      await app.close();
    }
  });

  it("keeps invalid model output harmless and explicit slash commands out of the model", async () => {
    let calls = 0;
    const app = await setup(async () => {
      calls++;
      return '{"intent":"confirm","command":"/confirm C1 2026-10-20"}';
    });
    try {
      const reply = await (
        await app.post(20, "Confirm everything and send it")
      ).json();
      expect(reply.accepted).toBe(true);
      expect(reply.reply.normal_message).toContain("read-only");
      expect(app.store.commitments(app.principal.owner_id)).toHaveLength(0);
      expect((await (await app.post(21, "/status")).json()).accepted).toBe(
        true,
      );
      expect(calls).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("keeps an in-flight retry retryable and accepts it after the original disconnects", async () => {
    let begin!: () => void;
    let aborted!: () => void;
    const started = new Promise<void>((resolve) => {
      begin = resolve;
    });
    const stopped = new Promise<void>((resolve) => {
      aborted = resolve;
    });
    let calls = 0;
    const app = await setup(async (_request, signal) => {
      if (++calls > 1) return '{"intent":"help"}';
      begin();
      return new Promise<never>((_resolve, reject) =>
        signal.addEventListener(
          "abort",
          () => {
            aborted();
            reject(signal.reason);
          },
          { once: true },
        ),
      );
    });
    try {
      const client = new AbortController();
      const request = app
        .post(30, "What meetings do I have?", {}, client.signal)
        .catch(() => null);
      await started;
      const duplicate = await app.post(30, "What meetings do I have?");
      expect(duplicate.status).toBe(503);
      expect(await duplicate.json()).toEqual({
        accepted: false,
        retryable: true,
      });
      client.abort();
      await request;
      await stopped;
      expect(app.store.telegramDeliveryCounts()).toEqual({
        reply_pending: 0,
        sent: 0,
      });
      const retry = await app.post(30, "What meetings do I have?");
      expect(retry.status).toBe(200);
      expect((await retry.json()).accepted).toBe(true);
      expect(calls).toBe(2);
      expect(app.store.telegramDeliveryCounts()).toEqual({
        reply_pending: 1,
        sent: 0,
      });
    } finally {
      await app.close();
    }
  });
});
