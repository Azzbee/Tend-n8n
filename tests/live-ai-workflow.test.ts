import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

interface ReviewNode {
  name: string;
  type: string;
  parameters: Record<string, unknown>;
  retryOnFail?: boolean;
  continueOnFail?: boolean;
  disabled?: boolean;
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
    model: "qwen3:0.6b",
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
      workflow.nodes.some((item) => /schedule|webhook/i.test(item.type)),
    ).toBe(false);
    expect(
      node("Set explicit contact and review purpose").parameters,
    ).toMatchObject({
      assignments: {
        assignments: [
          { name: "contact_id", value: "CONFIGURE_CONTACT_ID" },
          { name: "purpose", value: "CONFIGURE_PURPOSE" },
          { name: "deliver_to_owner", value: false },
          { name: "owner_chat_id", value: "CONFIGURE_OWNER_CHAT_ID" },
          { name: "owner_user_id", value: "CONFIGURE_OWNER_USER_ID" },
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
  it("defaults delivery off and binds native transport only to trusted owner configuration", () => {
    const assignments = node("Set explicit contact and review purpose")
      .parameters.assignments as {
      assignments: { name: string; value: unknown }[];
    };
    expect(assignments.assignments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "deliver_to_owner", value: false }),
        expect.objectContaining({
          name: "owner_chat_id",
          value: "CONFIGURE_OWNER_CHAT_ID",
        }),
        expect.objectContaining({
          name: "owner_user_id",
          value: "CONFIGURE_OWNER_USER_ID",
        }),
      ]),
    );
    const transport = node("Deliver validated review only to enrolled owner");
    expect(
      workflow.connections["Owner delivery explicitly enabled"]?.main?.[1]?.[0]
        ?.node,
    ).toBe("Return local review without delivery");
    expect(
      workflow.connections["Owner delivery explicitly enabled"]?.main?.[0]?.[0]
        ?.node,
    ).toBe("Prepare bounded validated owner review");
    expect(
      workflow.connections["Prepare bounded validated owner review"]
        ?.main?.[0]?.[0]?.node,
    ).toBe(transport.name);
    expect(transport.disabled).toBe(true);
    expect(transport.retryOnFail).toBe(false);
    expect(transport.continueOnFail).not.toBe(true);
    expect(transport.credentials?.telegramApi?.id).toBe(
      "CONFIGURE_OWNER_TELEGRAM_CREDENTIAL",
    );
    expect(transport.parameters.chatId).toBe(
      "={{ $('Validate explicit private AI selection').first().json.owner_chat_id }}",
    );
    expect(
      evaluate(
        "Check explicit owner delivery",
        { deliver_to_owner: true },
        {
          "Validate explicit private AI selection": { deliver_to_owner: false },
        },
      ),
    ).toEqual([{ json: { deliver_to_owner: false } }]);
  });
  it.each(["validated", "fallback", "unavailable"])(
    "retains the complete %s result as default local output",
    (status) => {
      const result = {
        status,
        purpose: "draft",
        items: [],
        draft: null,
        outbound_sent: false,
        warning: "Local review",
      };
      expect(
        evaluate(
          "Return local review without delivery",
          { deliver_to_owner: false },
          { "Return review only without delivery": result },
        ),
      ).toEqual([{ json: result }]);
    },
  );
  it("rejects non-private, unconfigured or mismatched owner destinations before retrieval", () => {
    const selection = {
      contact_id: "F17",
      purpose: "briefing",
      deliver_to_owner: true,
      owner_chat_id: "12345",
      owner_user_id: "12345",
    };
    expect(
      evaluate("Validate explicit private AI selection", selection),
    ).toEqual([
      expect.objectContaining({ json: expect.objectContaining(selection) }),
    ]);
    for (const patch of [
      { owner_chat_id: "-12345" },
      { owner_user_id: "12346" },
      { owner_chat_id: "CONFIGURE_OWNER_CHAT_ID" },
      { deliver_to_owner: "true" },
    ]) {
      expect(() =>
        evaluate("Validate explicit private AI selection", {
          ...selection,
          ...patch,
        }),
      ).toThrow();
    }
  });
  it("delivers escaped bounded cited review text and leaves drafts pending", () => {
    const result = {
      status: "validated",
      purpose: "briefing",
      outbound_sent: false,
      draft: null,
      warning: null,
      items: [
        {
          record_key: "record",
          content_hash: "hash",
          source: "gmail",
          evidence_reference: "tend-source:fictional",
          quote: "<hello> & goodbye",
        },
      ],
    };
    const linked = {
      "Validate explicit private AI selection": {
        purpose: "briefing",
        contact_id: "P1",
        deliver_to_owner: true,
        owner_chat_id: "12345",
        owner_user_id: "12345",
      },
      "Return review only without delivery": result,
    };
    expect(
      evaluate("Prepare bounded validated owner review", {}, linked),
    ).toEqual([
      {
        json: { text: expect.stringContaining("&lt;hello&gt; &amp; goodbye") },
      },
    ]);
    for (const patch of [
      { status: "fallback" },
      { status: "unavailable" },
      { recipients: ["other"] },
      { recipient: "other" },
      { tools: [] },
      { items: [] },
      { purpose: "draft" },
      { draft: { text: "bad", pending_review: false } },
      { items: [{ ...result.items[0], quote: "&".repeat(3900) }] },
      { items: [{ ...result.items[0], recipient: "other" }] },
    ]) {
      expect(() =>
        evaluate(
          "Prepare bounded validated owner review",
          {},
          {
            ...linked,
            "Return review only without delivery": { ...result, ...patch },
          },
        ),
      ).toThrow();
    }
    const draft = {
      ...result,
      purpose: "draft",
      draft: {
        text: "Draft <pending>",
        pending_review: true,
        label: "AI-written draft. Check facts before sending",
        model: "qwen3:4b",
        recipient: { contact_id: "P1", name: "Fictional Person" },
        style_basis: "neutral",
        prose_fact_verified: false,
      },
    };
    expect(
      evaluate(
        "Prepare bounded validated owner review",
        {},
        {
          ...linked,
          "Validate explicit private AI selection": {
            ...linked["Validate explicit private AI selection"],
            purpose: "draft",
          },
          "Return review only without delivery": draft,
        },
      ),
    ).toEqual([
      { json: { text: expect.stringContaining("Draft &lt;pending&gt;") } },
    ]);
  });
  it("enforces the escaped UTF-16 limit exactly without truncating source text", () => {
    const result = {
      status: "validated",
      purpose: "briefing",
      outbound_sent: false,
      draft: null,
      warning: null,
      items: [
        {
          record_key: "record",
          content_hash: "hash",
          source: "gmail",
          evidence_reference: "tend-source:fictional",
          quote: "x",
        },
      ],
    };
    const linked = {
      "Validate explicit private AI selection": {
        purpose: "briefing",
        deliver_to_owner: true,
        owner_chat_id: "12345",
        owner_user_id: "12345",
      },
      "Return review only without delivery": result,
    };
    const initial = evaluate(
      "Prepare bounded validated owner review",
      {},
      linked,
    ) as { json: { text: string } }[];
    const overhead = initial[0]!.json.text.length - 1;
    result.items[0]!.quote = "x".repeat(3900 - overhead);
    const boundary = evaluate(
      "Prepare bounded validated owner review",
      {},
      linked,
    ) as { json: { text: string } }[];
    expect(boundary[0]!.json.text.length).toBe(3900);
    expect(boundary[0]!.json.text).toContain(result.items[0]!.quote);
    result.items[0]!.quote += "x";
    expect(() =>
      evaluate("Prepare bounded validated owner review", {}, linked),
    ).toThrow(/limit/);
    result.items[0]!.quote = "x".repeat(3900 - overhead - 1) + "😀";
    expect(() =>
      evaluate("Prepare bounded validated owner review", {}, linked),
    ).toThrow(/limit/);
  });
  it("accepts the installed Telegram node raw API envelope and rejects failed or malformed wrappers", () => {
    const linked = {
      "Validate explicit private AI selection": { owner_chat_id: "12345" },
      "Return review only without delivery": {
        status: "validated",
        outbound_sent: false,
        draft: null,
      },
    };
    const message = { message_id: 42, chat: { id: 12345, type: "private" } };
    expect(
      evaluate(
        "Verify owner delivery receipt",
        { ok: true, result: message },
        linked,
      ),
    ).toEqual([
      {
        json: expect.objectContaining({
          owner_delivery: { status: "sent", message_id: 42 },
        }),
      },
    ]);
    for (const response of [
      { ok: false, result: message },
      { ok: false, ...message },
      { ok: true, ...message },
      { result: message },
      { ok: true, result: null },
      { ok: true, result: [] },
      {
        ok: true,
        result: { ...message, chat: { id: 12346, type: "private" } },
      },
    ])
      expect(() =>
        evaluate("Verify owner delivery receipt", response, linked),
      ).toThrow();
  });
  it("acknowledges only the configured private owner and never claims contact delivery", () => {
    const linked = {
      "Validate explicit private AI selection": { owner_chat_id: "12345" },
      "Return review only without delivery": {
        status: "validated",
        outbound_sent: false,
        draft: null,
      },
    };
    expect(
      evaluate(
        "Verify owner delivery receipt",
        { message_id: 42, chat: { id: 12345, type: "private" } },
        linked,
      ),
    ).toEqual([
      {
        json: expect.objectContaining({
          outbound_sent: false,
          owner_delivery: { status: "sent", message_id: 42 },
        }),
      },
    ]);
    for (const response of [
      { error: "timeout" },
      { message_id: 42, chat: { id: 12346, type: "private" } },
      { message_id: 42, chat: { id: 12345, type: "group" } },
      { message_id: 0, chat: { id: 12345, type: "private" } },
    ])
      expect(() =>
        evaluate("Verify owner delivery receipt", response, linked),
      ).toThrow();
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
      model:
        "={{ $('Check bounded current AI request').first().json.request.model }}",
      options: {
        temperature: 0,
        format:
          "={{ $('Check bounded current AI request').first().json.request.format }}",
        numCtx: 8192,
        numPredict: 1024,
      },
    });
    const options = node("Local review Ollama Chat Model").parameters
      .options as { format: string };
    for (const format of [
      "json",
      {
        type: "object",
        required: ["items", "draft"],
        additionalProperties: false,
      },
    ]) {
      expect(
        vm.runInNewContext(options.format.slice(3, -2), {
          $: () => ({ first: () => ({ json: { request: { format } } }) }),
        }),
      ).toEqual(format);
    }
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
