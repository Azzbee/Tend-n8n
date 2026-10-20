import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  mountPrivateWorkspace,
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

class BrowserElement extends EventTarget {
  hidden = false;
  disabled = false;
  value = "";
  textContent: string | null = null;
  className = "";
  children: BrowserElement[] = [];
  append(...children: BrowserElement[]): void {
    this.children.push(...children);
  }
  replaceChildren(...children: BrowserElement[]): void {
    this.children = children;
    this.textContent = null;
  }
  querySelector(): null {
    return null;
  }
  setAttribute(): void {}
  getContext(): null {
    return null;
  }
}
class TestChannel {
  static all: TestChannel[] = [];
  static posts: unknown[] = [];
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  closed = false;
  constructor(readonly name: string) {
    TestChannel.all.push(this);
  }
  postMessage(value: unknown): void {
    TestChannel.posts.push(value);
    for (const other of TestChannel.all)
      if (other !== this && !other.closed && other.name === this.name)
        other.onmessage?.(new MessageEvent("message", { data: value }));
  }
  close(): void {
    this.closed = true;
  }
}
function browserFixture(
  options: { revoked?: boolean; contact?: boolean } = {},
): {
  elements: Map<string, BrowserElement>;
  window: EventTarget;
  fetch: ReturnType<typeof vi.fn>;
} {
  const elements = new Map<string, BrowserElement>();
  const element = (id: string): BrowserElement => {
    let value = elements.get(id);
    if (!value) {
      value = new BrowserElement();
      elements.set(id, value);
    }
    return value;
  };
  const document = Object.assign(new EventTarget(), {
    hidden: false,
    getElementById: element,
    createElement: (): BrowserElement => new BrowserElement(),
  });
  const window = new EventTarget();
  const expires = new Date(Date.now() + 30 * 60000).toISOString();
  let checks = 0;
  const reply = {
    view_id: "view",
    reply: {
      outbound_sent: false,
      preview: "Hello Mira, here is the requested update.",
    },
    checked_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 5 * 60000).toISOString(),
    valid: true,
  };
  const fetch = vi.fn(async (path: string): Promise<Response> => {
    if (path === "/private/api/session") {
      checks++;
      return options.revoked && checks > 1
        ? Response.json({ error: "locked" }, { status: 401 })
        : Response.json({
            unlocked: true,
            csrf: "fictional-csrf",
            expires_at: expires,
          });
    }
    if (path.startsWith("/private/api/contacts"))
      return Response.json({
        contacts: options.contact
          ? [
              {
                owner_id: "owner",
                contact_id: "F17",
                name: "Mira",
                emails: ["mira@example.invalid"],
              },
            ]
          : [],
        next_cursor: null,
      });
    if (path.startsWith("/private/api/history"))
      return Response.json({
        records: [],
        next_cursor: null,
        total: 0,
        sources: [],
        commitments: [],
      });
    if (path === "/private/api/draft" || path === "/private/api/revalidate")
      return Response.json(reply);
    return Response.json({});
  });
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", window);
  vi.stubGlobal("BroadcastChannel", TestChannel);
  vi.stubGlobal("fetch", fetch);
  return { elements, window, fetch };
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  TestChannel.all = [];
  TestChannel.posts = [];
});
describe("mounted private session withdrawal", () => {
  it("checks the session without a held view and clears correspondence after a remote 401", async () => {
    vi.useFakeTimers();
    const browser = browserFixture({ revoked: true });
    mountPrivateWorkspace();
    await vi.advanceTimersByTimeAsync(0);
    expect(browser.elements.get("workspace")?.hidden).toBe(false);
    browser.elements.get("timeline")!.textContent = "Private correspondence";
    await vi.advanceTimersByTimeAsync(15000);
    expect(browser.elements.get("workspace")?.hidden).toBe(true);
    expect(browser.elements.get("timeline")?.textContent).toBeNull();
    expect(
      browser.fetch.mock.calls.filter(
        ([path]) => path === "/private/api/session",
      ),
    ).toHaveLength(2);
  });
  it("clears another tab immediately without rebroadcasting its lock signal", async () => {
    vi.useFakeTimers();
    const browser = browserFixture();
    mountPrivateWorkspace();
    await vi.advanceTimersByTimeAsync(0);
    const otherTab = new TestChannel("tend-private");
    otherTab.postMessage("lock");
    expect(browser.elements.get("workspace")?.hidden).toBe(true);
    expect(TestChannel.posts).toEqual(["lock"]);
    expect(TestChannel.all[0]?.closed).toBe(true);
  });
  it("uses wall-clock expiry on wake before a paused expiry timer fires", async () => {
    vi.useFakeTimers();
    const browser = browserFixture();
    mountPrivateWorkspace();
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(Date.now() + 31 * 60000);
    browser.window.dispatchEvent(new Event("pageshow"));
    expect(browser.elements.get("workspace")?.hidden).toBe(true);
  });
  it("broadcasts only a lock signal and stops session polling after a local lock", async () => {
    vi.useFakeTimers();
    const browser = browserFixture();
    mountPrivateWorkspace();
    await vi.advanceTimersByTimeAsync(0);
    browser.elements.get("lock")!.dispatchEvent(new Event("click"));
    expect(browser.elements.get("workspace")?.hidden).toBe(true);
    expect(TestChannel.posts).toEqual(["lock"]);
    expect(TestChannel.all[0]?.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(15000);
    expect(
      browser.fetch.mock.calls.filter(
        ([path]) => path === "/private/api/session",
      ),
    ).toHaveLength(1);
  });
  it("preserves a validated held draft when the browser refuses clipboard access", async () => {
    vi.useFakeTimers();
    const browser = browserFixture({ contact: true });
    vi.stubGlobal("navigator", {
      clipboard: {
        writeText: vi.fn(async () => {
          throw new Error("clipboard denied");
        }),
      },
    });
    mountPrivateWorkspace();
    await vi.advanceTimersByTimeAsync(0);
    browser.elements
      .get("contacts")!
      .children[0]!.dispatchEvent(new Event("click"));
    await vi.advanceTimersByTimeAsync(0);
    browser.elements.get("draft")!.dispatchEvent(new Event("click"));
    await vi.advanceTimersByTimeAsync(0);
    browser.elements.get("copy-draft")!.dispatchEvent(new Event("click"));
    await vi.advanceTimersByTimeAsync(0);
    expect(browser.elements.get("prepared")?.hidden).toBe(false);
    expect(browser.elements.get("draft-text")?.textContent).toContain(
      "Hello Mira",
    );
    expect(browser.elements.get("notice")?.textContent).toContain(
      "Select the draft text",
    );
  });
});
