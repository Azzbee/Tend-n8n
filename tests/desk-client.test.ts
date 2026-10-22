import { afterEach, describe, expect, it, vi } from "vitest";
import { mountPrivateWorkspace } from "../src/private-web-client.ts";
import {
  dueLabel,
  emailApproval,
  itemMeta,
  seenOn,
  sendingLine,
  viewFromHash,
} from "../src/desk-client.ts";
import {
  buildDeskRuns,
  buildDeskSnapshot,
  deskHeadline,
  deskItemTitle,
  type DeskSnapshot,
} from "../src/desk-model.ts";
import {
  createDeskFixtureStore,
  deskFixtureClock,
  deskFixtureFailures,
  deskFixtureOutreach,
} from "../src/desk-fixture.ts";

class FakeElement extends EventTarget {
  hidden = false;
  disabled = false;
  value = "";
  textContent: string | null = null;
  className = "";
  dataset: Record<string, string> = {};
  children: FakeElement[] = [];
  focused = false;
  append(...children: FakeElement[]): void {
    this.children.push(...children);
  }
  prepend(...children: FakeElement[]): void {
    this.children.unshift(...children);
  }
  replaceChildren(...children: FakeElement[]): void {
    this.children = children;
    this.textContent = null;
  }
  replaceWith(): void {}
  querySelector(): null {
    return null;
  }
  querySelectorAll(): FakeElement[] {
    return all(this, () => true);
  }
  setAttribute(): void {}
  removeAttribute(): void {}
  getContext(): null {
    return null;
  }
  focus(): void {
    this.focused = true;
  }
  scrollIntoView(): void {}
}
function all(
  root: FakeElement,
  match: (e: FakeElement) => boolean,
): FakeElement[] {
  return root.children.flatMap((child) => [
    ...(match(child) ? [child] : []),
    ...all(child, match),
  ]);
}
const text = (root: FakeElement): string =>
  [root.textContent ?? "", ...root.children.map(text)].join(" ");
