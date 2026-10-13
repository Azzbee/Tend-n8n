import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import vm from "node:vm";
interface Node {
  name: string;
  type: string;
  parameters: Record<string, unknown>;
  credentials?: Record<string, { id: string; name: string }>;
  retryOnFail?: boolean;
}
interface Workflow {
  active: boolean;
  settings: {
    saveDataSuccessExecution: string;
    saveDataErrorExecution: string;
  };
  nodes: Node[];
  connections: Record<string, unknown>;
}
const files = [
  "11-google-gmail-readonly.json",
  "12-google-calendar-readonly.json",
  "13-google-normalize-store.json",
  "14-google-telegram-private.json",
  "15-google-extract-commitments.json",
];
const load = (name: string): Workflow =>
  JSON.parse(readFileSync(`workflows/${name}`, "utf8")) as Workflow;
function evaluate(
  code: string,
  input: unknown,
  linked: Record<string, unknown> = {},
): unknown {
  return vm.runInNewContext(`(function(){${code}})()`, {
    $input: { first: () => ({ json: input }), all: () => [{ json: input }] },
    $: (name: string) => ({
      item: { json: linked[name] },
      first: () => ({ json: linked[name] }),
    }),
    Date,
    Buffer,
  });
}
describe("read-only Google workflow contracts", () => {
  it("exports inactive live templates with no saved secret or actual owner settings", () => {
    for (const file of files) {
      const w = load(file);
      expect(w.active).toBe(false);
      expect(w.settings.saveDataSuccessExecution).toBe("none");
      expect(w.settings.saveDataErrorExecution).toBe("none");
      const raw = JSON.stringify(w);
      expect(raw).not.toMatch(
        /adamzeraiki|@gmail\.com|@import\.calendar\.google\.com|"accessToken"|"clientSecret"|"oauthTokenData"|Bearer\s+[A-Za-z0-9._-]+/i,
      );
      for (const n of w.nodes)
        for (const ref of Object.values(n.credentials ?? {}))
          expect(ref.id).toMatch(/^(?:CONFIGURE_|TendReviewLocalOllama$)/);
    }
  });
  it("uses only GET Google operations and verified exact source domains", () => {
    for (const f of files.slice(0, 2)) {
      const w = load(f);
      for (const n of w.nodes) {
        const u = String(n.parameters.url ?? "");
        if (!u.includes("googleapis.com")) continue;
        expect(n.parameters.method).toBe("GET");
        expect(n.parameters.authentication).toBe("predefinedCredentialType");
        expect(u).toMatch(/https:\/\/(?:gmail|www)\.googleapis\.com\//);
        expect(u).not.toMatch(
          /attachments|\/send|\/modify|\/trash|\/insert|\/import|\/move/,
        );
        expect(n.retryOnFail).toBe(false);
      }
    }
  });
  it("uses operator and schedule triggers, bounded pages and native retry wait branches", () => {
    for (const file of files.slice(0, 2)) {
      const w = load(file);
      expect(
        w.nodes.some((n) => n.type === "n8n-nodes-base.manualTrigger"),
      ).toBe(true);
      expect(
        w.nodes.some((n) => n.type === "n8n-nodes-base.scheduleTrigger"),
      ).toBe(true);
      expect(w.nodes.some((n) => n.type === "n8n-nodes-base.wait")).toBe(true);
      expect(
        w.nodes.some((n) =>
          String(n.parameters.jsCode ?? "").includes("retry-after"),
        ),
      ).toBe(true);
      expect(JSON.stringify(w)).toContain("previous_cursor");
      expect(JSON.stringify(w)).toContain("/api/live/sync-error");
    }
  });
  it("rejects a mismatched profile before source listing", () => {
    const w = load(files[0]!);
    const n = w.nodes.find((n) => n.name === "Check Gmail profile")!;
    const result = evaluate(
      String(n.parameters.jsCode),
      {
        statusCode: 200,
        body: { emailAddress: "foreign@example.invalid" },
        headers: {},
      },
      {
        "Prepare Gmail profile": {
          account_email: "owner@example.invalid",
          source: "gmail",
          window_start: "2026-09-14T00:00:00Z",
          window_end: "2026-10-14T00:00:00Z",
          cursor: null,
          profile_account_email: null,
          started_at: Date.now(),
          deadline_at: Date.now() + 60000,
          budget: { max_attempts: 3 },
          attempts: { "Gmail profile": 1 },
        },
      },
    );
    expect(result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          json: expect.objectContaining({
            ok: false,
            profile_account_email: null,
            reconnect_required: true,
          }),
        }),
      ]),
    );
  });
  it("keeps partial storage separate from last-page reconciliation and excludes drafts", () => {
    const g = load(files[0]!);
    expect(JSON.stringify(g)).toContain("-is:draft");
    expect(JSON.stringify(g)).toContain("includeSpamTrash");
    const c = load(files[2]!);
    expect(JSON.stringify(c)).toContain("complete:false");
    expect(JSON.stringify(c)).toContain("reconcile:false");
    expect(JSON.stringify(g)).toContain("next_cursor");
    expect(JSON.stringify(g)).toContain("seen_record_ids");
    expect(JSON.stringify(g)).toContain("records:[]");
  });
  it("runs normalized storage as callable native child and connects live native local AI", () => {
    const child = load(files[2]!);
    expect(child.nodes[0]?.type).toBe("n8n-nodes-base.executeWorkflowTrigger");
    const w = load(files[4]!);
    expect(
      w.nodes.some((n) => n.type === "@n8n/n8n-nodes-langchain.chainLlm"),
    ).toBe(true);
    expect(
      w.nodes.some((n) => n.type === "@n8n/n8n-nodes-langchain.lmChatOllama"),
    ).toBe(true);
    expect(JSON.stringify(w)).toContain("/api/live/model-input");
    expect(JSON.stringify(w)).toContain("/api/live/candidates");
  });
  it("honors anchored DST windows but rejects malformed budget/retry inputs", () => {
    const n = load(files[1]!).nodes.find(
      (n) => n.name === "Validate approved sync window",
    )!;
    const state = {
      source: "calendar",
      account_email: "owner@example.invalid",
      calendar_id: "primary",
      window_start: "2026-10-23T22:00:00Z",
      window_end: "2026-10-30T23:00:00Z",
      cursor: null,
      page_size: 100,
      retry_after_until: null,
      reconnect_required: false,
      budget: {
        max_run_ms: 60000,
        max_attempts: 3,
        max_records_per_run: 100,
        max_page_size: 100,
        max_body_bytes: 262144,
      },
    };
    const run = (x: unknown) =>
      evaluate(String(n.parameters.jsCode), x, {
        "Set sync clock": { started_at: Date.now() },
      });
    expect(() => run(state)).not.toThrow();
    expect(() => run({ ...state, retry_after_until: "broken" })).toThrow();
    expect(() => run({ ...state, page_size: NaN })).toThrow();
    expect(() =>
      run({ ...state, budget: { ...state.budget, max_records_per_run: 0 } }),
    ).toThrow();
    for (const x of [
      { ...state, reconnect_required: true },
      {
        ...state,
        retry_after_until: new Date(Date.now() + 60000).toISOString(),
      },
    ])
      expect(run(x)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            json: expect.objectContaining({ request_allowed: false }),
          }),
        ]),
      );
  });
  it("binds primary alias and selected calendar metadata to the approved account", () => {
    const n = load(files[1]!).nodes.find(
      (n) => n.name === "Check Calendar selected metadata",
    )!;
    const context = {
      account_email: "owner@example.invalid",
      calendar_id: "primary",
      attempts: { "Calendar selected metadata": 1 },
      budget: { max_attempts: 3 },
      deadline_at: Date.now() + 60000,
    };
    const run = (body: unknown) =>
      evaluate(
        String(n.parameters.jsCode),
        { statusCode: 200, body, headers: {} },
        { "Prepare Calendar selected metadata": context },
      );
    expect(
      run({ id: context.account_email, primary: true, accessRole: "owner" }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          json: expect.objectContaining({ ok: true }),
        }),
      ]),
    );
    expect(
      run({
        id: "foreign@example.invalid",
        primary: true,
        accessRole: "owner",
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          json: expect.objectContaining({
            ok: false,
            reconnect_required: true,
          }),
        }),
      ]),
    );
  });
  it("honors numeric and HTTP-date Retry-After without exceeding attempts or time", () => {
    const n = load(files[0]!).nodes.find(
      (n) => n.name === "Check Gmail profile",
    )!;
    const base = {
      account_email: "owner@example.invalid",
      attempts: { "Gmail profile": 1 },
      budget: { max_attempts: 3 },
      deadline_at: Date.now() + 60000,
    };
    const run = (retry: string, ctx = base) =>
      evaluate(
        String(n.parameters.jsCode),
        { statusCode: 429, headers: { "retry-after": retry } },
        { "Prepare Gmail profile": ctx },
      );
    expect(run("2")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          json: expect.objectContaining({
            retry_allowed: true,
            retry_delay_seconds: 2,
          }),
        }),
      ]),
    );
    expect(run(new Date(Date.now() + 10000).toUTCString())).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          json: expect.objectContaining({ retry_allowed: true }),
        }),
      ]),
    );
    expect(run("120")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          json: expect.objectContaining({ retry_allowed: false }),
        }),
      ]),
    );
    expect(run("1", { ...base, attempts: { "Gmail profile": 3 } })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          json: expect.objectContaining({ retry_allowed: false }),
        }),
      ]),
    );
  });
  it("requires full authored-span quotes and rejects partial or fabricated model outputs", () => {
    const n = load(files[4]!).nodes.find(
      (n) => n.name === "Validate exact authored quote",
    )!;
    const span = "I will send the demo by 2026-10-15.";
    const run = (candidate: unknown) =>
      evaluate(String(n.parameters.jsCode), candidate, {
        "Read eligible authored span": {
          record_key: "fictional-key",
          record: { authored_span: span },
        },
      });
    expect(() =>
      run({
        quote: span,
        action: "send the demo",
        suggested_due: "2026-10-15",
      }),
    ).not.toThrow();
    expect(() =>
      run({
        quote: "I will send the demo",
        action: "send the demo",
        suggested_due: null,
      }),
    ).toThrow();
    expect(() =>
      run({ quote: span, action: "send the money", suggested_due: null }),
    ).toThrow();
  });
  it("keeps empty pages and missing child receipts distinct from completion", () => {
    const n = load(files[0]!).nodes.find(
      (n) => n.name === "Acknowledge only the committed complete page",
    )!;
    const context = {
      source: "gmail",
      account_email: "owner@example.invalid",
      profile_account_email: "owner@example.invalid",
      cursor: null,
      next_cursor: "page2",
      provider_records: [],
      deadline_at: Date.now() + 60000,
    };
    const run = (ctx: unknown, input: unknown) =>
      evaluate(String(n.parameters.jsCode), input, {
        "Prepare bounded provider records": { context: ctx },
      });
    expect(run(context, { empty: true })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          json: expect.objectContaining({
            complete: false,
            reconcile: false,
            cursor: "page2",
          }),
        }),
      ]),
    );
    expect(run({ ...context, next_cursor: null }, { empty: true })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          json: expect.objectContaining({ complete: true, reconcile: true }),
        }),
      ]),
    );
    expect(() =>
      run(
        { ...context, provider_records: [{ id: "m1" }, { id: "m2" }] },
        { source_record_id: "m1", committed: true },
      ),
    ).toThrow();
    expect(() =>
      run({ ...context, deadline_at: Date.now() }, { empty: true }),
    ).toThrow();
  });
  it("defers quota403 without mistaking it for revoked authorization", () => {
    const n = load(files[0]!).nodes.find(
      (n) => n.name === "Check Gmail profile",
    )!;
    const result = evaluate(
      String(n.parameters.jsCode),
      {
        statusCode: 403,
        headers: {},
        body: { error: { errors: [{ reason: "userRateLimitExceeded" }] } },
      },
      {
        "Prepare Gmail profile": {
          attempts: { "Gmail profile": 1 },
          budget: { max_attempts: 3 },
          deadline_at: Date.now() + 60000,
        },
      },
    );
    expect(result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          json: expect.objectContaining({
            retry_allowed: true,
            reconnect_required: false,
          }),
        }),
      ]),
    );
  });
  it("defers a detail batch whose worst-case duration exceeds the run budget", () => {
    const n = load(files[0]!).nodes.find(
      (n) => n.name === "Choose message details or empty page",
    )!;
    const result = evaluate(String(n.parameters.jsCode), {
      message_refs: Array.from({ length: 20 }, (_, i) => ({ id: `m${i}` })),
      deadline_at: Date.now() + 10000,
    });
    expect(result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          json: expect.objectContaining({
            details_allowed: false,
            status_code: 599,
          }),
        }),
      ]),
    );
  });
});
