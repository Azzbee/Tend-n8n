import { describe, expect, it } from "vitest";
import {
  DailyBriefingService,
  dailyBriefingSchedule,
  type DailyBriefingLedger,
  type DailyBriefingRow,
} from "../src/daily-briefing.ts";

class Ledger implements DailyBriefingLedger {
  rows = new Map<string, DailyBriefingRow>();
  private key(owner: string, day: string): string {
    return JSON.stringify([owner, day]);
  }
  async get(owner: string, day: string): Promise<DailyBriefingRow | null> {
    return structuredClone(this.rows.get(this.key(owner, day)) ?? null);
  }
  async latest(
    owner: string,
    sentOnly = false,
  ): Promise<DailyBriefingRow | null> {
    const rows = [...this.rows.values()]
      .filter(
        (row) => row.owner_id === owner && (!sentOnly || row.state === "sent"),
      )
      .sort((a, b) => b.paris_date.localeCompare(a.paris_date));
    return structuredClone(rows[0] ?? null);
  }
  async insert(row: DailyBriefingRow): Promise<boolean> {
    const key = this.key(row.owner_id, row.paris_date);
    if (this.rows.has(key)) return false;
    this.rows.set(key, structuredClone(row));
    return true;
  }
  async replace(revision: number, row: DailyBriefingRow): Promise<boolean> {
    const key = this.key(row.owner_id, row.paris_date);
    if (this.rows.get(key)?.revision !== revision) return false;
    this.rows.set(key, structuredClone(row));
    return true;
  }
}
function setup(initial = "2026-10-20T07:00:00Z") {
  const ledger = new Ledger();
  let now = new Date(initial),
    calls = 0,
    valid = true,
    fail = false;
  const service = new DailyBriefingService({
    owner: { owner_id: "owner", user_id: "12345", chat_id: "12345" },
    ledger,
    clock: () => now,
    prepare: async () => {
      calls++;
      if (fail) throw new Error("private provider detail");
      return {
        reply: { outbound_sent: false, normal_message: "Priorities" },
        record_guards: [],
      };
    },
    validateAndFormat: async () =>
      valid ? "Dated priorities & source coverage" : null,
  });
  return {
    service,
    ledger,
    calls: () => calls,
    time: (s: string) => {
      now = new Date(s);
    },
    invalidate: () => {
      valid = false;
    },
    failure: () => {
      fail = true;
    },
  };
}
const ack = {
  ok: true,
  result: { message_id: 47, chat: { id: 12345, type: "private" } },
};

describe("Paris daily scheduling", () => {
  it.each([
    ["2026-10-20T06:59:59Z", false, false, "2026-10-20T07:00:00.000Z"],
    ["2026-10-20T07:00:00Z", true, false, "2026-10-21T07:00:00.000Z"],
    ["2026-10-20T09:59:59Z", true, false, "2026-10-21T07:00:00.000Z"],
    ["2026-10-20T10:00:00Z", false, true, "2026-10-21T07:00:00.000Z"],
    ["2026-10-25T08:00:00Z", true, false, "2026-10-26T08:00:00.000Z"],
    ["2027-03-28T07:00:00Z", true, false, "2027-03-29T07:00:00.000Z"],
  ])("handles %s", (instant, due, missed, next) => {
    const s = dailyBriefingSchedule(new Date(instant));
    expect(s.due).toBe(due);
    expect(s.missed).toBe(missed);
    expect(s.next_scheduled_at).toBe(next);
  });
  it("rejects an invalid clock", () => {
    expect(() => dailyBriefingSchedule(new Date("bad"))).toThrow();
  });
});

