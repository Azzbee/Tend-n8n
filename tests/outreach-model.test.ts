import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  DEFAULT_DRAFT_MODEL,
  FALLBACK_DRAFT_MODEL,
  outreachDraftRequest,
} from "../src/outreach.ts";
import {
  createDraftModelResolver,
  createFixtureOutreachService,
} from "../src/outreach-service.ts";
import { buildOutreachWorkflows } from "../src/outreach-workflows.ts";

const tags = (...names: string[]) =>
  (async () =>
    new Response(JSON.stringify({ models: names.map((name) => ({ name })) }), {
      status: 200,
    })) as unknown as typeof fetch;

describe("configurable local draft model", () => {
  it("defaults to qwen3:4b with qwen3:0.6b as the fallback", () => {
    expect(DEFAULT_DRAFT_MODEL).toBe("qwen3:4b");
    expect(FALLBACK_DRAFT_MODEL).toBe("qwen3:0.6b");
  });
  it("uses the configured model only when Ollama lists it", async () => {
    expect(
      await createDraftModelResolver(
        undefined,
        tags("qwen3:4b", "qwen3:0.6b"),
      )(),
    ).toBe("qwen3:4b");
    expect(
      await createDraftModelResolver(
        "qwen3:8b",
        tags("qwen3:4b", "qwen3:0.6b"),
      )(),
    ).toBe("qwen3:0.6b");
    expect(await createDraftModelResolver("qwen3:8b", tags("qwen3:8b"))()).toBe(
      "qwen3:8b",
    );
  });
  it("falls back when Ollama is unreachable or the name is not a model name", async () => {
    const down = (async () => {
      throw new Error("connect ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await createDraftModelResolver("qwen3:4b", down)()).toBe(
      FALLBACK_DRAFT_MODEL,
    );
    let called = false;
    const spy = (async () => {
      called = true;
      return new Response("{}");
    }) as unknown as typeof fetch;
    expect(await createDraftModelResolver("qwen3:4b; rm -rf /", spy)()).toBe(
      FALLBACK_DRAFT_MODEL,
    );
    expect(called).toBe(false);
  });
  it("asks Ollama at most once a minute", async () => {
    let calls = 0;
    let now = 0;
    const counted = (async () => {
      calls++;
      return new Response(JSON.stringify({ models: [{ name: "qwen3:4b" }] }));
    }) as unknown as typeof fetch;
    const resolve = createDraftModelResolver(undefined, counted, () => now);
    await resolve();
    await resolve();
    expect(calls).toBe(1);
    now = 60001;
    await resolve();
    expect(calls).toBe(2);
  });
  it("puts the resolved model into each planner request", () => {
    const { book, store } = createFixtureOutreachService();
    const p = {
      item_key: "x",
      contact_id: "F17",
      contact_name: "Mira Tan",
      channel: "email" as const,
      reason: "after_meeting" as const,
      recipient: "mira@example.invalid",
      evidence: [{ source: "calendar", text: "Demo review", reference: "r" }],
      evidence_keys: [],
      evidence_hash: "h",
      style_examples: [],
      evidence_from: ["calendar"],
      fallback_text: "Hi",
    };
    expect(outreachDraftRequest(p, "qwen3:4b").model).toBe("qwen3:4b");
    expect(outreachDraftRequest(p).model).toBe(FALLBACK_DRAFT_MODEL);
    book.close();
    store.close();
  });
  it("gives the larger model two minutes in workflows 23 and 25", () => {
    for (const file of [
      "23-outreach-planner.json",
      "25-private-outreach-planner.json",
    ]) {
      const w = buildOutreachWorkflows().find((b) => b.file === file)!.workflow;
      const model = w.nodes.find((n) => n.name.startsWith("Local AI draft"))!;
      expect(model.parameters.options).toEqual({ timeout: 120000 });
      expect(model.parameters.body).toBe(
        "={{ JSON.stringify($json.request) }}",
      );
      expect(readFileSync(`workflows/${file}`, "utf8")).toContain(
        '"timeout": 120000',
      );
    }
  });
});
