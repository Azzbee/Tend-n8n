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
  it("explains every canvas with one sticky note naming purpose, inputs, outputs and privacy", () => {
    for (const f of readdirSync("workflows").filter((f) =>
      f.endsWith(".json"),
    )) {
      const w = JSON.parse(
        readFileSync(`workflows/${f}`, "utf8"),
      ) as Workflow & {
        id: string;
        connections: Record<string, unknown>;
      };
      const notes = w.nodes.filter(
        (n) => n.type === "n8n-nodes-base.stickyNote",
      );
      expect(notes, f).toHaveLength(1);
      const text = String(notes[0]!.parameters.content);
      for (const heading of ["Purpose", "Inputs", "Outputs", "Privacy"])
        expect(text, `${f} ${heading}`).toContain(`**${heading}:**`);
      expect(text.length, f).toBeLessThan(900);
      expect(notes[0]).not.toHaveProperty("credentials");
      expect(Object.keys(w.connections)).not.toContain(notes[0]!.name);
      if (/^(1\d|20)-/.test(f)) expect(text, f).toContain("no execution data");
    }
  });
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
  it("ships twenty-two inactive exports without private account credentials or external recipients", () => {
    const files = readdirSync("workflows").filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(22);
    expect(files).toContain("22-private-error-handler.json");
    expect(files).toContain("21-error-handler.json");
    expect(files).toContain("20-daily-owner-briefing.json");
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
  it("fictional workflows 01-09 point at the redacting error workflow", () => {
    for (const f of readdirSync("workflows").filter((f) =>
      /^0[1-9]-/.test(f),
    )) {
      const w = JSON.parse(readFileSync(`workflows/${f}`, "utf8")) as {
        settings: { errorWorkflow?: string };
      };
      expect(w.settings.errorWorkflow).toBe("TendReview21");
    }
    const handler = JSON.parse(
      readFileSync("workflows/21-error-handler.json", "utf8"),
    ) as { id: string; active: boolean; nodes: Node[] };
    expect(handler.id).toBe("TendReview21");
    expect(handler.active).toBe(false);
    expect(handler.nodes[0]?.type).toBe("n8n-nodes-base.errorTrigger");
    for (const f of readdirSync("workflows").filter((f) =>
      /^(1[0-9]|20)-/.test(f),
    )) {
      const w = JSON.parse(readFileSync(`workflows/${f}`, "utf8")) as {
        settings: Record<string, unknown>;
      };
      expect(w.settings.errorWorkflow, f).toBe("TendPrivate22");
      expect(w.settings.saveDataErrorExecution, f).toBe("none");
      expect(w.settings.saveDataSuccessExecution, f).toBe("none");
    }
  });
  it("error workflow keeps only names and a short message, never item data", () => {
    const n = load("21-error-handler.json").nodes.find(
      (n) => n.name === "Redact failure to names only",
    )!;
    const out = vm.runInNewContext(
      `(function(){${String(n.parameters.jsCode)}})()`,
      {
        $input: {
          first: () => ({
            json: {
              workflow: { name: "Tend 07: Extract Commitments" },
              execution: {
                id: 4242,
                lastNodeExecuted: "Validate quoted model result",
                error: { message: "bad\n  quote " + "x".repeat(500) },
                data: { secret: "PRIVATE BODY TEXT" },
              },
            },
          }),
        },
      },
    ) as { json: Record<string, string> }[];
    const j = out[0]!.json;
    expect(Object.keys(j).sort()).toEqual([
      "execution_id",
      "message",
      "node",
      "workflow",
    ]);
    expect(j.message!.length).toBeLessThanOrEqual(200);
    expect(j.message!.startsWith("bad quote")).toBe(true);
    expect(JSON.stringify(j)).not.toContain("PRIVATE BODY TEXT");
    expect(j.execution_id).toBe("4242");
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
