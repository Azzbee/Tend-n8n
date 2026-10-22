import { describe, it, expect } from "vitest";
import vm from "node:vm";
import { readdirSync, readFileSync } from "node:fs";
import {
  buildOutreachWorkflows,
  outreachCanvasNotes,
} from "../src/outreach-workflows.ts";
import { GMAIL_DRAFTS_CREATE_URL } from "../src/outreach-gmail.ts";

const built = buildOutreachWorkflows();
const find = (file: string) => built.find((b) => b.file === file)!.workflow;
const codeOf = (file: string, name: string): string =>
  String(find(file).nodes.find((n) => n.name === name)!.parameters.jsCode);
const run = (code: string, context: Record<string, unknown>): unknown =>
  vm.runInNewContext(`(function(){${code}})()`, context);

describe("outreach workflow exports", () => {
  it("writes the four generated exports exactly as built plus one canvas note, all inactive", () => {
    for (const { file, workflow } of built) {
      const exported = JSON.parse(
        readFileSync(`workflows/${file}`, "utf8"),
      ) as { nodes: { type: string }[] };
      // The export builder adds exactly one canvas sticky note.
      expect(
        exported.nodes.filter((n) => n.type === "n8n-nodes-base.stickyNote"),
      ).toHaveLength(1);
      expect({
        ...exported,
        nodes: exported.nodes.filter(
          (n) => n.type !== "n8n-nodes-base.stickyNote",
        ),
      }).toEqual(JSON.parse(JSON.stringify(workflow)));
      expect(workflow.active).toBe(false);
    }
  });
  it("keeps the private lane on the no-data policy with placeholder credentials", () => {
    for (const file of [
      "25-private-outreach-planner.json",
      "26-private-outreach-gmail-drafts.json",
    ]) {
      const w = find(file);
      expect(w.settings).toMatchObject({
        saveDataSuccessExecution: "none",
        saveDataErrorExecution: "none",
        saveManualExecutions: false,
      });
      expect(w.settings.errorWorkflow).toBe("TendPrivate22");
      expect(
        w.nodes.some((n) => n.type === "n8n-nodes-base.manualTrigger"),
      ).toBe(false);
      for (const n of w.nodes)
        for (const c of Object.values(n.credentials ?? {}))
          expect(c.id.startsWith("CONFIGURE_")).toBe(true);
    }
    for (const file of [
      "23-outreach-planner.json",
      "24-outreach-gmail-drafts.json",
    ]) {
      const raw = readFileSync(`workflows/${file}`, "utf8");
      expect(raw).not.toContain('"credentials"');
      expect(find(file).settings.errorWorkflow).toBe("TendReview21");
    }
  });
  it("reaches Gmail only through drafts.create, never a send endpoint or Gmail node", () => {
    for (const f of readdirSync("workflows").filter((f) =>
      f.endsWith(".json"),
    )) {
      const raw = readFileSync(`workflows/${f}`, "utf8");
      expect(raw).not.toMatch(/messages\/send|drafts\/send|gmail\.send/);
      for (const url of raw.match(/https:\/\/gmail\.googleapis\.com[^"]*/g) ??
        [])
        if (!/^1[1-9]-/.test(f)) expect(url).toBe(GMAIL_DRAFTS_CREATE_URL);
    }
    const create = find("26-private-outreach-gmail-drafts.json").nodes.find(
      (n) => n.name === "Create Gmail draft (drafts.create only)",
    )!;
    expect(create.type).toBe("n8n-nodes-base.httpRequest");
    expect(create.parameters).toMatchObject({
      url: GMAIL_DRAFTS_CREATE_URL,
      method: "POST",
      nodeCredentialType: "gmailOAuth2",
    });
    expect(create.retryOnFail).toBe(false);
    // n8n's gmailOAuth2 defaults include https://mail.google.com/; the bind note must demand custom scopes.
    expect(create.notes).toContain("Define custom scopes");
    expect(create.notes).toContain(
      "exactly https://www.googleapis.com/auth/gmail.compose",
    );
    expect(readFileSync("docs/plans/outreach-status.md", "utf8")).toContain(
      'switch on "Define custom scopes"',
    );
    const mock = find("24-outreach-gmail-drafts.json").nodes.find(
      (n) => n.name === "Create Gmail draft (drafts.create only)",
    )!;
    expect(mock.parameters.url).toBe(
      "http://host.docker.internal:18767/api/mock-gmail/gmail/v1/users/me/drafts",
    );
    for (const { workflow } of built)
      expect(
        workflow.nodes.some((n) => /\.(gmail|telegram)$/.test(n.type)),
      ).toBe(false);
  });
  it("runs hourly in Paris time and never lets n8n approve", () => {
    const planner = find("23-outreach-planner.json");
    expect(planner.settings.timezone).toBe("Europe/Paris");
    expect(planner.nodes[0]!.parameters).toEqual({
      rule: { interval: [{ field: "hours", hoursInterval: 1 }] },
    });
    for (const { workflow } of built)
      expect(JSON.stringify(workflow)).not.toMatch(
        /outreach\/(approve|edit|skip)\b(?!-)/,
      );
  });
});

describe("outreach canvas notes", () => {
  it("describe every outreach workflow ID with purpose, inputs, outputs and privacy", () => {
    expect(Object.keys(outreachCanvasNotes).sort()).toEqual(
      built.map((b) => b.workflow.id).sort(),
    );
    for (const note of Object.values(outreachCanvasNotes))
      for (const field of [
        note.purpose,
        note.inputs,
        note.outputs,
        note.privacy,
      ])
        expect(field.length).toBeGreaterThan(20);
  });
});

describe("outreach workflow code nodes", () => {
  it("splits a plan, keeps the template when the model fails and tells the owner", () => {
    const split = run(
      codeOf("23-outreach-planner.json", "One item per proposal"),
      {
        $input: {
          first: () => ({
            json: {
              created: [
                { id: "Oa", request: { model: "m" }, draft_text: "x" },
                { id: "Ob", request: {} },
              ],
            },
          }),
        },
      },
    ) as { json: { id: string } }[];
    expect(split.map((s) => s.json)).toEqual([
      { id: "Oa", request: { model: "m" } },
      { id: "Ob", request: {} },
    ]);
    const read = run(codeOf("23-outreach-planner.json", "Read model text"), {
      $: () => ({ all: () => split }),
      $input: {
        all: () => [
          { json: { message: { content: '{"text":"Hi Mira, any news?"}' } } },
          { json: { error: { message: "connect ECONNREFUSED" } } },
        ],
      },
    }) as { json: unknown }[];
    expect(read.map((r) => r.json)).toEqual([
      { id: "Oa", text: "Hi Mira, any news?" },
      { id: "Ob", text: null },
    ]);
    const notice = run(codeOf("23-outreach-planner.json", "Owner notice"), {
      $input: { all: () => [{}, {}] },
    }) as { json: { chat_id: string; text: string } }[];
    expect(notice).toHaveLength(1);
    expect(notice[0]!.json.chat_id).toBe("424242");
    expect(
      notice[0]!.json.text.startsWith("Course demo • fictional data"),
    ).toBe(true);
    expect(() =>
      run(codeOf("23-outreach-planner.json", "One item per proposal"), {
        $input: { first: () => ({ json: { error: "x" } }) },
      }),
    ).toThrow(/invalid outreach plan/);
  });
  it("passes only id, approval hash and raw message to Gmail and requires a receipt", () => {
    const file = "24-outreach-gmail-drafts.json";
    const split = run(codeOf(file, "One item per approved draft"), {
      $input: {
        first: () => ({
          json: {
            items: [
              {
                id: "Oa",
                approval_hash: "h",
                message: { raw: "UkFX" },
                extra: "drop",
              },
            ],
          },
        }),
      },
    }) as { json: unknown }[];
    expect(split.map((s) => s.json)).toEqual([
      { id: "Oa", approval_hash: "h", message: { raw: "UkFX" } },
    ]);
    const receipt = run(codeOf(file, "Read draft receipt"), {
      $: () => ({ all: () => split }),
      $input: { all: () => [{ json: { id: "r-1", message: { id: "m" } } }] },
    }) as { json: unknown }[];
    expect(receipt[0]!.json).toEqual({
      id: "Oa",
      approval_hash: "h",
      draft_id: "r-1",
    });
    expect(() =>
      run(codeOf(file, "Read draft receipt"), {
        $: () => ({ all: () => split }),
        $input: { all: () => [{ json: { error: "x" } }] },
      }),
    ).toThrow(/receipt missing/);
  });
});
