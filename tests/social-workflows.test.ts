import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, it, expect } from "vitest";
import { normalizeUnipileMessage } from "../src/messaging-records.ts";
import { normalizeLiveRecord, validateLiveCandidate } from "../src/engine.ts";
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
for (const [file, source, host, credential] of [
  [
    "17-personal-whatsapp-readonly.json",
    "whatsapp_personal",
    "api1.unipile.com",
    "CONFIGURE_UNIPILE_READ_HEADER",
  ],
  [
    "18-linkedin-portability-readonly.json",
    "linkedin",
    "api.linkedin.com",
    "CONFIGURE_LINKEDIN_PORTABILITY_HEADER",
  ],
  [
    "19-business-whatsapp-readonly.json",
    "whatsapp_business",
    "api1.unipile.com",
    "CONFIGURE_UNIPILE_BUSINESS_READ_HEADER",
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
        $input: {
          first: () => ({ json: input }),
          all: () =>
            (Array.isArray(input) ? input : [input]).map((json: unknown) => ({
              json,
            })),
        },
        $: (key: string) => ({
          all: (branch = 0, index = 0) => {
            if (branch !== 0) throw new Error("Unexpected workflow branch");
            return (
              Array.isArray(linked[key]) ? linked[key][index] : linked[key]
            ).map((json: unknown) => ({ json }));
          },
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
        URL,
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
        expect(n.credentials?.httpHeaderAuth?.id).toBe(credential);
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
    if (source !== "linkedin") {
      const owner = "15550000001",
        peer = "999999999@lid";
      const message = {
        id: "m1",
        account_id: "fictional-account",
        chat_id: "c1",
        chat_provider_id: peer,
        sender_id: "88888888@lid",
        is_sender: 1,
        attendees: [{ attendee_provider_id: "spoof" }],
        timestamp: "2026-10-13T12:00:00Z",
        text: "I will send the draft tomorrow.",
      };
      const ctx = {
        plan: {
          method: "GET",
          source,
          account_id: "fictional-account",
          expected_owner_identity: owner,
          url: "https://api38.unipile.com:16860/api/v1/messages?account_id=fictional-account",
          limit: 20,
        },
        max_result_bytes: 262144,
      };
      const linked = (items: unknown[] = [message]) => ({
        "Plan selected provider page": ctx,
        "Project bounded WhatsApp message page": {
          statusCode: 200,
          body: { object: "MessageList", items, cursor: "next" },
        },
        "Prepare exact WhatsApp chats": [
          [{ _chat_lookup: true, chat_id: "c1" }],
        ],
      });
      const chat = {
        object: "Chat",
        id: "c1",
        account_id: "fictional-account",
        account_type: "WHATSAPP",
        type: 0,
        provider_id: peer,
        attendee_provider_id: peer,
      };
      const project = (response: unknown, context = ctx) =>
        (
          run("Project bounded WhatsApp message page", response, {
            "Plan selected provider page": context,
          }) as {
            json: {
              statusCode: number;
              body: {
                object: string;
                items: Record<string, unknown>[];
                cursor: string | null;
              };
              headers?: Record<string, string>;
            };
          }[]
        )[0]!.json;
      it("projects ignored metadata while retaining every message, exact text, cursor and normalization outcome", () => {
        const context = {
          principal_id: "fictional-owner",
          account_id: "fictional-account",
          owner_identity: owner,
          now: new Date("2026-10-14T12:00:00Z"),
          authenticated: {
            provider: "unipile" as const,
            account_id: "fictional-account",
          },
        };
        for (const patch of [
          {},
          { text: null },
          { hidden: 1 },
          { deleted: true },
          { edited: 1 },
          { is_event: true },
          { event_type: 1 },
          { is_hidden: true },
          { hidden: "invalid" },
          { is_sender: "1" },
          { sender_id: "foreign-phone" },
          { timestamp: "bad-date" },
        ]) {
          const raw = {
            ...message,
            ...patch,
            message_id: "alternate-id",
            original: "x".repeat(900000),
            seen_by: { ignored: "x".repeat(190000) },
          };
          const projected = project({
            statusCode: 200,
            body: {
              object: "MessageList",
              items: [raw],
              cursor: "opaque+/=20",
            },
          });
          expect(projected.body.cursor).toBe("opaque+/=20");
          expect(projected.body.items).toHaveLength(1);
          expect(projected.body.items[0]?.text).toBe(raw.text);
          for (const key of ["original", "seen_by", "attendees"])
            expect(projected.body.items[0]).not.toHaveProperty(key);
          const before = normalizeUnipileMessage(
            enriched({ statusCode: 200, body: chat }, [raw]).body.items[0],
            context,
            source,
          );
          const after = normalizeUnipileMessage(
            enriched({ statusCode: 200, body: chat }, projected.body.items).body
              .items[0],
            context,
            source,
          );
          expect(after).toEqual(before);
          if (before.kind === "accepted" && after.kind === "accepted") {
            expect(normalizeLiveRecord(after.record, after.identities)).toEqual(
              normalizeLiveRecord(before.record, before.identities),
            );
            if (after.record.eligible_for_extraction) {
              const candidate = {
                quote: after.record.authored_spans[0]!.text,
                action: "send the draft",
                suggested_due: null,
              };
              expect(validateLiveCandidate(after.record, candidate)).toEqual(
                validateLiveCandidate(before.record, candidate),
              );
            }
          }
        }
        const ordered = Array.from({ length: 20 }, (_, i) => ({
          ...message,
          id: String(i),
          text: "exact " + i,
        }));
        expect(
          project({
            statusCode: 200,
            body: { object: "MessageList", items: ordered, cursor: null },
          }).body.items.map((x) => [x.id, x.text]),
        ).toEqual(ordered.map((x) => [x.id, x.text]));
      });
      it("enforces independent raw and projected envelope budgets without truncation", () => {
        const response = {
          statusCode: 200,
          body: { object: "MessageList", items: [message], cursor: "next" },
          ignored: "",
        };
        const exact = {
          ...response,
          ignored: "x".repeat(
            4 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(response)),
          ),
        };
        expect(Buffer.byteLength(JSON.stringify(exact))).toBe(4 * 1024 * 1024);
        expect(project(exact).body.items[0]?.text).toBe(message.text);
        expect(() =>
          project({ ...exact, ignored: exact.ignored + "x" }),
        ).toThrow("WhatsApp raw page exceeds budget");
        const textPage = {
          ...response,
          body: {
            ...response.body,
            items: [{ ...message, text: "x".repeat(2000) }],
          },
        };
        const projected = project(textPage);
        const size = Buffer.byteLength(JSON.stringify(projected));
        expect(project(textPage, { ...ctx, max_result_bytes: size })).toEqual(
          projected,
        );
        expect(() =>
          project(textPage, { ...ctx, max_result_bytes: size - 1 }),
        ).toThrow("WhatsApp projected page exceeds budget");
        expect(() =>
          project({
            ...response,
            body: {
              ...response.body,
              items: Array.from({ length: 21 }, () => message),
            },
          }),
        ).toThrow();
        for (const cursor of [undefined, "", 1, "x".repeat(8193), "bad\n"]) {
          expect(() =>
            project({ ...response, body: { ...response.body, cursor } }),
          ).toThrow();
        }
      });
      it("bounds failed-page headers and routes both enrichment stages through the projection", () => {
        expect(
          project({
            statusCode: 429,
            headers: { "retry-after": "60", private: "do not retain" },
            body: { private: "do not retain" },
          }),
        ).toEqual({
          statusCode: 429,
          body: { error: "provider_read_failed" },
          headers: { "Retry-After": "60" },
        });
        expect(
          project({
            statusCode: 503,
            headers: { "Retry-After": "x".repeat(129) },
            body: "private",
          }),
        ).toEqual({ statusCode: 503, body: { error: "provider_read_failed" } });
        expect(
          w.connections["Read Selected provider page"]?.main?.[0]?.[0]?.node,
        ).toBe("Project bounded WhatsApp message page");
        expect(
          w.connections["Project bounded WhatsApp message page"]?.main?.[0]?.[0]
            ?.node,
        ).toBe("Prepare exact WhatsApp chats");
        const context = {
          ...linked(),
          "Read Selected provider page": {
            statusCode: 200,
            body: { private: "must not be read" },
          },
        };
        expect(
          run(
            "Verify exact WhatsApp membership",
            [{ statusCode: 200, body: chat }],
            context,
          ),
        ).toEqual([{ json: enriched({ statusCode: 200, body: chat }) }]);
      });
      it("uses bounded exact native chat GETs with the distinct source credential", () => {
        const n = node("Read exact WhatsApp chats");
        expect(n.parameters.method).toBe("GET");
        expect(n.retryOnFail).toBe(false);
        expect(n.credentials?.httpHeaderAuth?.id).toBe(credential);
        expect(n.parameters.options).toMatchObject({
          timeout: 15000,
          redirect: { redirect: { followRedirects: false } },
          batching: { batch: { batchSize: 4, batchInterval: 5000 } },
        });
        expect(
          run(
            "Prepare exact WhatsApp chats",
            linked([message, { ...message, id: "m2" }])[
              "Project bounded WhatsApp message page"
            ],
            linked([message, { ...message, id: "m2" }]),
          ),
        ).toEqual([
          {
            json: {
              _chat_lookup: true,
              chat_id: "c1",
              url: "https://api38.unipile.com:16860/api/v1/chats/c1",
            },
          },
        ]);
        expect(() =>
          run(
            "Prepare exact WhatsApp chats",
            linked(
              Array.from({ length: 21 }, (_, i) => ({
                ...message,
                id: String(i),
                chat_id: String(i),
              })),
            )["Project bounded WhatsApp message page"],
            linked(),
          ),
        ).toThrow();
      });
      it("skips explicit group and broadcast lookups while stripping their unverified attendees", () => {
        for (const suffix of ["@g.us", "@broadcast"]) {
          const grouped = {
            ...message,
            chat_provider_id: "fictional" + suffix,
          };
          const context = {
            ...linked([grouped]),
            "Prepare exact WhatsApp chats": [[{ _chat_lookup: false }]],
          };
          expect(
            run(
              "Prepare exact WhatsApp chats",
              context["Project bounded WhatsApp message page"],
              context,
            ),
          ).toEqual([{ json: { _chat_lookup: false } }]);
          const result = run(
            "Verify exact WhatsApp membership",
            [{ _chat_lookup: false }],
            context,
          ) as {
            json: {
              body: { items: Record<string, unknown>[]; cursor: string };
            };
          }[];
          expect(result[0]!.json.body.cursor).toBe("next");
          expect(result[0]!.json.body.items[0]).not.toHaveProperty("attendees");
          expect(
            normalizeUnipileMessage(
              result[0]!.json.body.items[0],
              {
                principal_id: "fictional-owner",
                account_id: "fictional-account",
                owner_identity: owner,
                now: new Date("2026-10-14T12:00:00Z"),
                authenticated: {
                  provider: "unipile",
                  account_id: "fictional-account",
                },
              },
              source,
            ),
          ).toMatchObject({
            kind: "accepted",
            record: { attribution: "unknown", eligible_for_extraction: false },
          });
          const mixed = linked([message, grouped]);
          expect(
            run(
              "Prepare exact WhatsApp chats",
              mixed["Project bounded WhatsApp message page"],
              mixed,
            ),
          ).toEqual([{ json: { _chat_lookup: false } }]);
        }
      });
      it("rejects dot-only chat IDs before an exact chat request can normalize its path", () => {
        for (const chat_id of [".", ".."])
          expect(() =>
            run(
              "Prepare exact WhatsApp chats",
              linked([{ ...message, chat_id }])[
                "Project bounded WhatsApp message page"
              ],
              linked(),
            ),
          ).toThrow("Unbound WhatsApp message");
      });
      const enriched = (response: unknown, items: unknown[] = [message]) =>
        (
          run(
            "Verify exact WhatsApp membership",
            [response],
            linked(items),
          ) as {
            json: {
              body: { items: Record<string, unknown>[]; cursor: string };
            };
          }[]
        )[0]!.json;
      it("replaces spoofed attendees with authenticated direct owner and opaque peer", () => {
        const out = enriched({ statusCode: 200, body: chat });
        expect(out.body.cursor).toBe("next");
        expect(out.body.items[0]?.attendees).toEqual([
          { attendee_provider_id: owner },
          { attendee_provider_id: peer },
        ]);
        expect(
          enriched({ statusCode: 200, body: chat }, [
            { ...message, sender_id: peer, is_sender: 0 },
          ]).body.items[0]?.attendees,
        ).toHaveLength(2);
      });
      it("retains phone-JID versus LID uncertainty without merging identities or blocking verified neighbors", () => {
        for (const [messageProvider, chatProvider] of [
          ["15550000099@s.whatsapp.net", "999999999@lid"],
          ["999999999@lid", "15550000099@s.whatsapp.net"],
        ])
          for (const sent of [true, false]) {
            const uncertain = {
              ...message,
              chat_provider_id: messageProvider,
              is_sender: sent ? 1 : 0,
              sender_id: sent ? "88888888@lid" : peer,
            };
            const neighbor = {
              ...message,
              id: "m2",
              chat_provider_id: chatProvider,
            };
            const out = enriched(
              { statusCode: 200, body: { ...chat, provider_id: chatProvider } },
              [uncertain, neighbor],
            );
            expect(out.body.cursor).toBe("next");
            expect(out.body.items[0]).not.toHaveProperty("attendees");
            expect(out.body.items[1]?.attendees).toHaveLength(2);
            const context = {
              principal_id: "fictional-owner",
              account_id: "fictional-account",
              owner_identity: owner,
              now: new Date("2026-10-14T12:00:00Z"),
              authenticated: {
                provider: "unipile" as const,
                account_id: "fictional-account",
              },
            };
            expect(
              normalizeUnipileMessage(out.body.items[0], context, source),
            ).toMatchObject({
              kind: "accepted",
              record: {
                attribution: "unknown",
                eligible_for_extraction: false,
              },
            });
            expect(
              normalizeUnipileMessage(out.body.items[1], context, source),
            ).toMatchObject({
              kind: "accepted",
              record: { attribution: "direct", eligible_for_extraction: true },
            });
          }
        for (const chat_provider_id of [
          undefined,
          "foreign",
          "x@s.whatsapp.net",
        ])
          expect(
            enriched({ statusCode: 200, body: chat }, [
              { ...message, chat_provider_id },
            ]),
          ).toMatchObject({
            statusCode: 599,
            body: { error: "whatsapp_chat_provider_mismatch" },
          });
      });
      it("keeps outgoing opaque self chats unknown instead of inventing a peer", () => {
        const out = enriched({ statusCode: 200, body: chat }, [
          { ...message, sender_id: peer, is_sender: 1 },
          { ...message, sender_id: peer, is_sender: true },
        ]);
        for (const item of out.body.items)
          expect(item).not.toHaveProperty("attendees");
      });
      it("keeps groups, missing or conflicting proof and failed chat reads ineligible", () => {
        for (const replacement of [
          { type: 1 },
          { type: 2 },
          { type: 99 },
          { attendee_provider_id: owner },
          { attendee_provider_id: null },
        ])
          expect(
            enriched({ statusCode: 200, body: { ...chat, ...replacement } })
              .body.items[0],
          ).not.toHaveProperty("attendees");
        for (const response of [{ statusCode: 404, body: {} }])
          expect(enriched(response).body.items[0]).not.toHaveProperty(
            "attendees",
          );
        expect(
          enriched({ statusCode: 200, body: chat }, [
            { ...message, is_sender: 0, sender_id: "foreign" },
          ]).body.items[0],
        ).not.toHaveProperty("attendees");
        expect(
          enriched({ statusCode: 200, body: chat }, [
            { ...message, is_sender: 1, sender_id: "15550000099" },
          ]).body.items[0],
        ).not.toHaveProperty("attendees");
      });
      it("blocks transient failures and foreign chat proof before committing a cursor", () => {
        for (const response of [
          { error: "timeout" },
          { statusCode: 503, body: {} },
          ...[
            { id: "foreign" },
            { account_id: "foreign" },
            { account_type: "LINKEDIN" },
            { provider_id: "foreign" },
            { attendee_provider_id: "bad\npeer" },
          ].map((v) => ({ statusCode: 200, body: { ...chat, ...v } })),
        ])
          expect(enriched(response)).toMatchObject({
            statusCode: 599,
            body: { error: expect.stringMatching(/^whatsapp_chat_[a-z_]+$/) },
          });
      });
      it("preserves only bounded Retry-After on a rate-limited chat lookup", () => {
        for (const key of ["retry-after", "Retry-After"])
          for (const value of ["60", "x".repeat(128), "x".repeat(129), 60]) {
            const out = enriched({
              statusCode: 429,
              headers: { [key]: value, secret: "private" },
              body: { error: "private" },
            });
            const headers =
              typeof value === "string" && value.length <= 128
                ? { headers: { "Retry-After": value } }
                : {};
            expect(out).toEqual({
              statusCode: 429,
              body: { error: "whatsapp_chat_rate_limited" },
              ...headers,
            });
          }
      });
      it("prioritizes rate limits across a bounded mixed-failure chat batch", () => {
        const context = {
          ...linked([message, { ...message, chat_id: "c2" }]),
          "Prepare exact WhatsApp chats": [
            [
              { _chat_lookup: true, chat_id: "c1" },
              { _chat_lookup: true, chat_id: "c2" },
            ],
          ],
        };
        const limited = {
          statusCode: 429,
          headers: { "Retry-After": "60", secret: "private" },
          body: { error: "private" },
        };
        for (const failed of [
          { statusCode: 500, body: {} },
          { error: { code: "ECONNABORTED", message: "private" } },
        ])
          for (const batch of [
            [failed, limited],
            [limited, failed],
          ])
            expect(
              run("Verify exact WhatsApp membership", batch, context),
            ).toEqual([
              {
                json: {
                  statusCode: 429,
                  body: { error: "whatsapp_chat_rate_limited" },
                  headers: { "Retry-After": "60" },
                },
              },
            ]);
        expect(
          run(
            "Verify exact WhatsApp membership",
            [
              limited,
              { statusCode: 200, body: { ignored: "x".repeat(262144) } },
            ],
            context,
          ),
        ).toEqual([
          {
            json: {
              statusCode: 599,
              body: { error: "whatsapp_chat_response_budget" },
            },
          },
        ]);
        expect(
          run("Verify exact WhatsApp membership", [limited], context),
        ).toEqual([
          {
            json: {
              statusCode: 599,
              body: { error: "whatsapp_chat_response_count" },
            },
          },
        ]);
      });
      it("honors the longest bounded retry delay across every rate-limited chat", () => {
        const context = {
          ...linked([message, { ...message, chat_id: "c2" }]),
          "Prepare exact WhatsApp chats": [
            [
              { _chat_lookup: true, chat_id: "c1" },
              { _chat_lookup: true, chat_id: "c2" },
            ],
          ],
        };
        const date = new Date(Date.now() + 120000).toUTCString();
        for (const [a, b, expected] of [
          ["60", "120", "120"],
          ["60", date, date],
          ["invalid", "120", "120"],
          ["x".repeat(129), "120", "120"],
          ["60", "999999", "999999"],
          ["0", "2", "2"],
          ["1".repeat(128), "120", "1".repeat(128)],
        ])
          for (const pair of [
            [a, b],
            [b, a],
          ]) {
            const batch = pair.map((value) => ({
              statusCode: 429,
              headers: { "Retry-After": value, secret: "private" },
              body: { error: "private" },
            }));
            expect(
              run("Verify exact WhatsApp membership", batch, context),
            ).toEqual([
              {
                json: {
                  statusCode: 429,
                  body: { error: "whatsapp_chat_rate_limited" },
                  headers: { "Retry-After": expected },
                },
              },
            ]);
          }
      });
      it("reports fixed private-data-free reasons for every blocked membership branch", () => {
        for (const [response, reason] of [
          [
            { error: "private provider details" },
            "whatsapp_chat_transport_failed",
          ],
          [{ statusCode: 429, body: {} }, "whatsapp_chat_rate_limited"],
          [{ statusCode: 503, body: {} }, "whatsapp_chat_http_failed"],
          [
            { statusCode: 200, body: { ...chat, account_id: "foreign" } },
            "whatsapp_chat_identity_mismatch",
          ],
          [
            {
              statusCode: 200,
              body: { ...chat, attendee_provider_id: "bad\npeer" },
            },
            "whatsapp_chat_peer_invalid",
          ],
          [
            { statusCode: 200, body: { ...chat, provider_id: "foreign" } },
            "whatsapp_chat_provider_mismatch",
          ],
          [
            { statusCode: 200, body: { ...chat, ignored: "x".repeat(262144) } },
            "whatsapp_chat_response_budget",
          ],
        ] as const) {
          expect(enriched(response)).toEqual({
            statusCode: reason === "whatsapp_chat_rate_limited" ? 429 : 599,
            body: { error: reason },
          });
        }
        expect(run("Verify exact WhatsApp membership", [], linked())).toEqual([
          {
            json: {
              statusCode: 599,
              body: { error: "whatsapp_chat_response_count" },
            },
          },
        ]);
      });
      it("promotes only verified direct chats through the shared normalizer", () => {
        const context = {
          principal_id: "fictional-owner",
          account_id: "fictional-account",
          owner_identity: owner,
          now: new Date("2026-10-14T12:00:00Z"),
          authenticated: {
            provider: "unipile" as const,
            account_id: "fictional-account",
          },
        };
        expect(
          normalizeUnipileMessage(
            enriched({ statusCode: 200, body: chat }).body.items[0],
            context,
            source,
          ),
        ).toMatchObject({
          kind: "accepted",
          record: { attribution: "direct", eligible_for_extraction: true },
        });
        expect(
          normalizeUnipileMessage(
            enriched({ statusCode: 200, body: { ...chat, type: 1 } }).body
              .items[0],
            context,
            source,
          ),
        ).toMatchObject({
          kind: "accepted",
          record: { attribution: "unknown", eligible_for_extraction: false },
        });
      });
      it("retains outer page indexes, bounds aggregate bytes and validates chat origin", () => {
        const selected = linked();
        for (const port of [443, 13111, 16860]) {
          const context = {
            ...selected,
            "Plan selected provider page": {
              ...ctx,
              plan: {
                ...ctx.plan,
                url: `https://api38.unipile.com:${port}/api/v1/messages?account_id=fictional-account`,
              },
            },
          };
          expect(
            run(
              "Prepare exact WhatsApp chats",
              context["Project bounded WhatsApp message page"],
              context,
            ),
          ).toHaveLength(1);
        }
        for (const url of [
          "https://api38.unipile.com:16861/api/v1/messages?a=1",
          "https://attacker@api38.unipile.com:16860/api/v1/messages?a=1",
          "https://api38.unipile.com:16860/api/v1/accounts/foreign",
          "https://api38.unipile.com:16860/api/v1/messages?a=1#fragment",
        ]) {
          const context = {
            ...selected,
            "Plan selected provider page": {
              ...ctx,
              plan: { ...ctx.plan, url },
            },
          };
          expect(() =>
            run(
              "Prepare exact WhatsApp chats",
              context["Project bounded WhatsApp message page"],
              context,
            ),
          ).toThrow();
        }
        const later = Object.fromEntries(
          Object.entries(selected).map(([key, value]) => [
            key,
            key === "Prepare exact WhatsApp chats"
              ? [[], (value as unknown[])[0]]
              : [{}, value],
          ]),
        );
        expect(
          run(
            "Verify exact WhatsApp membership",
            [{ statusCode: 200, body: chat }],
            later,
            1,
          ),
        ).toEqual([{ json: enriched({ statusCode: 200, body: chat }) }]);
        expect(
          enriched({
            statusCode: 200,
            body: { ...chat, ignored: "x".repeat(262144) },
          }),
        ).toMatchObject({ statusCode: 599 });
        expect(() =>
          run(
            "Prepare exact WhatsApp chats",
            selected["Project bounded WhatsApp message page"],
            {
              ...selected,
              "Plan selected provider page": { ...ctx, max_result_bytes: 10 },
            },
          ),
        ).toThrow();
      });
      it("preserves failed provider page status without starting chat reads", () => {
        const context = {
          ...linked(),
          "Project bounded WhatsApp message page": {
            statusCode: 429,
            body: { error: "limited" },
            headers: { "retry-after": "5" },
          },
        };
        expect(
          run(
            "Prepare exact WhatsApp chats",
            context["Project bounded WhatsApp message page"],
            context,
          ),
        ).toEqual([{ json: { _chat_lookup: false } }]);
        expect(run("Verify exact WhatsApp membership", [{}], context)).toEqual([
          { json: context["Project bounded WhatsApp message page"] },
        ]);
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
