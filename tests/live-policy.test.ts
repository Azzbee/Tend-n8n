import { describe, expect, it } from "vitest";
import {
  assertGoogleRead,
  calendarWindow,
  exampleLivePolicy,
  gmailWindow,
  parseLivePolicy,
} from "../src/live-policy.ts";

describe("private read-only live policy", () => {
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
});
