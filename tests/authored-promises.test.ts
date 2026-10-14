import { describe, expect, it } from "vitest";
import {
  authoredSpans,
  isExplicitCommitment,
  eligiblePromiseSpans,
} from "../src/authored-promises.ts";

describe("authored commitment screening", () => {
  it.each([
    "I'll send the draft tomorrow.",
    "I’ll review the proposal.",
    "I will send it.",
    "I promise to call you.",
    "Je vais envoyer le rapport.",
    "J’enverrai le rapport.",
    "Je t'enverrai le fichier.",
    "Je vous enverrai le document.",
    "Je m’engage à relire le document.",
  ])("accepts an explicit first-person candidate: %s", (text) =>
    expect(isExplicitCommitment(text)).toBe(true),
  );
  it.each([
    "I'll send it?",
    "I will not send it.",
    "I won't call.",
    "If I will send it, reply.",
    "I will send it if approved.",
    "I would send it.",
    "Je ne vais pas envoyer le rapport.",
    "Je vais peut-être envoyer le rapport.",
    "Will I send it?",
    '"I will send it."',
    "She said I will send it.",
    "I will be happy.",
    "I will not only send it.",
  ])("excludes ambiguous/negative/quoted candidates: %s", (text) =>
    expect(isExplicitCommitment(text)).toBe(false),
  );
  it("stops at quotes and signatures and returns exact offsets", () => {
    const text = " Hi  \nI'll send it.\n-- \nI will call.\n> I will write.";
    const spans = authoredSpans(text);
    expect(spans.map((s) => s.text)).toEqual(["Hi", "I'll send it."]);
    for (const span of spans)
      expect(text.slice(span.start, span.end)).toBe(span.text);
  });
  it("stops before ordinary signature blocks", () => {
    expect(
      authoredSpans(
        "Thanks for the call.\nBest regards,\nI will Senderson",
      ).map((s) => s.text),
    ).toEqual(["Thanks for the call."]);
  });
  it("does not extract attributed groups, unknown speakers, or events", () => {
    const base = {
      authored_spans: authoredSpans("I'll send it."),
      attribution: "direct" as const,
      eligible_for_extraction: true,
      kind: "message",
      direction: "sent" as const,
      cancelled: false,
    };
    expect(eligiblePromiseSpans(base)).toHaveLength(1);
    expect(eligiblePromiseSpans({ ...base, attribution: "group" })).toEqual([]);
    expect(eligiblePromiseSpans({ ...base, attribution: "unknown" })).toEqual(
      [],
    );
    expect(eligiblePromiseSpans({ ...base, direction: "event" })).toEqual([]);
    expect(eligiblePromiseSpans({ ...base, cancelled: true })).toEqual([]);
  });
});