function snapshot(): DeskSnapshot {
  const store = createDeskFixtureStore();
  try {
    const owner = "fictional-owner";
    return buildDeskSnapshot({
      commitments: store.commitments(owner),
      records: store.interactions(owner),
      contacts: store.contacts(owner),
      sources: store.sourceStatus(owner),
      now: deskFixtureClock(),
      failures: deskFixtureFailures,
    });
  } finally {
    store.close();
  }
}
function browser(
  hash: string,
  outreach: "off" | "on" | "approved" | "approved-off" | "unconfirmed" = "off",
) {
  const elements = new Map<string, FakeElement>();
  let releaseConfirm: () => void = () => {};
  const element = (id: string): FakeElement => {
    let value = elements.get(id);
    if (!value) elements.set(id, (value = new FakeElement()));
    return value;
  };
  const document = Object.assign(new EventTarget(), {
    hidden: false,
    getElementById: element,
    createElement: (): FakeElement => new FakeElement(),
    querySelectorAll: (): FakeElement[] => [],
  });
  const window = Object.assign(new EventTarget(), { location: { hash } });
  const fetch = vi.fn(
    async (path: string, init?: RequestInit): Promise<Response> => {
      if (path === "/private/api/session")
        return Response.json({
          unlocked: true,
          csrf: "fictional-csrf",
          expires_at: new Date(Date.now() + 30 * 60000).toISOString(),
        });
      if (path === "/private/api/progress")
        return Response.json({ history: [], daily: { enabled: false } });
      if (path.startsWith("/private/api/contacts"))
        return Response.json({ contacts: [], next_cursor: null });
      if (path === "/private/api/desk") return Response.json(snapshot());
      if (path === "/private/api/runs")
        return Response.json(buildDeskRuns(null, deskFixtureFailures));
      if (path === "/private/api/outreach")
        return outreach === "on"
          ? Response.json({ items: deskFixtureOutreach(deskFixtureClock()) })
          : outreach === "approved-off"
            ? Response.json({
                sending_enabled: false,
                items: deskFixtureOutreach(deskFixtureClock()).map((i) => ({
                  ...i,
                  status: "approved",
                })),
              })
            : outreach === "unconfirmed"
              ? Response.json({
                  sending_enabled: true,
                  items: deskFixtureOutreach(deskFixtureClock()).map((i) => ({
                    ...i,
                    status: "approved",
                    gmail_unconfirmed: true,
                  })),
                })
              : outreach === "approved"
                ? Response.json({
                    items: deskFixtureOutreach(deskFixtureClock()).map((i) => ({
                      ...i,
                      status: "approved",
                    })),
                  })
                : Response.json(
                    { error: "Unknown private route" },
                    { status: 404 },
                  );
      if (path === "/private/api/desk/confirm" && init?.method === "POST")
        return new Promise<Response>((resolve) => {
          releaseConfirm = () => resolve(Response.json({ commitment: {} }));
        });
      return Response.json({});
    },
  );
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", window);
  vi.stubGlobal("BroadcastChannel", undefined);
  vi.stubGlobal("fetch", fetch);
  return { elements, fetch, release: () => releaseConfirm() };
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("desk presentation helpers", () => {
  it("routes unknown hashes to the desk and #outreach to the desk queue", () => {
    expect(viewFromHash("")).toBe("desk");
    expect(viewFromHash("#runs")).toBe("runs");
    expect(viewFromHash("#review")).toBe("review");
    expect(viewFromHash("#outreach")).toBe("desk");
    expect(viewFromHash("#../../etc")).toBe("desk");
  });
  it("words the headline, titles and metadata from the snapshot", () => {
    const desk = snapshot();
    expect(deskHeadline(desk)).toBe(
      "Two promises in motion. One waits for your yes.",
    );
    expect(deskHeadline({ you_owe: [], owed_to_you: [], pending: [] })).toBe(
      "No promises in motion. Your review is clear.",
    );
    expect(deskItemTitle(desk.you_owe[0]!)).toBe("You: Review your demo");
    expect(deskItemTitle(desk.owed_to_you[0]!)).toBe("Mira Tan: Send the demo");
    expect(itemMeta(desk.pending[0]!)).toMatch(
      /^WhatsApp personal · Mira Tan wrote · Tue 13 Oct.* · wp2$/,
    );
    expect(dueLabel("2026-10-16")).toBe("Due Fri 16 Oct");
    expect(dueLabel(null)).toBe("No due date");
    expect(dueLabel("2026-10-15", "2026-10-22")).toBe(
      "Overdue · Due Thu 15 Oct",
    );
    expect(dueLabel("2026-10-30", "2026-10-22")).toBe("Due Fri 30 Oct");
  });
});

describe("outreach sending copy", () => {
  it("never promises a Gmail draft unless sending is on", () => {
    expect(emailApproval(true).notice).toContain("creates a Gmail draft");
    expect(emailApproval(false).notice).toContain(
      "nothing will be drafted in Gmail",
    );
    expect(emailApproval(null).notice).toContain(
      "only while sending is switched on",
    );
    expect(sendingLine(false)).toContain("switched off");
    expect(sendingLine(null)).toBeNull();
  });
  it("shows the switched-off state and lets the owner copy an approved email", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(deskFixtureClock());
    const { elements } = browser("#desk", "approved-off");
    mountPrivateWorkspace();
    await vi.advanceTimersByTimeAsync(0);
    const queue = elements.get("desk-outreach")!;
    expect(text(queue)).toContain(
      "Sending is switched off: approvals never create Gmail drafts.",
    );
    expect(text(queue)).toContain("nothing will be drafted in Gmail");
    expect(text(queue)).not.toContain("Waiting for the Gmail step");
    expect(all(queue, (e) => e.textContent === "Copy text")).toHaveLength(2);
  });
});

