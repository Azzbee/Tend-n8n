import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  mountPrivateWorkspace,
  safeEvidenceUrl,
  preparedHeading,
  replyPresentation,
  historyQuery,
  parisTime,
  parisDate,
  lockPrivateSession,
  matchingPassage,
  indexCoverageLines,
  contactActivityLines,
} from "../src/private-web-client.ts";
import {
  animationAllowed,
  motionButtonState,
  profilePixels,
} from "../src/pixel-art.ts";

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
  it("marks the motion toggle with aria-pressed and keeps its label", () => {
    expect(motionButtonState(false, false)).toEqual({
      label: "Pause motion",
      disabled: false,
      pressed: "false",
    });
    expect(motionButtonState(true, false)).toEqual({
      label: "Pause motion",
      disabled: false,
      pressed: "true",
    });
    expect(motionButtonState(true, true)).toEqual({
      label: "Motion off (device setting)",
      disabled: true,
      pressed: null,
    });
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
  options: {
    revoked?: boolean;
    contact?: boolean;
    history?: unknown[];
    fallback?: boolean;
  } = {},
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
    querySelectorAll: (): BrowserElement[] => [],
  });
  // These checks cover the People view; the Desk views have their own tests.
  const window = Object.assign(new EventTarget(), {
    location: { hash: "#people" },
  });
  const expires = new Date(Date.now() + 30 * 60000).toISOString();
  let checks = 0;
  const reply = {
    view_id: "view",
    reply: options.fallback
      ? {
          outbound_sent: false,
          normal_message:
            "AI output was unavailable or unsupported. Showing current source excerpts only; no generated claim was retained.",
          ai: { status: "fallback", draft: null },
          evidence: [
            {
              source: "gmail",
              text: "I will send the demo by 2026-10-15.",
              reference: "tend-source:gmail/owner/g1",
            },
          ],
        }
      : {
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
    if (path === "/private/api/progress")
      return Response.json({
        history: options.history ?? [],
        daily: { enabled: false },
      });
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

describe("held draft fallback", () => {
  it("says no draft was written and shows the fallback reason when the model returns none", async () => {
    vi.useFakeTimers();
    const browser = browserFixture({ contact: true, fallback: true });
    mountPrivateWorkspace();
    await vi.advanceTimersByTimeAsync(0);
    browser.elements
      .get("contacts")!
      .children[0]!.dispatchEvent(new Event("click"));
    await vi.advanceTimersByTimeAsync(0);
    browser.elements.get("draft")!.dispatchEvent(new Event("click"));
    await vi.advanceTimersByTimeAsync(0);
    expect(browser.elements.get("prepared-label")?.textContent).toBe(
      "NO DRAFT WRITTEN · SOURCE EXCERPTS ONLY",
    );
    expect(browser.elements.get("prepared-message")?.textContent).toContain(
      "AI output was unavailable",
    );
    expect(browser.elements.get("copy-draft")?.hidden).toBe(true);
    expect(preparedHeading("briefing", { draft: null, evidence: [] })).toBe(
      "CONTACT BRIEFING",
    );
    expect(preparedHeading("draft", { draft: null, evidence: [] })).toBe(
      "NO DRAFT WRITTEN",
    );
    expect(preparedHeading("draft", { draft: "Hi", evidence: [] })).toBe(
      "HELD DRAFT · REVIEW BEFORE USE",
    );
  });
});

describe("historical content review coverage", () => {
  it("refreshes only saved progress without retrying or replacing a held draft", async () => {
    vi.useFakeTimers();
    const browser = browserFixture();
    mountPrivateWorkspace();
    await vi.advanceTimersByTimeAsync(0);
    browser.elements.get("timeline")!.textContent = "Held work stays here";
    browser.elements.get("refresh-progress")!.dispatchEvent(new Event("click"));
    await vi.advanceTimersByTimeAsync(0);
    expect(
      browser.fetch.mock.calls.filter(
        ([path]) => path === "/private/api/progress",
      ),
    ).toHaveLength(2);
    expect(
      browser.fetch.mock.calls.some(
        ([path]) => path === "/private/api/history-retry",
      ),
    ).toBe(false);
    expect(browser.elements.get("timeline")!.textContent).toBe(
      "Held work stays here",
    );
    expect(browser.elements.get("progress-checked")!.textContent).toMatch(
      /^Saved progress checked \d{2} \w{3} \d{4}/,
    );
  });

  it("keeps unavailable content explicit after pagination finishes and shows bounded source references", async () => {
    vi.useFakeTimers();
    const browser = browserFixture({
      history: [
        {
          source: "gmail",
          account_id: "owner@example.invalid",
          status: "complete",
          page_count: 3,
          record_count: 18,
          quarantined_count: 2,
          watermark: "2026-10-20T10:00:00Z",
          cursor: null,
          review: {
            total: 2,
            reason_counts: [{ reason: "body_size_limit", count: 2 }],
            items: [
              {
                source_record_id: "opaque-message",
                reason: "body_size_limit",
                original_reference:
                  "tend-source:gmail/owner%40example.invalid/opaque-message",
                original_url:
                  "https://mail.google.com/mail/u/?authuser=owner%40example.invalid#all/opaque-message",
              },
            ],
          },
        },
      ],
    });
    mountPrivateWorkspace();
    await vi.advanceTimersByTimeAsync(0);
    const texts = (value: BrowserElement): string =>
      [value.textContent ?? "", ...value.children.map(texts)].join(" ");
    const text = texts(browser.elements.get("history-progress")!);
    expect(text).toContain("18 readable records");
    expect(text).toContain("2 unavailable records");
    expect(text).toContain(
      "pagination finished; content coverage remains partial",
    );
    expect(text).toContain("body size limit: 2");
    expect(text).toContain("opaque-message");
    expect(text).toContain(
      "tend-source:gmail/owner%40example.invalid/opaque-message",
    );
    expect(
      browser.fetch.mock.calls.filter(
        ([path]) => path === "/private/api/history-retry",
      ),
    ).toHaveLength(0);
  });
});

describe("manual history review retry control", () => {
  const held = {
    source: "gmail",
    account_id: "owner@example.invalid",
    status: "paused",
    last_error: "history_page_requires_review",
    page_count: 1,
    record_count: 10,
    watermark: "2026-10-20T10:00:00Z",
    cursor: "saved-page",
  };
  it("does not retry automatically and posts the exact saved account only after the owner clicks", async () => {
    vi.useFakeTimers();
    const browser = browserFixture({ history: [held] });
    mountPrivateWorkspace();
    await vi.advanceTimersByTimeAsync(0);
    const area = browser.elements.get("history-progress")!;
    const button = area.children[0]?.children.find(
      (child) => child.textContent === "Retry this held page",
    );
    expect(button).toBeDefined();
    expect(
      browser.fetch.mock.calls.filter(
        (call) => call[0] === "/private/api/history-retry",
      ),
    ).toHaveLength(0);
    button!.dispatchEvent(new Event("click"));
    await vi.advanceTimersByTimeAsync(0);
    const calls = browser.fetch.mock.calls.filter(
      (call) => call[0] === "/private/api/history-retry",
    );
    expect(calls).toHaveLength(1);
    expect(JSON.parse((calls[0]![1] as RequestInit).body as string)).toEqual({
      source: "gmail",
      account_id: "owner@example.invalid",
      confirm: "RETRY_HELD_HISTORY_PAGE",
    });
    expect((calls[0]![1] as RequestInit).headers).toMatchObject({
      "X-Tend-CSRF": "fictional-csrf",
    });
  });
  it("withdraws import account details and retry controls immediately on lock", async () => {
    vi.useFakeTimers();
    const browser = browserFixture({ history: [held] });
    mountPrivateWorkspace();
    await vi.advanceTimersByTimeAsync(0);
    const area = browser.elements.get("history-progress")!;
    expect(area.children.length).toBe(1);
    browser.elements.get("lock")!.dispatchEvent(new Event("click"));
    expect(area.children).toHaveLength(0);
    expect(browser.elements.get("daily-progress")!.textContent).toBeNull();
    expect(
      browser.fetch.mock.calls.filter(
        (call) => call[0] === "/private/api/history-retry",
      ),
    ).toHaveLength(0);
  });
  it("does not offer clearing quota errors or an active page", async () => {
    vi.useFakeTimers();
    const browser = browserFixture({
      history: [
        { ...held, last_error: "provider_429" },
        { ...held, status: "running" },
      ],
    });
    mountPrivateWorkspace();
    await vi.advanceTimersByTimeAsync(0);
    const area = browser.elements.get("history-progress")!;
    expect(
      area.children
        .flatMap((child) => child.children)
        .some((child) => child.textContent === "Retry this held page"),
    ).toBe(false);
  });
});
