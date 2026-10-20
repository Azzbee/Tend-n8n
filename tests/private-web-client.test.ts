import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  safeEvidenceUrl,
  replyPresentation,
  historyQuery,
  parisTime,
  parisDate,
  lockPrivateSession,
  matchingPassage,
  indexCoverageLines,
  contactActivityLines,
} from "../src/private-web-client.ts";
import { animationAllowed, profilePixels } from "../src/pixel-art.ts";

describe("private dashboard presentation", () => {
  it("shows only server-provided contact activity and keeps zero activity explicit", () => {
    expect(contactActivityLines(undefined)).toEqual([]);
    expect(
      contactActivityLines({ count: 0, last_at: null, sources: [] }),
    ).toEqual(["0 eligible imported items"]);
    const lines = contactActivityLines({
      count: 4,
      last_at: "2026-10-20T09:00:00Z",
      sources: ["gmail", "linkedin"],
    });
    expect(lines[0]).toBe("4 eligible imported items");
    expect(lines[1]).toContain("11:00");
    expect(lines[2]).toBe("Email · LinkedIn");
  });
  it("shows a matching passage beyond the opening 500 characters and rejects forged offsets", () => {
    const text =
      "Opening ".repeat(80) +
      "The onboarding experiment changed after feedback.";
    const start = text.indexOf("The onboarding");
    const record = { record_key: "canonical", body_text: text };
    const match = {
      record_key: "canonical",
      start,
      end: text.length,
      text: text.slice(start),
      similarity: 0.74,
    };
    expect(start).toBeGreaterThan(500);
    expect(matchingPassage(record, [match])?.text).toBe(
      "The onboarding experiment changed after feedback.",
    );
    expect(
      matchingPassage(record, [{ ...match, text: "Invented paraphrase" }]),
    ).toBeNull();
    expect(
      matchingPassage(record, [{ ...match, end: text.length + 1 }]),
    ).toBeNull();
  });
  it("explains partial index coverage without exposing raw technical fields", () => {
    const lines = indexCoverageLines({
      state: "indexing",
      complete: 5,
      total: 20,
      pending: 15,
      partial: 2,
      watermark: "internal",
      fingerprint: "secret-internal",
    }).join(" ");
    expect(lines).toContain("5 of 20 imported records fully indexed");
    expect(lines).toContain("15 records still waiting");
    expect(lines).toContain("2 records only partly indexed");
    expect(lines).not.toContain("secret-internal");
  });
  it("withdraws local correspondence before waiting for a slow logout", async () => {
    let resolve: ((response: Response) => void) | undefined;
    const pending = new Promise<Response>((done) => {
      resolve = done;
    });
    let withdrawn = false;
    const fetchMock = vi.fn(() => {
      expect(withdrawn).toBe(true);
      return pending;
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const result = lockPrivateSession("fictional-csrf", () => {
        withdrawn = true;
      });
      expect(withdrawn).toBe(true);
      expect(fetchMock).toHaveBeenCalledOnce();
      resolve!(new Response("{}"));
      await result;
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("accepts only explicit web source links and leaves other references literal", () => {
    expect(safeEvidenceUrl("javascript:alert(1)")).toBeNull();
    expect(
      safeEvidenceUrl("data:text/html,<script>alert(1)</script>"),
    ).toBeNull();
    expect(safeEvidenceUrl("/api/live/ingest")).toBeNull();
    expect(
      safeEvidenceUrl("https://mail.google.com/mail/u/0/#inbox/123"),
    ).toContain("https://mail.google.com");
  });
  it("keeps generated draft and source excerpts separate", () => {
    const value = replyPresentation({
      outbound_sent: false,
      normal_message: "Held for review",
      preview: "Hello <img src=x onerror=alert(1)>",
      evidence: [
        { source: "gmail", text: "Literal evidence", reference: "gmail:1" },
      ],
    });
    expect(value.draft).toContain("<img");
    expect(value.evidence).toEqual([
      { source: "gmail", text: "Literal evidence", reference: "gmail:1" },
    ]);
    expect(value.message).toBe("Held for review");
    expect(
      replyPresentation({
        outbound_sent: false,
        evidence: [null, { text: 42 }],
      }).evidence,
    ).toEqual([]);
  });
  it("encodes contact and filter selections independently", () => {
    const query = historyQuery("id&source=other", {
      source: "gmail",
      direction: "sent",
      from: "2026-10-01",
      to: "",
      cursor: "opaque+cursor",
    });
    expect(query.get("selector")).toBe("id&source=other");
    expect(query.get("source")).toBe("gmail");
    expect(query.get("cursor")).toBe("opaque+cursor");
    expect(query.has("to")).toBe(false);
  });
  it("formats exact Paris dates and preserves invalid input safely", () => {
    expect(parisTime("2026-10-20T09:00:00Z")).toContain("11:00");
    expect(parisTime("unknown")).toBe("unknown");
    expect(parisDate("2026-10-22T22:00:00Z")).toBe("23 Oct 2026");
    expect(parisDate("2026-10-22T22:00:00Z")).not.toContain(":");
  });
  it("honours motion pause, device settings and hidden tabs", () => {
    expect(animationAllowed(false, false, false)).toBe(true);
    expect(animationAllowed(true, false, false)).toBe(false);
    expect(animationAllowed(false, true, false)).toBe(false);
    expect(animationAllowed(false, false, true)).toBe(false);
    expect(profilePixels().length).toBeGreaterThan(500);
  });
  it("ships a data-free locked shell and no inline handlers or external assets", () => {
    const html = readFileSync(
      new URL("../web/private/index.html", import.meta.url),
      "utf8",
    );
    expect(html).toContain('id="workspace" hidden');
    expect(html).toContain('id="locked"');
    expect(html).toContain('action="/private/unlock"');
    expect(html).toContain('name="nonce" value="__TEND_NONCE__"');
    expect(html).not.toMatch(/on(?:click|error|load)=|https?:\/\//);
    const client = readFileSync(
      new URL("../src/private-web-client.ts", import.meta.url),
      "utf8",
    );
    expect(client).not.toMatch(/innerHTML|localStorage|sessionStorage|Bearer /);
    expect(client).toContain('mode: "cors"');
    expect(client).toContain("body: new URLSearchParams({ nonce })");
    expect(html).toContain('name="referrer" content="no-referrer"');
  });
});
