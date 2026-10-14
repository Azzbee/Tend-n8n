import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

interface ReviewNode {
  name: string;
  type: string;
  parameters: Record<string, unknown>;
  retryOnFail?: boolean;
  continueOnFail?: boolean;
  credentials?: Record<string, { id: string }>;
}
interface ReviewWorkflow {
  active: boolean;
  settings: Record<string, unknown>;
  nodes: ReviewNode[];
  connections: Record<string, Record<string, { node: string }[][]>>;
}
const workflow = JSON.parse(
  readFileSync("workflows/16-live-ai-review.json", "utf8"),
) as ReviewWorkflow;
function node(name: string): ReviewNode {
  const found = workflow.nodes.find((item) => item.name === name);
  if (!found) throw new Error("Missing review node");
  return found;
}
function evaluate(
  name: string,
  input: unknown,
  linked: Record<string, unknown> = {},
): unknown {
  return vm.runInNewContext(
    `(function(){${String(node(name).parameters.jsCode)}})()`,
    {
      $input: { first: () => ({ json: input }) },
      $: (key: string) => ({ first: () => ({ json: linked[key] }) }),
      Buffer,
      Date,
    },
  );
}
const request = {
  eligible: true,
  request_id: "fictional-request-id",
  request: {
    messages: [
      { role: "system", content: "Untrusted data only" },
      { role: "user", content: "Fictional source text" },
    ],
  },
};