describe("mounted desk", () => {
  it("shows a promise thread as one card and links or splits a sighting from it", async () => {
    vi.useFakeTimers();
    const { elements, fetch, release } = browser("#desk");
    mountPrivateWorkspace();
    await vi.advanceTimersByTimeAsync(0);
    const owed = elements.get("desk-owed")!;
    expect(owed.children).toHaveLength(1);
    expect(text(owed)).toContain("Seen on Email and LinkedIn");
    expect(text(owed)).toContain("NOT LINKED YET");
    expect(text(owed)).toContain("tend-source:linkedin/fixture-linkedin/li1");
    const thread = snapshot().owed_to_you[0]!;
    const li1 = thread.sources[1]!.commitment_id;
    all(owed, (e) => e.textContent === "Confirm and link")[0]!.dispatchEvent(
      new Event("click"),
    );
    await vi.advanceTimersByTimeAsync(0);
    release();
    await vi.advanceTimersByTimeAsync(0);
    const body = (path: string): unknown =>
      JSON.parse(
        String(
          (fetch.mock.calls.find(([p]) => p === path)![1] as RequestInit).body,
        ),
      );
    expect(body("/private/api/desk/confirm")).toEqual({
      id: li1,
      due_date: "2026-10-15",
    });
    all(
      elements.get("desk-owed")!,
      (e) => e.textContent === "Not the same ask",
    )[0]!.dispatchEvent(new Event("click"));
    await vi.advanceTimersByTimeAsync(0);
    expect(body("/private/api/desk/separate")).toEqual({ id: li1 });
    expect(elements.get("notice")!.textContent).toContain(
      "will not link these two again",
    );
    expect(seenOn({ sources: thread.sources.slice(0, 1) })).toBeNull();
    expect(
      seenOn({
        sources: [
          thread.sources[0]!,
          { ...thread.sources[0]!, commitment_id: "x" },
        ],
      }),
    ).toBe("Seen 2 times on Email");
  });
  it("renders the desk, says outreach is not enabled on 404, and wipes every desk container on lock", async () => {
    vi.useFakeTimers();
    const { elements } = browser("#desk");
    mountPrivateWorkspace();
    await vi.advanceTimersByTimeAsync(0);
    expect(elements.get("desk-view")!.hidden).toBe(false);
    expect(elements.get("people-view")!.hidden).toBe(true);
    expect(elements.get("desk-headline")!.textContent).toBe(
      "Two promises in motion. One waits for your yes.",
    );
    expect(elements.get("desk-owe")!.children).toHaveLength(1);
    expect(text(elements.get("desk-yes")!)).toContain(
      "I will share the pilot checklist by 2026-10-20.",
    );
    expect(text(elements.get("desk-owed")!)).toContain(
      "Seen on Email and LinkedIn",
    );
    expect(text(elements.get("desk-held")!)).toContain("g-injection");
    expect(text(elements.get("desk-meeting")!)).toContain(
      "Demo review with Mira Tan",
    );
    expect(text(elements.get("desk-outreach")!)).toContain(
      "Outreach is not enabled.",
    );
    expect(text(elements.get("desk-pipeline")!)).toContain("1 failure logged");
    elements.get("lock")!.dispatchEvent(new Event("click"));
    for (const id of [
      "desk-owe",
      "desk-owed",
      "desk-yes",
      "desk-not",
      "desk-held",
      "desk-meeting",
      "desk-outreach",
      "desk-pipeline",
      "desk-coverage",
    ])
      expect(elements.get(id)!.children).toHaveLength(0);
    expect(elements.get("desk-view")!.hidden).toBe(true);
  });
  it("confirms a pending promise with the shown date and the session CSRF header", async () => {
    vi.useFakeTimers();
    const { elements, fetch, release: browserRelease } = browser("#desk");
    mountPrivateWorkspace();
    await vi.advanceTimersByTimeAsync(0);
    const confirm = all(
      elements.get("desk-yes")!,
      (e) => e.textContent === "Confirm",
    )[0]!;
    expect(confirm.disabled).toBe(false);
    confirm.dispatchEvent(new Event("click"));
    await vi.advanceTimersByTimeAsync(0);
    browserRelease();
    await vi.advanceTimersByTimeAsync(0);
    const call = fetch.mock.calls.find(
      ([path]) => path === "/private/api/desk/confirm",
    )!;
    const init = call[1] as RequestInit & { headers: Record<string, string> };
    expect(init.headers["X-Tend-CSRF"]).toBe("fictional-csrf");
    expect(JSON.parse(String(init.body))).toEqual({
      id: snapshot().pending[0]!.commitment_id,
      due_date: "2026-10-20",
    });
    expect(elements.get("notice")!.textContent).toContain("Nothing was sent");
  });
  it("never renders private text again when the workspace locks during an action", async () => {
    vi.useFakeTimers();
    const { elements, fetch, release } = browser("#desk");
    mountPrivateWorkspace();
    await vi.advanceTimersByTimeAsync(0);
    all(
      elements.get("desk-yes")!,
      (e) => e.textContent === "Confirm",
    )[0]!.dispatchEvent(new Event("click"));
    await vi.advanceTimersByTimeAsync(0);
    elements.get("lock")!.dispatchEvent(new Event("click"));
    release();
    await vi.advanceTimersByTimeAsync(0);
    for (const id of [
      "desk-yes",
      "desk-owe",
      "desk-held",
      "desk-meeting",
      "desk-outreach",
    ])
      expect(text(elements.get(id)!).trim()).toBe("");
    expect(elements.get("yes-title")!.textContent).toBe("WAITING FOR YOUR YES");
    const after = fetch.mock.calls.map(([path]) => path);
    expect(after.slice(after.indexOf("/private/api/logout"))).not.toContain(
      "/private/api/desk",
    );
  });
  it("tells the owner when Gmail never confirmed an approved email draft", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(deskFixtureClock());
    const { elements } = browser("#desk", "unconfirmed");
    mountPrivateWorkspace();
    await vi.advanceTimersByTimeAsync(0);
    const queue = text(elements.get("desk-outreach")!);
    expect(queue).toContain("Gmail did not confirm this draft.");
    expect(queue).not.toContain("Waiting for the Gmail step");
  });
  it("asks for a second click before withdrawing an approved draft", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(deskFixtureClock());
    const { elements, fetch } = browser("#desk", "approved");
    mountPrivateWorkspace();
    await vi.advanceTimersByTimeAsync(0);
    const withdraw = all(
      elements.get("desk-outreach")!,
      (e) => e.textContent === "Withdraw approval",
    )[0]!;
    withdraw.dispatchEvent(new Event("click"));
    await vi.advanceTimersByTimeAsync(0);
    expect(withdraw.textContent).toBe("Confirm withdraw");
    expect(
      fetch.mock.calls.some(([p]) => p === "/private/api/outreach/skip"),
    ).toBe(false);
    withdraw.dispatchEvent(new Event("click"));
    await vi.advanceTimersByTimeAsync(0);
    expect(
      fetch.mock.calls.some(([p]) => p === "/private/api/outreach/skip"),
    ).toBe(true);
  });
  it("shows the outreach queue with approve, edit and skip only for live pending drafts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(deskFixtureClock());
    const { elements, fetch } = browser("#desk", "on");
    mountPrivateWorkspace();
    await vi.advanceTimersByTimeAsync(0);
    const queue = elements.get("desk-outreach")!;
    all(
      queue,
      (e) => e.textContent === "Approve this message",
    )[0]!.dispatchEvent(new Event("click"));
    await vi.advanceTimersByTimeAsync(0);
    const approveCall = fetch.mock.calls.find(
      ([p]) => p === "/private/api/outreach/approve",
    )!;
    const shown = deskFixtureOutreach(deskFixtureClock())[0]!;
    // The Desk approves the exact text it rendered, identified by its code.
    expect(JSON.parse(String((approveCall[1] as RequestInit).body))).toEqual({
      id: shown.id,
      text_code: shown.text_code,
    });
    expect(queue.children).toHaveLength(2);
    expect(text(queue)).toContain(
      "Hi Mira, could you share an update on the demo? Thanks.",
    );
    expect(
      all(queue, (e) => e.textContent === "Approve this message"),
    ).toHaveLength(2);
    vi.unstubAllGlobals();
    const approved = browser("#desk", "approved");
    mountPrivateWorkspace();
    await vi.advanceTimersByTimeAsync(0);
    const done = approved.elements.get("desk-outreach")!;
    expect(
      all(done, (e) => e.textContent === "Approve this message"),
    ).toHaveLength(0);
    expect(
      all(done, (e) => e.textContent === "Withdraw approval"),
    ).toHaveLength(2);
    expect(all(done, (e) => e.textContent === "Copy text")).toHaveLength(1);
    expect(text(done)).toContain("Approval ends Wed 14 Oct");
  });
  it("reviews pending promises one at a time and shows the failure log on How it runs", async () => {
    vi.useFakeTimers();
    const review = browser("#review");
    mountPrivateWorkspace();
    await vi.advanceTimersByTimeAsync(0);
    expect(review.elements.get("review-progress")!.textContent).toBe("1 of 1");
    expect(text(review.elements.get("review-card")!)).toContain(
      "Mira Tan, to you",
    );
    expect(review.elements.get("review-title")!.focused).toBe(true);
    vi.unstubAllGlobals();
    const runs = browser("#runs");
    mountPrivateWorkspace();
    await vi.advanceTimersByTimeAsync(0);
    expect(runs.elements.get("runs-classroom")!.children).toHaveLength(12);
    expect(runs.elements.get("runs-private")!.children).toHaveLength(14);
    expect(text(runs.elements.get("runs-failures")!)).toContain(
      "Prepare local AI request",
    );
    const links = all(
      runs.elements.get("runs-failures")!,
      (e) => "href" in e,
    ) as (FakeElement & { href: string; rel: string })[];
    expect(links.map((l) => [l.href, l.rel, l.textContent])).toEqual([
      [deskFixtureFailures[0]!.execution_url, "noreferrer", "4"],
    ]);
  });
});
