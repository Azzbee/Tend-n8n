import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import vm from "node:vm";
import { fixtureRecords, demoAuth } from "../src/fixtures.ts";
interface Node {
  name: string;
  type: string;
  parameters: Record<string, unknown>;
}
interface Workflow {
  active: boolean;
  nodes: Node[];
  connections: Record<string, unknown>;
}
const load = (n: string): Workflow =>
  JSON.parse(readFileSync(`workflows/${n}`, "utf8")) as Workflow;
describe("import and node boundaries", () => {
  it("connects native LLM Chain to a local keyless Ollama model", () => {
    const w = load("07-extract-commitments.json");
    expect(
      w.nodes.some((n) => n.type === "@n8n/n8n-nodes-langchain.chainLlm"),
    ).toBe(true);
    expect(
      w.nodes.some((n) => n.type === "@n8n/n8n-nodes-langchain.lmChatOllama"),
    ).toBe(true);
    const local: unknown = JSON.parse(
      readFileSync("fixtures/local-ollama.json", "utf8"),
    );
    expect(local).toEqual([
      {
        id: "TendReviewLocalOllama",
        name: "Tend review local Ollama (no key)",
        type: "ollamaApi",
        data: { baseUrl: "http://host.docker.internal:11434" },
      },
    ]);
  });
  it("requires the third isolated retry attempt rather than any success", () => {
    const n = load("09-retry-fixture.json").nodes.find(
      (n) => n.name === "Record recovery only",
    )!;
    const run = (input: unknown) =>
      vm.runInNewContext(`(function(){${String(n.parameters.jsCode)}})()`, {
        $input: { first: () => ({ json: input }), all: () => [] },
      });
    expect(() => run({ recovered: true, attempt: 1 })).toThrow();
    expect(() => run({ recovered: true, attempt: 3 })).not.toThrow();
  });
  it("ships fifteen inactive exports without private account credentials or external recipients", () => {
    const files = readdirSync("workflows").filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(15);
    for (const f of files) {
      const raw = readFileSync(`workflows/${f}`, "utf8");
      expect(load(f).active).toBe(false);
      if (f === "07-extract-commitments.json")
        expect(raw).toContain('"ollamaApi"');
      else if (f === "10-telegram-private.json")
        expect(raw).toContain('"telegramApi"');
      else if (/^0[1-9]-/.test(f)) expect(raw).not.toContain('"credentials"');
      if (/^0[1-9]-/.test(f))
        expect(raw).not.toMatch(/n8n-nodes-base\.(gmail|telegram|whatsApp)/);
    }
  });
  it("adapters embed a callable unpublished subworkflow", () => {
    for (const f of readdirSync("workflows").filter((f) =>
      /^(0[1-5])/.test(f),
    )) {
      const w = load(f);
      const n = w.nodes.find(
        (n) => n.type === "n8n-nodes-base.executeWorkflow",
      )!;
      expect(n.parameters.source).toBe("parameter");
      const child = JSON.parse(String(n.parameters.workflowJson)) as Workflow;
      expect(child.active).toBe(false);
      expect(child.nodes[0]?.type).toBe(
        "n8n-nodes-base.executeWorkflowTrigger",
      );
    }
  });
  it("workflow Code guard rejects private/foreign data", () => {
    const n = load("06-normalize-store.json").nodes.find(
      (n) => n.name === "Validate fictional scope",
    )!;
    const run = (records: unknown[]) =>
      vm.runInNewContext(`(function(){${String(n.parameters.jsCode)}})()`, {
        $input: { first: () => ({ json: { fictional: true, records } }) },
      });
    expect(() => run(fixtureRecords)).not.toThrow();
    expect(() =>
      run([{ ...fixtureRecords[0], owner_id: "real-owner" }]),
    ).toThrow();
    expect(() =>
      run([{ ...fixtureRecords[0], ingestion_mode: "live" }]),
    ).toThrow();
  });
  it("workflow owner guard rejects a group before router/API access", () => {
    const n = load("08-assistant.json").nodes.find(
      (n) => n.name === "Authorize owner and private chat",
    )!;
    const run = (input: unknown) =>
      vm.runInNewContext(`(function(){${String(n.parameters.jsCode)}})()`, {
        $input: { first: () => ({ json: input }) },
      });
    expect(() => run(demoAuth)).not.toThrow();
    expect(() => run({ ...demoAuth, chat_type: "group" })).toThrow();
  });
  it("workflow AI guard rejects injected tool/recipient fields", () => {
    const n = load("07-extract-commitments.json").nodes.find(
      (n) => n.name === "Validate quoted model result",
    )!;
    const run = (candidate: unknown) =>
      vm.runInNewContext(`(function(){${String(n.parameters.jsCode)}})()`, {
        $input: {
          first: () => ({
            json: { text: JSON.stringify(candidate) },
          }),
        },
        $: () => ({ first: () => ({ json: { record: fixtureRecords[0] } }) }),
      });
    expect(() =>
      run({
        quote: fixtureRecords[0]!.body_text,
        action: "send the demo",
        suggested_due: "2026-10-15",
      }),
    ).not.toThrow();
    expect(() =>
      run({
        quote: fixtureRecords[0]!.body_text,
        action: "send the demo",
        suggested_due: "2026-10-15",
        recipient: "attacker",
      }),
    ).toThrow();
  });
});
