import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import vm from "node:vm";
interface Node {
  name: string;
  type: string;
  parameters: Record<string, unknown>;
  credentials?: Record<string, { id: string; name: string }>;
  retryOnFail?: boolean;
  maxTries?: number;
  waitBetweenTries?: number;
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
  allInput: unknown[] = [input],
): unknown {
  return vm.runInNewContext(`(function(){${code}})()`, {
    $input: {
      first: () => ({ json: input }),
      all: () => allInput.map((json) => ({ json })),
    },
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
  it.each(["gmail", "calendar"])(
    "bounds the complete %s storage envelope and sends the measured body unchanged",
    (source) => {
      const w = load(files[source === "gmail" ? 0 : 1]!);
      const fan = w.nodes.find(
        (n) => n.name === "Prepare bounded provider records",
      )!;
      const child = load(files[2]!);
      const check = child.nodes.find(
        (n) => n.name === "Validate approved raw input",
      )!;
      const request = child.nodes.find(
        (n) => n.name === "Normalize and commit approved record",
      )!;
      const limit = 262144;
      const context = {
        source,
        account_email: "owner@example.invalid",
        profile_account_email: "owner@example.invalid",
        ...(source === "calendar"
          ? { calendar_id: "fictional-calendar@example.invalid" }
          : {}),
        cursor: '"\\'.repeat(1000),
        window_start: "2026-09-14T12:00:00.000Z",
        window_end: "2026-10-14T12:00:00.000Z",
        deadline_at: Date.now() + 60000,
        page_size: 20,
        budget: { max_body_bytes: limit, max_attempts: 3 },
      };
      const envelope = (record: { id: string; payload?: string }) => ({
        source,
        account_email: context.account_email,
        profile_account_email: context.profile_account_email,
        ...("calendar_id" in context
          ? { calendar_id: context.calendar_id }
          : {}),
        records: [record],
        previous_cursor: context.cursor,
        cursor: context.cursor,
        complete: false,
        reconcile: false,
        window_start: context.window_start,
        window_end: context.window_end,
        seen_record_ids: [record.id],
      });
      const base = { id: "fictional-record", payload: '"\\你好' };
      const overhead = Buffer.byteLength(JSON.stringify(envelope(base)));
      const exact = {
        ...base,
        payload: base.payload + "x".repeat(limit - overhead),
      };
      const oversized = { ...exact, payload: exact.payload + "x" };
      const run = (record: typeof exact) => {
        const [item] = evaluate(String(fan.parameters.jsCode), {
          ...context,
          provider_records: [record],
        }) as {
          json: { context: unknown; record: unknown; storage_body: string };
        }[];
        return item!.json;
      };
      const bounded = run(exact);
      expect(bounded.record).toEqual(exact);
      expect(Buffer.byteLength(bounded.storage_body)).toBe(limit);
      expect(bounded.storage_body).toBe(JSON.stringify(envelope(exact)));
      expect(() =>
        evaluate(String(check.parameters.jsCode), bounded),
      ).not.toThrow();
      const bodyExpression = String(request.parameters.body)
        .slice(3, -3)
        .replaceAll("$json", "$input.first().json");
      expect(evaluate(`return ${bodyExpression};`, bounded)).toBe(
        bounded.storage_body,
      );
      const rawAtLimit = {
        ...base,
        payload:
          base.payload +
          "x".repeat(limit - Buffer.byteLength(JSON.stringify(base))),
      };
      expect(Buffer.byteLength(JSON.stringify(rawAtLimit))).toBe(limit);
      expect(run(rawAtLimit).record).toEqual({ id: base.id, oversized: true });
      const sentinel = run(oversized);
      expect(sentinel.record).toEqual({ id: exact.id, oversized: true });
      expect(Buffer.byteLength(sentinel.storage_body)).toBeLessThan(limit);
      expect(JSON.parse(sentinel.storage_body).records).toEqual([
        sentinel.record,
      ]);
      expect(() =>
        evaluate(String(check.parameters.jsCode), sentinel),
      ).not.toThrow();
      expect(() =>
        evaluate(String(check.parameters.jsCode), {
          ...bounded,
          storage_body: bounded.storage_body.replace(
            '"complete":false',
            '"complete":true',
          ),
        }),
      ).toThrow();
      expect(() =>
        evaluate(String(check.parameters.jsCode), {
          ...bounded,
          storage_body: undefined,
        }),
      ).toThrow();
      expect(() =>
        evaluate(String(fan.parameters.jsCode), {
          ...context,
          budget: { max_body_bytes: 1 },
          provider_records: [oversized],
        }),
      ).toThrow();
    },
  );
  it.each(["gmail", "calendar"])(
    "keeps %s child payloads linear and matches every expected page receipt",
    (source) => {
      const workflow = load(files[source === "gmail" ? 0 : 1]!);
      const fan = workflow.nodes.find(
        (n) => n.name === "Prepare bounded provider records",
      )!;
      const collector = workflow.nodes.find(
        (n) => n.name === "Acknowledge only the committed complete page",
      )!;
      const records = Array.from({ length: 20 }, (_, i) => ({
        id: `fictional-${i}`,
        payload: "x".repeat(10000),
      }));
      const context = {
        source,
        account_email: "owner@example.invalid",
        profile_account_email: "owner@example.invalid",
        ...(source === "calendar" ? { calendar_id: "fictional-calendar" } : {}),
        cursor: null,
        next_cursor: "fictional-next",
        window_start: "2026-09-14T12:00:00.000Z",
        window_end: "2026-10-14T12:00:00.000Z",
        deadline_at: Date.now() + 60000,
        page_size: 20,
        budget: { max_body_bytes: 262144, max_attempts: 3 },
        message_refs: records.map(({ id }) => ({ id })),
        provider_records: records,
      };
      const items = evaluate(String(fan.parameters.jsCode), context) as {
        json: {
          context: Record<string, unknown>;
          record: { id: string };
          storage_body: string;
        };
      }[];
      expect(items).toHaveLength(20);
      expect(Buffer.byteLength(JSON.stringify(items))).toBeLessThan(
        Buffer.byteLength(JSON.stringify(records)) * 3,
      );
      for (const { json } of items) {
        expect(json.context).not.toHaveProperty("provider_records");
        expect(json.context).not.toHaveProperty("message_refs");
        expect(json.context.expected_record_ids).toEqual(
          records.map(({ id }) => id),
        );
        expect(JSON.parse(json.storage_body).records).toEqual([json.record]);
      }
      const receipts = items.map(({ json }) => ({
        context: json.context,
        source_record_id: json.record.id,
        committed: true,
      }));
      const collect = (input: unknown[]) =>
        evaluate(
          String(collector.parameters.jsCode),
          input[0],
          {
            "Prepare bounded provider records": items[0]!.json,
          },
          input,
        );
      expect(collect(receipts)).toEqual([
        {
          json: expect.objectContaining({
            cursor: context.next_cursor,
            seen_record_ids: records.map(({ id }) => id),
            complete: false,
            reconcile: false,
          }),
        },
      ]);
      expect(() => collect(receipts.slice(1))).toThrow();
      expect(() => collect([...receipts.slice(1), receipts[1]])).toThrow();
      expect(() =>
        collect([{ ...receipts[0], committed: false }, ...receipts.slice(1)]),
      ).toThrow();
    },
  );
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
      expected_record_ids: [],
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
        { ...context, expected_record_ids: ["m1", "m2"] },
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
  it("retries only local record storage within the approved attempt and deadline budgets", () => {
    const child = load(files[2]!);
    const retry = child.nodes.find(
      (n) => n.name === "Normalize and commit approved record",
    )!;
    const once = child.nodes.find(
      (n) => n.name === "Normalize and commit approved record once",
    )!;
    expect(retry.retryOnFail).toBe(true);
    expect(retry.maxTries).toBe(2);
    expect(retry.waitBetweenTries).toBe(1000);
    expect(once.retryOnFail).toBe(false);
    const timeout = (retry.parameters.options as { timeout: number }).timeout;
    expect(timeout).toBe(5000);
    expect((once.parameters.options as { timeout: number }).timeout).toBe(
      timeout,
    );
    const check = child.nodes.find(
      (n) => n.name === "Validate approved raw input",
    )!;
    const fan = load(files[0]!).nodes.find(
      (n) => n.name === "Prepare bounded provider records",
    )!;
    for (const max_attempts of [1, 2, 3, 5]) {
      const attempts = Math.min(max_attempts, retry.maxTries!);
      const reserve =
        timeout * attempts + retry.waitBetweenTries! * (attempts - 1);
      const context = {
        source: "gmail",
        account_email: "owner@example.invalid",
        profile_account_email: "owner@example.invalid",
        cursor: null,
        window_start: "2026-09-14T12:00:00Z",
        window_end: "2026-10-14T12:00:00Z",
        deadline_at: reserve,
        page_size: 1,
        budget: { max_attempts, max_body_bytes: 262144 },
        provider_records: [{ id: "fictional-record" }],
      };
      const [item] = evaluate(String(fan.parameters.jsCode), context) as {
        json: Record<string, unknown>;
      }[];
      const run = (
        deadline_at: number,
        budget: Record<string, unknown> = context.budget,
      ) =>
        vm.runInNewContext(
          `(function(){${String(check.parameters.jsCode)}})()`,
          {
            $input: {
              first: () => ({
                json: {
                  ...item!.json,
                  context: { ...context, deadline_at, budget },
                },
              }),
            },
            Date: { now: () => 0 },
            Buffer,
          },
        ) as { json: { storage_retry_allowed: boolean } }[];
      expect(run(reserve)[0]!.json.storage_retry_allowed).toBe(
        max_attempts > 1,
      );
      expect(() => run(reserve - 1)).toThrow("storage budget exhausted");
      for (const budget of [
        {},
        { max_attempts: 0 },
        { max_attempts: 6 },
        { max_attempts: 1.5 },
      ]) {
        expect(() => run(reserve, budget)).toThrow(
          "invalid storage attempt budget",
        );
      }
    }
    const connections = child.connections as Record<
      string,
      { main: { node: string }[][] }
    >;
    const branch =
      connections["Storage retry allowed by approved budget"]!.main;
    expect(branch[0]!.map((x) => x.node)).toEqual([retry.name]);
    expect(branch[1]!.map((x) => x.node)).toEqual([once.name]);
    for (const node of [retry, once])
      expect(connections[node.name]!.main[0]!.map((x) => x.node)).toEqual([
        "Return committed page context",
      ]);
    for (const file of files) {
      for (const node of load(file).nodes) {
        if (
          (file !== files[2] || node.name !== retry.name) &&
          node.name !== "Record Telegram send acknowledgement"
        )
          expect(node.retryOnFail).not.toBe(true);
      }
    }
  });
  it("paces full Gmail reads to two launches per second within the existing run and acknowledgement budget", () => {
    const workflow = load(files[0]!);
    const request = workflow.nodes.find(
      (n) => n.name === "Read Gmail full messages",
    )!;
    const preflight = workflow.nodes.find(
      (n) => n.name === "Choose message details or empty page",
    )!;
    const options = request.parameters.options as {
      timeout: number;
      batching: { batch: { batchSize: number; batchInterval: number } };
    };
    const { batchSize, batchInterval } = options.batching.batch;
    expect(Number.isSafeInteger(batchSize) && batchSize > 0).toBe(true);
    expect(Number.isSafeInteger(batchInterval) && batchInterval > 0).toBe(true);
    const launches = Array.from(
      { length: 20 },
      (_, i) => Math.floor(i / batchSize) * batchInterval,
    );
    for (const start of launches) {
      expect(
        launches.filter((time) => time >= start && time < start + 1000).length,
      ).toBeLessThanOrEqual(2);
    }
    expect(options.timeout).toBe(5000);
    const storage = load(files[2]!).nodes.find(
      (n) => n.name === "Normalize and commit approved record",
    )!;
    const storageTimeout = (storage.parameters.options as { timeout: number })
      .timeout;
    const allowed = (remaining: number, max_attempts: number) =>
      vm.runInNewContext(
        `(function(){${String(preflight.parameters.jsCode)}})()`,
        {
          $input: {
            first: () => ({
              json: {
                message_refs: Array.from({ length: 20 }, (_, i) => ({
                  id: `fictional-${i}`,
                })),
                deadline_at: remaining,
                budget: { max_attempts },
              },
            }),
          },
          Date: { now: () => 0 },
        },
      ) as { json: { details_allowed: boolean; status_code: number } }[];
    for (const max_attempts of [1, 2, 3, 5]) {
      const attempts = Math.min(max_attempts, storage.maxTries!);
      const reserve =
        storageTimeout * attempts + storage.waitBetweenTries! * (attempts - 1);
      const required = launches.at(-1)! + options.timeout + reserve;
      expect(required).toBeLessThanOrEqual(60000);
      expect(allowed(required, max_attempts)[0]!.json.details_allowed).toBe(
        true,
      );
      expect(allowed(required - 1, max_attempts)[0]!.json).toEqual(
        expect.objectContaining({
          details_allowed: false,
          status_code: 599,
        }),
      );
      expect(allowed(60000, max_attempts)[0]!.json.details_allowed).toBe(true);
    }
  });
  it("defers a detail batch whose worst-case duration exceeds the run budget", () => {
    const n = load(files[0]!).nodes.find(
      (n) => n.name === "Choose message details or empty page",
    )!;
    const result = evaluate(String(n.parameters.jsCode), {
      message_refs: Array.from({ length: 20 }, (_, i) => ({ id: `m${i}` })),
      deadline_at: Date.now() + 10000,
      budget: { max_attempts: 3 },
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
it.each(files.slice(0, 2))(
  "executes the whole history-page branch for %s",
  (file) => {
    const w = load(file),
      n = w.nodes.find((n) => n.name === "Bound whole history page")!;
    const context = {
      lane: "history",
      history_version: 1,
      watermark: "2026-10-20T10:00:00.000Z",
      source: file.startsWith("11") ? "gmail" : "calendar",
      account_email: "owner@example.invalid",
      profile_account_email: "owner@example.invalid",
      calendar_id: "primary",
      cursor: null,
      next_cursor: "page2",
      window_start: "0001-01-01T00:00:00.000Z",
      window_end: "2026-10-20T10:00:00.000Z",
      budget: { max_body_bytes: 262144 },
      provider_records: [{ id: "old-record" }],
    };
    const result = evaluate(String(n.parameters.jsCode), context) as {
      json: Record<string, unknown>;
    }[];
    expect(result[0]?.json).toMatchObject({
      lane: "history",
      records: [{ id: "old-record" }],
      previous_cursor: null,
      cursor: "page2",
      complete: false,
    });
  },
);
it("splits large history pages without changing or truncating source records", () => {
  const w = load(files[0]!),
    n = w.nodes.find((n) => n.name === "Bound whole history page")!;
  const records = [
    { id: "one", body: "x".repeat(80000) },
    { id: "two", body: "y".repeat(80000) },
  ];
  const context = {
    lane: "history",
    history_version: 1,
    watermark: "2026-10-20T10:00:00.000Z",
    source: "gmail",
    account_email: "owner@example.invalid",
    profile_account_email: "owner@example.invalid",
    cursor: "page1",
    next_cursor: "page2",
    window_start: "0001-01-01T00:00:00.000Z",
    window_end: "2026-10-20T10:00:00.000Z",
    budget: { max_body_bytes: 100000 },
    provider_records: records,
  };
  const result = evaluate(String(n.parameters.jsCode), context) as {
    json: Record<string, unknown>;
  }[];
  expect(result).toHaveLength(2);
  expect(result[0]?.json).toMatchObject({
    advance: false,
    cursor: "page1",
    complete: false,
    records: [records[0]],
  });
  expect(result[1]?.json).toMatchObject({
    advance: true,
    cursor: "page2",
    complete: false,
    records: [records[1]],
  });
  for (const item of result)
    expect(Buffer.byteLength(JSON.stringify(item.json))).toBeLessThanOrEqual(
      100000,
    );
});
