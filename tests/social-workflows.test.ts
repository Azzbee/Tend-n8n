import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, it, expect } from "vitest";
interface Node {
  name: string;
  type: string;
  parameters: Record<string, unknown>;
  retryOnFail?: boolean;
  credentials?: Record<string, { id: string }>;
}
interface Workflow {
  active: boolean;
  settings: Record<string, unknown>;
  nodes: Node[];
  connections: Record<string, Record<string, { node: string }[][]>>;
}
for (const [file, source, host] of [
  [
    "17-personal-whatsapp-readonly.json",
    "whatsapp_personal",
    "api1.unipile.com",
  ],
  ["18-linkedin-portability-readonly.json", "linkedin", "api.linkedin.com"],
  [
    "19-business-whatsapp-readonly.json",
    "whatsapp_business",
    "api1.unipile.com",
  ],
] as const) {
  const w = JSON.parse(readFileSync("workflows/" + file, "utf8")) as Workflow;
  const node = (name: string): Node => {
    const n = w.nodes.find((x) => x.name === name);
    if (!n) throw new Error("Missing node");
    return n;
  };
  const run = (
    name: string,
    input: unknown,
    linked: Record<string, unknown> = {},
    runIndex = 0,
  ): unknown =>
    vm.runInNewContext(
      `(function(){${String(node(name).parameters.jsCode)}})()`,
      {
        $input: { first: () => ({ json: input }) },
        $: (key: string) => ({
          first: (branch = 0, index = 0) => {
            if (branch !== 0) throw new Error("Unexpected workflow branch");
            return {
              json: Array.isArray(linked[key])
                ? linked[key][index]
                : linked[key],
            };
          },
        }),
        $runIndex: runIndex,
        Buffer,
      },
    );
  describe(source + " native read-only boundary", () => {
    it("pins both server-issued read plans to its distinct source", () => {
      for (const name of [
        "Plan owner identity read",
        "Plan selected provider page",
      ])
        expect(String(node(name).parameters.url)).toContain(
          `?source=${source}&`,
        );
    });
    it("remains inactive, manual, private and unconfigured", () => {
      expect(w.active).toBe(false);
      expect(w.settings).toMatchObject({
        saveDataSuccessExecution: "none",
        saveDataErrorExecution: "none",
        saveManualExecutions: false,
        executionTimeout: 120,
      });
      expect(
        w.nodes.filter((n) => n.type.endsWith("manualTrigger")),
      ).toHaveLength(1);
      expect(
        w.nodes.some((n) =>
          /schedule|telegram|webhook|gmail|whatsApp/i.test(n.type),
        ),
      ).toBe(false);
      expect(() =>
        run("Validate configured read selection", {
          account_id: "CONFIGURE_ACCOUNT_ID",
          phase: "snapshot",
        }),
      ).toThrow();
    });
    it("pins provider reads to GET with redirects and node retries disabled", () => {
      for (const prefix of ["Owner identity", "Selected provider page"]) {
        const n = node("Read " + prefix);
        expect(n.parameters.method).toBe("GET");
        expect(n.retryOnFail).toBe(false);
        expect(n.parameters.options).toMatchObject({
          timeout: 5000,
          redirect: { redirect: { followRedirects: false } },
          response: { response: { fullResponse: true, neverError: true } },
        });
        expect(n.credentials?.httpHeaderAuth?.id).toMatch(/^CONFIGURE_/);
      }
    });
    it("rejects wrong account, host, method and caller-mutated plans", () => {
      const linked = {
        "Validate configured read selection": {
          account_id: "fictional-account",
          phase: "snapshot",
        },
      };
      const plan = {
        method: "GET",
        source,
        account_id: "fictional-account",
        url: "https://" + host + "/read",
      };
      for (const stage of [
        "Check Owner identity plan",
        "Check Selected provider page plan",
      ]) {
        expect(() =>
          run(stage, { available: true, request_id: "fixture", plan }, linked),
        ).not.toThrow();
        for (const port of source !== "linkedin" ? [443, 13111] : [443])
          expect(() =>
            run(
              stage,
              {
                available: true,
                plan: {
                  ...plan,
                  url: "https://" + host + ":" + port + "/read",
                },
              },
              linked,
            ),
          ).not.toThrow();
        if (source !== "linkedin")
          expect(() =>
            run(
              stage,
              {
                available: true,
                plan: {
                  ...plan,
                  url: "https://api38.unipile.com:16860/api/v1/accounts/fictional-account",
                },
              },
              linked,
            ),
          ).not.toThrow();
        for (const replacement of [
          { method: "POST" },
          { source: "calendar" },
          {
            source:
              source === "whatsapp_business"
                ? "whatsapp_personal"
                : "whatsapp_business",
          },
          { account_id: "foreign" },
          { url: "https://attacker.invalid/read" },
          { url: "https://" + host + ".attacker.invalid/read" },
          { url: "https://attacker@" + host + "/read" },
          { url: "https://" + host + "@attacker.invalid/read" },
          { url: "https://" + host + ":444/read" },
          { url: "https://" + host + ":16861/read" },
          { url: "https://attacker.invalid:16860/read" },
          { url: "https://api38.unipile.com.attacker.invalid:16860/read" },
          { url: "https://attacker@api38.unipile.com:16860/read" },
          { url: "https://api38.unipile.com:16860\\@attacker.invalid/read" }, // pragma: allowlist secret (fictional host-spoof fixture)
          { url: "https://api38.unipile.com:16860/read\n" },
          { url: "https://api38.unipile.com:16860/read#fragment" },
          { url: "https://" + host + "\\@attacker.invalid/read" },
          { url: "https://" + host + "/read\n" },
          { url: "https://" + host + "/read\u0000" },
          { url: "https://" + host + "/read#fragment" },
          { url: " https://" + host + "/read" },
          { url: "https://" + host },
          ...(source === "linkedin"
            ? [
                { url: "https://" + host + ":13111/read" },
                { url: "https://" + host + ":16860/read" },
                { url: "https://api38.unipile.com:16860/read" },
              ]
            : []),
        ])
          expect(() =>
            run(
              stage,
              { available: true, plan: { ...plan, ...replacement } },
              linked,
            ),
          ).toThrow();
      }
    });
    it("forwards only Retry-After and the server-issued request ID", () => {
      const result = run(
        "Bound Owner identity response",
        {
          statusCode: 429,
          body: { error: "limited" },
          headers: { "retry-after": "5", "set-cookie": "fictional-cookie" },
        },
        {
          "Plan owner identity read": {
            request_id: "server-issued",
            max_result_bytes: 262144,
          },
        },
      );
      expect(result).toEqual([
        {
          json: {
            request_id: "server-issued",
            status: 429,
            body: { error: "limited" },
            headers: { "Retry-After": "5" },
          },
        },
      ]);
      expect(
        run(
          "Bound Owner identity response",
          { error: "Timeout" },
          {
            "Plan owner identity read": {
              request_id: "server-issued",
              max_result_bytes: 262144,
            },
          },
        ),
      ).toEqual([
        { json: { request_id: "server-issued", status: 599, body: {} } },
      ]);
    });
    it("uses the current server request on every repeated provider page", () => {
      expect(
        String(node("Bound Selected provider page response").parameters.jsCode),
      ).toContain(".first(0,$runIndex).json");
    });
    it("bounds the entire provider envelope to the server budget", () => {
      const result = run(
        "Bound Owner identity response",
        {
          statusCode: 200,
          body: { text: "x".repeat(300000) },
        },
        {
          "Plan owner identity read": {
            request_id: "server-issued",
            max_result_bytes: 262144,
          },
        },
      );
      expect(result).toEqual([
        {
          json: {
            request_id: "server-issued",
            status: 599,
            body: { error: "provider_envelope_exceeds_budget" },
          },
        },
      ]);
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(262144);
    });
    it("keeps the verified proof for bounded connection pagination", () => {
      expect(
        String(node("Plan selected provider page").parameters.url),
      ).toContain("$('Require verified owner proof').first().json.proof_id");
      const linked = {
        "Validate configured read selection": {
          phase: "connections",
          started_at: Date.now(),
        },
      };
      const first = run(
        "Bound connections preview pagination",
        { kind: "connections", complete: false },
        linked,
        0,
      );
      expect(first).toMatchObject([
        { json: { _continue_connections: source === "linkedin" } },
      ]);
      expect(
        run(
          "Bound connections preview pagination",
          { kind: "connections", complete: false },
          linked,
          4,
        ),
      ).toMatchObject([{ json: { _continue_connections: false } }]);
      expect(
        run(
          "Bound connections preview pagination",
          { kind: "connections", complete: true },
          linked,
          0,
        ),
      ).toMatchObject([{ json: { _continue_connections: false } }]);
      expect(
        run(
          "Bound connections preview pagination",
          { kind: "connections", complete: false },
          {
            "Validate configured read selection": {
              phase: "connections",
              started_at: Date.now() - 91000,
            },
          },
          0,
        ),
      ).toMatchObject([{ json: { _continue_connections: false } }]);
    });
    if (source === "linkedin") {
      const previews = (
        pages: Record<string, unknown>[],
      ): Record<string, unknown>[] => {
        const prior: Record<string, unknown>[] = [];
        for (const [index, page] of pages.entries()) {
          const result = run(
            "Bound connections preview pagination",
            page,
            {
              "Validate configured read selection": {
                phase: "connections",
                started_at: Date.now(),
              },
              "Bound connections preview pagination": prior,
            },
            index,
          ) as { json: Record<string, unknown> }[];
          prior.push(result[0]!.json);
        }
        return prior;
      };
      const connectionPage = (name: string, complete = false) => ({
        kind: "connections",
        complete,
        rows: name ? [{ "First Name": name }] : [],
        omitted_row_count: 2,
        unknown_field_count: 1,
        truncated_value_count: 1,
      });
      it("retains two data previews when the terminal page is empty", () => {
        const result = previews([
          connectionPage("One"),
          connectionPage("Two"),
          connectionPage("", true),
        ]).at(-1)!;
        expect(result).toMatchObject({
          rows: [{ "First Name": "One" }, { "First Name": "Two" }],
          complete: true,
          omitted_row_count: 6,
          unknown_field_count: 3,
          truncated_value_count: 3,
          preview_pages_read: 3,
          more_available: false,
          preview_budget_exhausted: false,
          _continue_connections: false,
        });
        const receipt = run("Return private provider receipt", result) as {
          json: Record<string, unknown>;
        }[];
        expect(receipt[0]!.json.rows).toEqual(result.rows);
        expect(receipt[0]!.json).not.toHaveProperty("_continue_connections");
      });
      it("retains all five bounded previews and reports the remaining pages", () => {
        const results = previews(
          Array.from({ length: 5 }, (_, index) =>
            connectionPage(String(index)),
          ),
        );
        expect(results[3]).toMatchObject({ _continue_connections: true });
        expect(results[4]).toMatchObject({
          rows: Array.from({ length: 5 }, (_, index) => ({
            "First Name": String(index),
          })),
          omitted_row_count: 10,
          preview_pages_read: 5,
          more_available: true,
          preview_budget_exhausted: true,
          _continue_connections: false,
        });
      });
      it("drops prior private previews after a blocked provider page", () => {
        const result = previews([
          connectionPage("One"),
          { kind: "blocked", reason: "provider_read_failed" },
        ]).at(-1)!;
        expect(result).toMatchObject({
          kind: "blocked",
          preview_interrupted: true,
          more_available: true,
          _continue_connections: false,
        });
        expect(result).not.toHaveProperty("rows");
        expect(JSON.stringify(result)).not.toContain("One");
      });
      it("caps aggregate preview bytes and counts omitted rows", () => {
        const row = {
          "First Name": "x".repeat(512),
          "Last Name": "x".repeat(512),
          Company: "x".repeat(512),
          Position: "x".repeat(512),
          "Connected On": "x".repeat(512),
        };
        const result = previews(
          Array.from({ length: 5 }, () => ({
            kind: "connections",
            complete: false,
            rows: Array.from({ length: 20 }, () => row),
            omitted_row_count: 0,
            unknown_field_count: 0,
            truncated_value_count: 0,
          })),
        ).at(-1)!;
        const rows = result.rows as unknown[];
        expect(Buffer.byteLength(JSON.stringify(rows))).toBeLessThanOrEqual(
          65536,
        );
        expect(rows.length).toBeLessThan(100);
        expect(result.omitted_row_count).toBe(100 - rows.length);
        expect(result.preview_truncated).toBe(true);
      });
    }
    it("cannot proceed from an unverified identity or return an invented delivery", () => {
      expect(() =>
        run("Require verified owner proof", {
          kind: "blocked",
          reason: "unverified_owner",
        }),
      ).toThrow();
      expect(
        run("Return private provider receipt", { kind: "page", accepted: 1 }),
      ).toEqual([
        {
          json: {
            kind: "page",
            accepted: 1,
            outbound_sent: false,
            submission_sent: false,
          },
        },
      ]);
    });
  });
}
