import { describe, expect, it } from "vitest";
import {
  assertGoogleRead,
  calendarWindow,
  exampleLivePolicy,
  gmailWindow,
  parseLivePolicy,
} from "../src/live-policy.ts";

describe("private read-only live policy", () => {
  it("keeps autumn repeated-hour coverage nondecreasing through the clock reset", () => {
    const times = [
      "2026-10-25T00:59:59.999Z",
      "2026-10-25T01:00:00Z",
      "2026-10-25T01:59:59.999Z",
      "2026-10-25T02:00:00Z",
    ];
    const ends = times.map((t) =>
      Date.parse(calendarWindow(exampleLivePolicy, new Date(t)).end),
    );
    for (let i = 1; i < ends.length; i++)
      expect(ends[i]).toBeGreaterThanOrEqual(ends[i - 1]!);
    expect(new Date(ends[1]!).toISOString()).toBe("2026-11-01T02:00:00.000Z");
  });
  it("uses only fictional tracked settings and validates exact scope", () => {
    expect(exampleLivePolicy.account_email).toBe("owner@example.invalid");
    expect(parseLivePolicy(exampleLivePolicy)).toEqual(exampleLivePolicy);
    for (const override of [
      { mail_window_days: 31 },
      { calendar_window_days: 8 },
      { timezone: "UTC" },
      { calendar_ids: [] },
      { verified_owner_emails: ["someone@example.invalid"] },
      { limits: { ...exampleLivePolicy.limits, max_attempts: 100 } },
      { writes_allowed: true },
      {
        account_email: "Owner@example.invalid",
        verified_owner_emails: ["Owner@example.invalid"],
      },
    ])
      expect(() =>
        parseLivePolicy({ ...exampleLivePolicy, ...override }),
      ).toThrow();
  });
  it("binds exact verified account/calendar and denies provider writes", () => {
    assertGoogleRead(
      exampleLivePolicy,
      "owner@example.invalid",
      "gmail.messages.get",
    );
    assertGoogleRead(
      exampleLivePolicy,
      "owner@example.invalid",
      "calendar.events.list",
      "primary",
    );
    for (const args of [
      ["foreign@example.invalid", "gmail.messages.get", undefined],
      ["owner@example.invalid", "gmail.messages.send", undefined],
      ["owner@example.invalid", "calendar.events.insert", "primary"],
      ["owner@example.invalid", "calendar.events.list", "other"],
      ["owner@example.invalid", "calendar.events.list", undefined],
    ] as const)
      expect(() =>
        assertGoogleRead(exampleLivePolicy, args[0], args[1], args[2]),
      ).toThrow();
  });
  it("uses injected time and a rolling 30-day mail window", () => {
    const now = new Date("2026-10-24T12:00:00Z");
    expect(gmailWindow(exampleLivePolicy, now)).toEqual({
      start: "2026-09-24T12:00:00.000Z",
      end: now.toISOString(),
    });
    expect(() => gmailWindow(exampleLivePolicy, new Date("bad"))).toThrow();
  });
  it("keeps Paris local time across the autumn DST transition", () => {
    expect(
      calendarWindow(exampleLivePolicy, new Date("2026-10-24T12:00:00Z")),
    ).toEqual({
      start: "2026-10-24T12:00:00.000Z",
      end: "2026-10-31T13:00:00.000Z",
    });
  });
  it("moves a rolling-window endpoint forward through a spring clock gap", () => {
    expect(
      calendarWindow(exampleLivePolicy, new Date("2027-03-21T01:30:00Z")),
    ).toEqual({
      start: "2027-03-21T01:30:00.000Z",
      end: "2027-03-28T01:00:00.000Z",
    });
  });
  it("does not move a future spring-gap endpoint backwards as the clock advances", () => {
    const before = calendarWindow(
      exampleLivePolicy,
      new Date("2027-03-21T01:59:00Z"),
    );
    const after = calendarWindow(
      exampleLivePolicy,
      new Date("2027-03-21T02:00:00Z"),
    );
    expect(Date.parse(after.end)).toBeGreaterThanOrEqual(
      Date.parse(before.end),
    );
  });
});