describe("durable owner daily delivery", () => {
  it("does no preparation before 09:00", async () => {
    const x = setup("2026-10-20T06:59:00Z");
    expect((await x.service.prepare()).state).toBe("not_due");
    expect(x.calls()).toBe(0);
    expect(x.ledger.rows.size).toBe(0);
  });
  it("prepares once under concurrent scheduler ticks", async () => {
    const x = setup();
    const results = await Promise.all([
      x.service.prepare(),
      x.service.prepare(),
    ]);
    expect(results.every((r) => r.paris_date === "2026-10-20")).toBe(true);
    expect(x.calls()).toBe(1);
    expect(x.ledger.rows.size).toBe(1);
  });
  it("only one concurrent claim can return transport content", async () => {
    const x = setup();
    const prepared = await x.service.prepare();
    const sent = await Promise.all([
      x.service.claim(prepared.paris_date, prepared.delivery_id!),
      x.service.claim(prepared.paris_date, prepared.delivery_id!),
    ]);
    expect(sent.filter(Boolean)).toHaveLength(1);
    expect(sent.find(Boolean)?.chat_id).toBe("12345");
    expect((await x.service.prepare()).state).toBe("uncertain");
  });
  it("accepts only an actual private owner acknowledgement", async () => {
    const x = setup();
    const p = await x.service.prepare();
    await x.service.claim(p.paris_date, p.delivery_id!);
    await expect(
      x.service.acknowledge(p.paris_date, p.delivery_id!, ack),
    ).resolves.toBe(true);
    expect((await x.service.prepare()).state).toBe("sent");
    expect(await x.service.claim(p.paris_date, p.delivery_id!)).toBeNull();
    const row = await x.ledger.get("owner", p.paris_date);
    expect(row?.telegram_message_id).toBe(47);
    expect(row?.prepared).toBeNull();
  });
  it.each([
    { ok: false, result: ack.result },
    { result: ack.result },
    { ok: true, result: { ...ack.result, message_id: 0 } },
    { ok: true, result: { ...ack.result, message_id: 1.5 } },
    { ok: true, result: { ...ack.result, chat: { id: 99, type: "private" } } },
    { ok: true, result: { ...ack.result, chat: { id: 12345, type: "group" } } },
    {
      ok: true,
      result: { ...ack.result, chat: { id: "012345", type: "private" } },
    },
  ])("rejects a mismatched or missing native receipt %#", async (receipt) => {
    const x = setup();
    const p = await x.service.prepare();
    await x.service.claim(p.paris_date, p.delivery_id!);
    await expect(
      x.service.acknowledge(p.paris_date, p.delivery_id!, receipt),
    ).rejects.toThrow();
    expect((await x.service.prepare()).state).toBe("uncertain");
    expect(await x.service.claim(p.paris_date, p.delivery_id!)).toBeNull();
  });
  it("allows a late valid acknowledgement after an uncertain send", async () => {
    const x = setup();
    const p = await x.service.prepare();
    await x.service.claim(p.paris_date, p.delivery_id!);
    await x.service.markUncertain(p.paris_date, p.delivery_id!);
    expect(await x.service.acknowledge(p.paris_date, p.delivery_id!, ack)).toBe(
      true,
    );
    expect((await x.service.prepare()).state).toBe("sent");
  });
  it("does not resend after a service object is recreated", async () => {
    const x = setup();
    const p = await x.service.prepare();
    await x.service.claim(p.paris_date, p.delivery_id!);
    const again = new DailyBriefingService({
      owner: { owner_id: "owner", user_id: "12345", chat_id: "12345" },
      ledger: x.ledger,
      clock: () => new Date("2026-10-20T08:00:00Z"),
      prepare: async () => {
        throw new Error("must not prepare");
      },
      validateAndFormat: async () => {
        throw new Error("must not validate");
      },
    });
    expect((await again.prepare()).state).toBe("uncertain");
    expect(await again.claim(p.paris_date, p.delivery_id!)).toBeNull();
  });
  it("revalidates evidence before marking sending", async () => {
    const x = setup();
    const p = await x.service.prepare();
    x.invalidate();
    expect(await x.service.claim(p.paris_date, p.delivery_id!)).toBeNull();
    expect((await x.ledger.get("owner", p.paris_date))?.state).toBe("pending");
  });
  it("marks after-noon invocation missed without preparing", async () => {
    const x = setup("2026-10-20T10:00:00Z");
    expect((await x.service.prepare()).state).toBe("missed");
    expect(x.calls()).toBe(0);
  });
  it("never sends yesterday's prepared content", async () => {
    const x = setup();
    const p = await x.service.prepare();
    x.time("2026-10-21T07:30:00Z");
    expect(await x.service.claim(p.paris_date, p.delivery_id!)).toBeNull();
    const today = await x.service.prepare();
    expect(today.paris_date).toBe("2026-10-21");
    expect(today.catch_up).toBe(true);
  });
  it("does not claim at noon even when preparation finished before noon", async () => {
    const x = setup("2026-10-20T09:59:00Z");
    const p = await x.service.prepare();
    x.time("2026-10-20T10:00:00Z");
    expect(await x.service.claim(p.paris_date, p.delivery_id!)).toBeNull();
    expect((await x.service.prepare()).state).toBe("missed");
  });
  it("bounds known pre-send preparation failures at three attempts", async () => {
    const x = setup();
    x.failure();
    for (let i = 0; i < 8; i++) {
      await x.service.prepare();
      x.time(`2026-10-20T07:0${i + 1}:00Z`);
    }
    expect(x.calls()).toBe(3);
    expect((await x.service.status()).delivery?.failure).toBe(
      "preparation_failed",
    );
  });
  it("never accepts a different owner destination", () => {
    const x = setup();
    expect(
      () =>
        new DailyBriefingService({
          owner: { owner_id: "owner", user_id: "12345", chat_id: "99" },
          ledger: x.ledger,
          prepare: async () => ({
            reply: { outbound_sent: false },
            record_guards: [],
          }),
          validateAndFormat: async () => "content",
        }),
    ).toThrow();
  });
  it("rejects arbitrary date and delivery identifiers", async () => {
    const x = setup();
    await expect(x.service.claim("bad", "bad")).rejects.toThrow();
    await expect(x.service.claim("2026-02-30", "bad")).rejects.toThrow();
  });
  it("accepts duplicate matching acknowledgements without changing the ledger", async () => {
    const x = setup();
    const p = await x.service.prepare();
    await x.service.claim(p.paris_date, p.delivery_id!);
    await x.service.acknowledge(p.paris_date, p.delivery_id!, ack);
    const before = await x.ledger.get("owner", p.paris_date);
    expect(await x.service.acknowledge(p.paris_date, p.delivery_id!, ack)).toBe(
      true,
    );
    expect(await x.ledger.get("owner", p.paris_date)).toEqual(before);
    expect(
      await x.service.acknowledge(p.paris_date, p.delivery_id!, {
        ...ack,
        result: { ...ack.result, message_id: 48 },
      }),
    ).toBe(false);
  });
  it("keeps prepared content out of status", async () => {
    const x = setup();
    await x.service.prepare();
    expect((await x.service.status()).delivery).not.toHaveProperty("prepared");
  });
  it("rejects pre-send acknowledgements", async () => {
    const x = setup();
    const p = await x.service.prepare();
    expect(await x.service.acknowledge(p.paris_date, p.delivery_id!, ack)).toBe(
      false,
    );
  });
  it("validates after the five-minute prepared read expires by preparing again", async () => {
    const x = setup();
    const p = await x.service.prepare();
    x.time("2026-10-20T07:05:00Z");
    expect(await x.service.claim(p.paris_date, p.delivery_id!)).toBeNull();
    const retry = await x.service.prepare();
    expect(retry.delivery_id).toBe(p.delivery_id);
    expect(x.calls()).toBe(2);
    expect(
      await x.service.claim(retry.paris_date, retry.delivery_id!),
    ).not.toBeNull();
  });
  it("rechecks the noon cutoff after evidence validation finishes", async () => {
    const ledger = new Ledger();
    let time = new Date("2026-10-20T09:59:59Z");
    const service = new DailyBriefingService({
      owner: { owner_id: "owner", user_id: "12345", chat_id: "12345" },
      ledger,
      clock: () => time,
      prepare: async () => ({
        reply: { outbound_sent: false },
        record_guards: [],
      }),
      validateAndFormat: async () => {
        time = new Date("2026-10-20T10:00:00Z");
        return "Validated at noon";
      },
    });
    const p = await service.prepare();
    expect(await service.claim(p.paris_date, p.delivery_id!)).toBeNull();
    expect((await ledger.get("owner", p.paris_date))?.state).toBe("pending");
  });
  it("refuses content that claims an outbound action already happened", async () => {
    const ledger = new Ledger();
    const service = new DailyBriefingService({
      owner: { owner_id: "owner", user_id: "12345", chat_id: "12345" },
      ledger,
      clock: () => new Date("2026-10-20T07:00:00Z"),
      prepare: async () => ({
        reply: { outbound_sent: true } as never,
        record_guards: [],
      }),
      validateAndFormat: async () => "must not send",
    });
    const p = await service.prepare();
    expect((await service.status()).delivery?.failure).toBe(
      "preparation_failed",
    );
    expect(await service.claim(p.paris_date, p.delivery_id!)).toBeNull();
  });
  it("accepts the actual unwrapped native Telegram node receipt", async () => {
    const x = setup();
    const p = await x.service.prepare();
    await x.service.claim(p.paris_date, p.delivery_id!);
    expect(
      await x.service.acknowledge(p.paris_date, p.delivery_id!, ack.result),
    ).toBe(true);
  });
  it("records slept-through days as missed and reports the previous delivery", async () => {
    const x = setup();
    const p = await x.service.prepare();
    await x.service.claim(p.paris_date, p.delivery_id!);
    await x.service.acknowledge(p.paris_date, p.delivery_id!, ack);
    x.time("2026-10-23T06:30:00Z");
    expect((await x.service.status()).latest_delivery?.state).toBe("sent");
    expect((await x.service.prepare()).state).toBe("not_due");
    expect((await x.ledger.get("owner", "2026-10-21"))?.state).toBe("missed");
    expect((await x.ledger.get("owner", "2026-10-22"))?.state).toBe("missed");
    expect(x.calls()).toBe(1);
    expect((await x.service.status()).last_sent_delivery?.paris_date).toBe(
      "2026-10-20",
    );
  });
  it("resumes long sleep accounting in bounded batches without sending old content", async () => {
    const ledger = new Ledger();
    const service = new DailyBriefingService({
      owner: { owner_id: "owner", user_id: "12345", chat_id: "12345" },
      ledger,
      enabledAt: "2026-08-01T07:00:00Z",
      clock: () => new Date("2026-10-20T07:00:00Z"),
      prepare: async () => ({
        reply: { outbound_sent: false },
        record_guards: [],
      }),
      validateAndFormat: async () => "Current day only",
    });
    expect((await service.prepare()).accounting_partial).toBe(true);
    expect(ledger.rows.size).toBe(31);
    expect((await service.prepare()).accounting_partial).toBe(true);
    expect(ledger.rows.size).toBe(62);
    expect((await service.prepare()).paris_date).toBe("2026-10-20");
    expect(ledger.rows.size).toBe(81);
    expect((await ledger.get("owner", "2026-10-20"))?.state).toBe("pending");
  });
});