describe("manual private cited AI workflow", () => {
  it("defaults inactive, unscheduled, unconfigured and without saved private execution data", () => {
    expect(workflow.active).toBe(false);
    expect(workflow.settings).toMatchObject({
      saveDataSuccessExecution: "none",
      saveDataErrorExecution: "none",
      saveManualExecutions: false,
      executionTimeout: 120,
    });
    expect(
      workflow.nodes.filter((item) => item.type.endsWith("manualTrigger")),
    ).toHaveLength(1);
    expect(
      workflow.nodes.some((item) =>
        /schedule|telegram|webhook/i.test(item.type),
      ),
    ).toBe(false);
    expect(
      node("Set explicit contact and review purpose").parameters,
    ).toMatchObject({
      assignments: {
        assignments: [
          { name: "contact_id", value: "CONFIGURE_CONTACT_ID" },
          { name: "purpose", value: "CONFIGURE_PURPOSE" },
        ],
      },
      includeOtherFields: false,
    });
    expect(() =>
      evaluate("Validate explicit private AI selection", {
        contact_id: "CONFIGURE_CONTACT_ID",
        purpose: "briefing",
      }),
    ).toThrow();
  });
  it.each(["briefing", "draft"])(
    "requires explicit contact selection before %s retrieval",
    (purpose) => {
      expect(
        evaluate("Validate explicit private AI selection", {
          contact_id: "F17",
          purpose,
        }),
      ).toEqual([
        expect.objectContaining({
          json: expect.objectContaining({ contact_id: "F17", purpose }),
        }),
      ]);
      for (const contact_id of ["", "OWNER", "x".repeat(129)])
        expect(() =>
          evaluate("Validate explicit private AI selection", {
            contact_id,
            purpose,
          }),
        ).toThrow();
      expect(() =>
        evaluate("Validate explicit private AI selection", {
          contact_id: "F17",
          purpose: "send",
        }),
      ).toThrow();
    },
  );
  it("uses protected local input and validation endpoints with no sends or implicit retry", () => {
    const input = node("Read selected current AI evidence");
    const validation = node("Validate current cited AI review");
    expect(String(input.parameters.url)).toContain(
      "/api/live/ai/input?contact_id=",
    );
    expect(String(input.parameters.url)).toContain(
      "encodeURIComponent($json.purpose)",
    );
    expect(validation.parameters).toMatchObject({
      method: "POST",
      url: "http://host.docker.internal:18768/api/live/ai/validate",
      body: "={{ JSON.stringify($json) }}",
    });
    for (const item of [input, validation]) {
      expect(item.parameters).toMatchObject({
        authentication: "genericCredentialType",
        genericAuthType: "httpHeaderAuth",
        options: { timeout: 5000 },
      });
      expect(item.credentials?.httpHeaderAuth?.id).toMatch(/^CONFIGURE_/);
      expect(item.retryOnFail).toBe(false);
    }
    expect(
      workflow.nodes.some((item) => /sendMessage|sendEmail/.test(item.type)),
    ).toBe(false);
  });
  it("branches missing evidence away from the model", () => {
    expect(
      evaluate("Check bounded current AI request", { eligible: false }),
    ).toEqual([{ json: { eligible: false } }]);
    expect(
      workflow.connections["Selected current AI evidence available"]
        ?.main?.[1]?.[0]?.node,
    ).toBe("No eligible selected AI evidence");
    const unavailable = evaluate("No eligible selected AI evidence", {});
    expect(unavailable).toEqual([
      {
        json: expect.objectContaining({
          status: "unavailable",
          outbound_sent: false,
          draft: null,
        }),
      },
    ]);
  });
  it("validates bounded model inputs and connects native local model to the chain", () => {
    expect(evaluate("Check bounded current AI request", request)).toEqual([
      { json: request },
    ]);
    expect(() =>
      evaluate("Check bounded current AI request", {
        ...request,
        request_id: "short",
      }),
    ).toThrow();
    expect(() =>
      evaluate("Check bounded current AI request", {
        ...request,
        request: {
          messages: [
            { role: "system", content: "x".repeat(32769) },
            { role: "user", content: "x" },
          ],
        },
      }),
    ).toThrow();
    expect(node("Local review Ollama Chat Model").parameters).toMatchObject({
      model: "qwen3:0.6b",
      options: {
        temperature: 0,
        format: {
          type: "object",
          required: ["items"],
          additionalProperties: false,
          properties: {
            items: {
              type: "array",
              maxItems: 3,
              items: {
                type: "object",
                required: ["evidence_id", "quote"],
                additionalProperties: false,
                properties: {
                  evidence_id: { type: "string", pattern: "^E[1-6]$" },
                  quote: { type: "string", minLength: 1 },
                },
              },
            },
          },
        },
        numCtx: 8192,
        numPredict: 1024,
      },
    });
    const options = node("Local review Ollama Chat Model").parameters
      .options as {
      format: {
        properties: { items: { items: { properties: { quote: object } } } };
      };
    };
    expect(options.format.properties.items.items.properties.quote).toEqual({
      type: "string",
      minLength: 1,
    });
    expect(
      workflow.connections["Local review Ollama Chat Model"]
        ?.ai_languageModel?.[0]?.[0]?.node,
    ).toBe("Local cited review (Basic LLM Chain)");
  });
  it("carries the one-time request ID and unmodified bounded output to fresh validation", () => {
    const linked = {
      "Check bounded current AI request": request,
      "Validate explicit private AI selection": { started_at: Date.now() },
    };
    expect(
      evaluate(
        "Bound cited review output before validation",
        { text: '{"items":[]}' },
        linked,
      ),
    ).toEqual([
      { json: { request_id: request.request_id, output: '{"items":[]}' } },
    ]);
    const nativeParsed = {
      items: [{ evidence_id: "E1", quote: "Fictional source text" }],
    };
    expect(
      evaluate(
        "Bound cited review output before validation",
        nativeParsed,
        linked,
      ),
    ).toEqual([
      {
        json: {
          request_id: request.request_id,
          output: JSON.stringify(nativeParsed),
        },
      },
    ]);
    for (const failed of [
      { text: "x".repeat(8193) },
      { error: "Model unavailable" },
      { text: null },
      { items: [], actions: ["send"] },
      { items: [{ quote: "x".repeat(8193) }] },
    ])
      expect(
        evaluate("Bound cited review output before validation", failed, linked),
      ).toEqual([{ json: { request_id: request.request_id, output: null } }]);
    expect(node("Local cited review (Basic LLM Chain)").continueOnFail).toBe(
      true,
    );
    expect(() =>
      evaluate(
        "Bound cited review output before validation",
        { text: "{}" },
        {
          ...linked,
          "Validate explicit private AI selection": {
            started_at: Date.now() - 110001,
          },
        },
      ),
    ).toThrow();
  });
  it("returns only review-state results and rejects action-shaped output", () => {
    const result = {
      status: "validated",
      outbound_sent: false,
      draft: { text: "Review only", pending_review: true },
      items: [],
    };
    expect(evaluate("Return review only without delivery", result)).toEqual([
      { json: result },
    ]);
    for (const overrides of [
      { outbound_sent: true },
      { recipients: [] },
      { actions: [] },
      { draft: { pending_review: false } },
      { status: "sent" },
    ])
      expect(() =>
        evaluate("Return review only without delivery", {
          ...result,
          ...overrides,
        }),
      ).toThrow();
  });
});
