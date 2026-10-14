import { describe, expect, it } from "vitest";
import {
  planSocialProviderRead,
  mapSocialProviderResponse,
  linkedInChangeCursor,
  type ProviderReadPlan,
} from "../src/social-provider-reads.ts";
import { parseSocialPolicy, type SocialPolicy } from "../src/social-policy.ts";
import type { SourceState } from "../src/engine.ts";
const now = new Date("2026-10-14T12:00:00Z");
const policy = parseSocialPolicy({
  window_days: 30,
  accounts: [
    {
      source: "whatsapp_personal",
      provider: "unipile",
      account_id: "personal-one",
      owner_identity: "33123456789",
      owner_verified: true,
      api_base_url: "https://api1.unipile.com:13111",
    },
    {
      source: "linkedin",
      provider: "linkedin",
      account_id: "urn:li:person:owner",
      owner_identity: "urn:li:person:owner",
      owner_verified: true,
      profile_bindings: [],
    },
    {
      source: "whatsapp_business",
      provider: "meta",
      account_id: "waba-one",
      owner_identity: "33987654321",
      owner_verified: true,
      business_phone_number_id: "phone-one",
    },
  ],
}) as SocialPolicy;
const state = (
  source: SourceState["source"] = "whatsapp_personal",
  cursor: string | null = null,
): SourceState => ({
  owner_id: "owner",
  source,
  account_id:
    source === "linkedin"
      ? "urn:li:person:owner"
      : source === "whatsapp_business"
        ? "waba-one"
        : "personal-one",
  mode: "live",
  last_success: null,
  status: "syncing",
  coverage_start: "2026-09-14T12:00:00.000Z",
  coverage_end: now.toISOString(),
  cursor,
});
const plan = (
  source: SourceState["source"] = "whatsapp_personal",
  phase: "identity" | "snapshot" | "changes" | "connections" = "snapshot",
  cursor: string | null = null,
): ProviderReadPlan => {
  const s = state(source, cursor);
  const p = planSocialProviderRead(
    policy,
    source as "whatsapp_personal",
    s.account_id,
    s,
    phase,
    now,
  );
  if (p.kind !== "request") throw new Error("expected request");
  return p;
};
const page = (start = 0, next: string | undefined = undefined) => ({
  paging: {
    start,
    count: 10,
    total: 1,
    links: next ? [{ rel: "next", href: next }] : [],
  },
  elements: [
    {
      snapshotDomain: "INBOX",
      snapshotData: [
        {
          "CONVERSATION ID": "thread-one",
          FROM: "Mira",
          TO: "Owner",
          DATE: "2026-10-13T10:00:00Z",
          CONTENT: "Hello",
        },
      ],
    },
  ],
});
describe("official read-only social plans", () => {
  it("propagates only exact chat failures for the Unipile message operation", () => {
    const reasons = [
      "whatsapp_chat_response_count",
      "whatsapp_chat_response_budget",
      "whatsapp_chat_transport_failed",
      "whatsapp_chat_http_failed",
      "whatsapp_chat_identity_mismatch",
      "whatsapp_chat_peer_invalid",
      "whatsapp_chat_provider_mismatch",
    ];
    for (const reason of reasons)
      expect(mapSocialProviderResponse(plan(), 599, { error: reason })).toEqual(
        { kind: "quarantined", reason },
      );
    expect(
      mapSocialProviderResponse(plan(), 429, {
        error: "whatsapp_chat_rate_limited",
      }),
    ).toEqual({ kind: "quarantined", reason: "whatsapp_chat_rate_limited" });
    for (const [p, status, error] of [
      [plan(), 599, "whatsapp_chat_unknown"],
      [plan(), 599, "whatsapp_chat_rate_limited"],
      [plan(), 429, "whatsapp_chat_transport_failed"],
      [plan(), 503, "whatsapp_chat_transport_failed"],
      [plan("whatsapp_personal", "identity"), 599, reasons[0]],
      [plan("linkedin"), 599, reasons[0]],
      [{ ...plan(), source: "linkedin" }, 599, reasons[0]],
      [{ ...plan(), operation: "unipile.accounts.get" }, 599, reasons[0]],
    ] as const)
      expect(mapSocialProviderResponse(p, status, { error })).toEqual({
        kind: "quarantined",
        reason: "provider_read_failed",
      });
  });

  it.each(["current", "partial"])(
    "allows identity verification after an idle %s window expires",
    (status) => {
      const old = {
        ...state(),
        status,
        coverage_start: "2026-08-13T12:00:00.000Z",
        coverage_end: "2026-09-12T12:00:00.000Z",
      };
      expect(
        planSocialProviderRead(
          policy,
          "whatsapp_personal",
          old.account_id,
          old,
          "identity",
          now,
        ),
      ).toMatchObject({
        kind: "request",
        response_kind: "unipile_account",
      });
      expect(() =>
        planSocialProviderRead(
          policy,
          "whatsapp_personal",
          old.account_id,
          old,
          "snapshot",
          now,
        ),
      ).toThrow("unapproved_provider_window");
    },
  );
  it("plans CONNECTIONS using a separate session cursor, never INBOX persistent state", () => {
    const sourceState = state("linkedin", "li-snapshot:7");
    const p = planSocialProviderRead(
      policy,
      "linkedin",
      sourceState.account_id,
      sourceState,
      "connections",
      now,
      20,
      "li-connections:2",
    );
    if (p.kind !== "request") throw new Error("expected request");
    const url = new URL(p.url);
    expect(url.searchParams.get("domain")).toBe("CONNECTIONS");
    expect(url.searchParams.get("start")).toBe("2");
    expect(p.headers["Linkedin-Version"]).toBe("202312");
    expect(p.expected_cursor).toBe("li-connections:2");
    expect(sourceState.cursor).toBe("li-snapshot:7");
  });
  it("returns bounded CONNECTIONS rows for transient owner review without message evidence", () => {
    const p = plan("linkedin", "connections");
    const response = {
      paging: { start: 0, count: 10, total: 1, links: [] },
      elements: [
        {
          snapshotDomain: "CONNECTIONS",
          snapshotData: [
            {
              "First Name": "Mira",
              "Last Name": "Tan",
              URL: "https://www.linkedin.com/in/mira",
              "Connected On": "01 Oct 2026",
            },
          ],
        },
      ],
    };
    const result = mapSocialProviderResponse(p, 200, response);
    expect(result).toMatchObject({
      kind: "connections",
      next_cursor: "li-connections:1",
      complete: false,
      identity_bindings_verified: false,
      requires_owner_review: true,
      rows: [
        {
          "First Name": "Mira",
          "Last Name": "Tan",
          "Connected On": "01 Oct 2026",
        },
      ],
      schema_verified: false,
      unknown_field_count: 1,
    });
    expect(result).not.toHaveProperty("request");
    expect(
      mapSocialProviderResponse(p, 200, {
        ...response,
        elements: [{ snapshotDomain: "INBOX", snapshotData: [] }],
      }).kind,
    ).toBe("quarantined");
  });
  it("limits transient previews to twenty rows and 512 UTF8 bytes per value", () => {
    const p = plan("linkedin", "connections");
    const data = Array.from({ length: 21 }, () => ({
      "First Name": "界".repeat(300),
      Position: "Builder",
      credential: "not-for-preview",
    }));
    const r = mapSocialProviderResponse(p, 200, {
      paging: { start: 0, count: 10, total: 21, links: [] },
      elements: [{ snapshotDomain: "CONNECTIONS", snapshotData: data }],
    });
    expect(r.kind).toBe("connections");
    if (r.kind !== "connections") throw new Error("expected preview");
    expect(r.rows).toHaveLength(20);
    expect(r.omitted_row_count).toBe(1);
    expect(r.unknown_field_count).toBe(20);
    expect(r.truncated_value_count).toBe(20);
    for (const row of r.rows) {
      expect(Object.keys(row)).toEqual(["First Name", "Position"]);
      expect(Buffer.byteLength(row["First Name"]!)).toBeLessThanOrEqual(512);
    }
  });
  it("accepts a whole 2668-row offline CONNECTIONS page with a twenty-row preview", () => {
    const p = plan("linkedin", "connections");
    const snapshotData = Array.from({ length: 2668 }, (_, index) => ({
      "First Name": `Fictional ${index}`,
      "Last Name": "Example",
      Company: "Example company",
      Position: "Example role",
      "Connected On": "01 Oct 2026",
      URL: "https://example.invalid/profile",
      "Email Address": "fictional@example.invalid",
    }));
    const body = {
      paging: { start: 0, count: 10, total: 1, links: [] },
      elements: [{ snapshotDomain: "CONNECTIONS", snapshotData }],
    };
    const result = mapSocialProviderResponse(p, 200, body);
    expect(result).toMatchObject({
      kind: "connections",
      source: "linkedin",
      account_id: p.account_id,
      owner_identity: p.expected_owner_identity,
      omitted_row_count: 2648,
      unknown_field_count: 40,
      schema_verified: false,
      identity_bindings_verified: false,
      requires_owner_review: true,
      complete: false,
      next_cursor: "li-connections:1",
    });
    if (result.kind !== "connections") throw new Error("expected preview");
    expect(result.rows).toHaveLength(20);
    expect(Object.keys(result.rows[0]!)).toEqual([
      "First Name",
      "Last Name",
      "Company",
      "Position",
      "Connected On",
    ]);
    expect(JSON.stringify(result)).not.toContain("fictional@example.invalid");
    expect(result).not.toHaveProperty("request");
    expect(
      mapSocialProviderResponse(p, 200, {
        ...body,
        elements: [{ snapshotDomain: "INBOX", snapshotData }],
      }),
    ).toEqual({ kind: "quarantined", reason: "unexpected_snapshot_domain" });
  });
  it("bounds offline CONNECTIONS pages at ten thousand rows", () => {
    const p = plan("linkedin", "connections");
    const snapshotData = Array.from({ length: 10000 }, () => ({
      "First Name": "Example",
    }));
    const response = (rows: unknown[]) => ({
      paging: { start: 0, count: 10, total: 1, links: [] },
      elements: [{ snapshotDomain: "CONNECTIONS", snapshotData: rows }],
    });
    expect(
      mapSocialProviderResponse(p, 200, response(snapshotData)),
    ).toMatchObject({
      kind: "connections",
      omitted_row_count: 9980,
    });
    expect(
      mapSocialProviderResponse(p, 200, response([...snapshotData, {}])),
    ).toEqual({
      kind: "quarantined",
      reason: "provider_page_limit",
    });
  });
  it("retains the CONNECTIONS node, depth, byte and cycle limits", () => {
    const p = plan("linkedin", "connections");
    const body = {
      paging: { start: 0, count: 10, total: 1, links: [] },
      elements: [{ snapshotDomain: "CONNECTIONS", snapshotData: [] }],
    };
    let nested: unknown = null;
    for (let i = 0; i < 22; i++) nested = { nested };
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const extra of [
      Array.from({ length: 100001 }, () => 0),
      nested,
      "x".repeat(4 * 1024 * 1024 + 1),
    ])
      expect(mapSocialProviderResponse(p, 200, { ...body, extra })).toEqual({
        kind: "quarantined",
        reason: "provider_payload_limit",
      });
    expect(
      mapSocialProviderResponse(p, 200, { ...body, extra: cyclic }),
    ).toEqual({ kind: "quarantined", reason: "invalid_provider_cycle" });
  });
  it("keeps the INBOX thousand-row limit separate from CONNECTIONS", () => {
    expect(
      mapSocialProviderResponse(plan("linkedin"), 200, {
        paging: { start: 0, count: 10, total: 1, links: [] },
        elements: [
          {
            snapshotDomain: "INBOX",
            snapshotData: Array.from({ length: 1001 }, () => ({})),
          },
        ],
      }),
    ).toEqual({ kind: "quarantined", reason: "provider_page_limit" });
  });
  it.each([
    ["whatsapp_personal", "identity"],
    ["whatsapp_personal", "snapshot"],
    ["linkedin", "identity"],
    ["linkedin", "snapshot"],
    ["linkedin", "changes"],
  ] as const)("retains twenty thousand nodes for %s %s", (source, phase) => {
    expect(
      mapSocialProviderResponse(
        plan(
          source,
          phase,
          phase === "changes"
            ? linkedInChangeCursor(now.getTime() - 1000)
            : null,
        ),
        200,
        {
          extra: Array.from({ length: 20001 }, () => 0),
        },
      ),
    ).toEqual({ kind: "quarantined", reason: "provider_payload_limit" });
  });
  it("terminates CONNECTIONS pagination separately and rejects foreign cursor formats", () => {
    const s = state("linkedin", "li-change:1");
    expect(() =>
      planSocialProviderRead(
        policy,
        "linkedin",
        s.account_id,
        s,
        "connections",
        now,
        20,
        "li-snapshot:1",
      ),
    ).toThrow("invalid_connections_cursor");
    const p = planSocialProviderRead(
      policy,
      "linkedin",
      s.account_id,
      s,
      "connections",
      now,
      20,
      "li-connections:1",
    );
    if (p.kind !== "request") throw new Error("expected plan");
    expect(
      mapSocialProviderResponse(p, 404, {
        message: "No data found for this memberId",
      }),
    ).toMatchObject({
      kind: "connections",
      rows: [],
      next_cursor: null,
      complete: true,
      schema_verified: false,
    });
    expect(s.cursor).toBe("li-change:1");
  });
  it("keeps CONNECTIONS next links within their own domain and exact page progression", () => {
    const p = plan("linkedin", "connections");
    const response = {
      paging: {
        start: 0,
        count: 10,
        total: 1,
        links: [
          {
            rel: "next",
            href: "/rest/memberSnapshotData?q=criteria&domain=INBOX&start=1&count=10",
          },
        ],
      },
      elements: [{ snapshotDomain: "CONNECTIONS", snapshotData: [] }],
    };
    expect(mapSocialProviderResponse(p, 200, response).kind).toBe(
      "quarantined",
    );
  });
  it("labels unhandled connection changelog activity instead of silently dropping it", () => {
    const p = plan(
      "linkedin",
      "changes",
      linkedInChangeCursor(now.getTime() - 1000),
    );
    expect(
      mapSocialProviderResponse(p, 200, {
        elements: [
          {
            owner: "urn:li:person:owner",
            resourceName: "connections",
            processedAt: now.getTime(),
          },
        ],
      }),
    ).toMatchObject({
      kind: "page",
      request: { items: [] },
      metadata: {
        unhandled_activity_count: 1,
        connection_changelog_supported: false,
        connection_changelog_gap: true,
      },
    });
  });

  it("plans a bounded, account-bound Unipile GET with exclusive provider boundaries widened one millisecond", () => {
    const p = plan();
    const u = new URL(p.url);
    expect(p.method).toBe("GET");
    expect(p.follow_redirects).toBe(false);
    expect(u.pathname).toBe("/api/v1/messages");
    expect(u.searchParams.get("account_id")).toBe("personal-one");
    expect(u.searchParams.get("limit")).toBe("5");
    expect(u.searchParams.get("after")).toBe("2026-09-14T11:59:59.999Z");
    expect(u.searchParams.get("before")).toBe("2026-10-14T12:00:00.001Z");
    expect(JSON.stringify(p)).not.toContain("Authorization");
  });
  it("caps Unipile continuation pages without changing opaque cursors or anchored filters", () => {
    const cursor = "opaque-provider-cursor+/=20";
    const s = state("whatsapp_personal", cursor);
    for (const requested of [1, 5, 20, 250]) {
      const p = planSocialProviderRead(
        policy,
        "whatsapp_personal",
        s.account_id,
        s,
        "snapshot",
        now,
        requested,
      );
      if (p.kind !== "request") throw new Error("expected plan");
      const u = new URL(p.url);
      expect(p.limit).toBe(Math.min(requested, 5));
      expect(u.searchParams.get("limit")).toBe(String(p.limit));
      expect(u.searchParams.get("cursor")).toBe(cursor);
      expect(u.searchParams.get("account_id")).toBe(s.account_id);
      expect(u.searchParams.get("after")).toBe("2026-09-14T11:59:59.999Z");
      expect(u.searchParams.get("before")).toBe("2026-10-14T12:00:00.001Z");
      expect(p.expected_cursor).toBe(cursor);
      expect(p.coverage_start).toBe(s.coverage_start);
      expect(p.coverage_end).toBe(s.coverage_end);
    }
    expect(plan("linkedin", "snapshot").limit).toBe(10);
    expect(plan("linkedin", "connections").limit).toBe(10);
    expect(
      plan("linkedin", "changes", linkedInChangeCursor(now.getTime() - 1))
        .limit,
    ).toBe(50);
  });
  it("verifies the configured WhatsApp phone and healthy service statuses", () => {
    const p = plan("whatsapp_personal", "identity");
    expect(new URL(p.url).pathname).toBe("/api/v1/accounts/personal-one");
    const body = {
      object: "Account",
      id: "personal-one",
      type: "WHATSAPP",
      connection_params: { im: { phone_number: "33123456789" } },
      sources: [{ id: "service-one", status: "OK" }],
    };
    expect(mapSocialProviderResponse(p, 200, body)).toMatchObject({
      kind: "identity",
      owner_verified: true,
    });
    expect(
      mapSocialProviderResponse(p, 200, {
        ...body,
        connection_params: { im: { phone_number: "foreign" } },
      }).kind,
    ).toBe("quarantined");
    expect(
      mapSocialProviderResponse(p, 200, {
        ...body,
        sources: [{ id: "service-one", status: "CREDENTIALS" }],
      }).kind,
    ).toBe("quarantined");
  });
  it("maps only documented MessageList cursor terminality", () => {
    const p = plan();
    expect(
      mapSocialProviderResponse(p, 200, {
        object: "MessageList",
        items: [],
        cursor: null,
      }),
    ).toMatchObject({
      kind: "page",
      request: { complete: true, cursor: null },
    });
    expect(
      mapSocialProviderResponse(p, 200, {
        object: "MessageList",
        items: [],
        cursor: "next-page",
      }),
    ).toMatchObject({
      kind: "page",
      request: { complete: false, cursor: "next-page" },
    });
    expect(
      mapSocialProviderResponse(p, 200, { object: "MessageList", items: [] })
        .kind,
    ).toBe("quarantined");
  });
  it("does not accept foreign-account messages or oversized lists", () => {
    const p = plan();
    expect(
      mapSocialProviderResponse(p, 200, {
        object: "MessageList",
        items: [{ account_id: "foreign" }],
        cursor: null,
      }).kind,
    ).toBe("quarantined");
    expect(
      mapSocialProviderResponse(p, 200, {
        object: "MessageList",
        items: Array.from({ length: 251 }, () => ({
          account_id: "personal-one",
        })),
        cursor: null,
      }).kind,
    ).toBe("quarantined");
  });
  it("fixes LinkedIn domain/version and does not treat missing-next or total as completion", () => {
    const p = plan("linkedin");
    const u = new URL(p.url);
    expect(u.searchParams.get("domain")).toBe("INBOX");
    expect(p.headers["Linkedin-Version"]).toBe("202312");
    expect(mapSocialProviderResponse(p, 200, page())).toMatchObject({
      kind: "page",
      request: { complete: false, cursor: "li-snapshot:1" },
    });
  });
  it("accepts only fixed-host INBOX pagination moving forward one page", () => {
    const p = plan("linkedin");
    expect(
      mapSocialProviderResponse(
        p,
        200,
        page(
          0,
          "/rest/memberSnapshotData?q=criteria&domain=INBOX&start=1&count=10",
        ),
      ).kind,
    ).toBe("page");
    for (const href of [
      "https://evil.invalid/rest/memberSnapshotData?q=criteria&domain=INBOX&start=1",
      "/rest/memberSnapshotData?q=criteria&domain=PROFILE&start=1",
      "/rest/memberSnapshotData?q=criteria&domain=INBOX&start=0",
      "/rest/memberSnapshotData?q=criteria&domain=INBOX&start=999",
      "/rest/memberSnapshotData?q=criteria&domain=INBOX&start=1&callback=https://evil.invalid",
    ])
      expect(mapSocialProviderResponse(p, 200, page(0, href)).kind).toBe(
        "quarantined",
      );
  });
  it.each(["snapshot", "connections"] as const)(
    "recognizes the exact observed %s terminal variant only after an initial page",
    (phase) => {
      const p = {
        ...plan("linkedin", phase),
        page_start: 1,
        expected_cursor:
          phase === "connections" ? "li-connections:1" : "li-snapshot:1",
      };
      const result = mapSocialProviderResponse(p, 404, {
        status: 404,
        message: "No data found for this domain and memberId.",
      });
      if (phase === "connections") {
        expect(result).toMatchObject({
          kind: "connections",
          complete: true,
          rows: [],
          next_cursor: null,
          source: "linkedin",
          account_id: p.account_id,
          owner_identity: p.expected_owner_identity,
          identity_bindings_verified: false,
          schema_verified: false,
        });
      } else {
        expect(result).toMatchObject({
          kind: "page",
          request: {
            complete: true,
            cursor: null,
            items: [],
            source: "linkedin",
            account_id: p.account_id,
            expected_cursor: p.expected_cursor,
          },
        });
      }
      for (const status of [400, 404])
        expect(
          mapSocialProviderResponse(p, status, {
            message: "No data found for this memberId",
          }),
        ).toMatchObject({
          kind: phase === "connections" ? "connections" : "page",
        });
    },
  );
  it.each(["snapshot", "connections"] as const)(
    "keeps an initial %s page unready on the new exact terminal variant",
    (phase) => {
      expect(
        mapSocialProviderResponse(plan("linkedin", phase), 404, {
          status: 404,
          message: "No data found for this domain and memberId.",
        }),
      ).toEqual({ kind: "quarantined", reason: "snapshot_not_ready" });
    },
  );
  it.each(["snapshot", "connections"] as const)(
    "rejects near-match or wrong-status %s terminal errors",
    (phase) => {
      const p = { ...plan("linkedin", phase), page_start: 1 };
      const exact = "No data found for this domain and memberId.";
      for (const [status, body] of [
        [400, { status: 404, message: exact }],
        [404, { message: exact }],
        [404, { status: "404", message: exact }],
        [404, { status: 400, message: exact }],
        [404, { status: 404, message: exact + " " }],
        [404, { status: 404, message: exact.slice(0, -1) }],
        [404, { status: 404, message: "Resource not found" }],
      ] as const)
        expect(mapSocialProviderResponse(p, status, body)).toEqual({
          kind: "quarantined",
          reason: "provider_read_failed",
        });
    },
  );
  it("does not reinterpret another provider or LinkedIn operation's 404 as terminal", () => {
    for (const p of [
      plan(),
      plan("whatsapp_personal", "identity"),
      plan("linkedin", "identity"),
      plan("linkedin", "changes", linkedInChangeCursor(now.getTime() - 1000)),
    ]) {
      expect(
        mapSocialProviderResponse({ ...p, page_start: 1 }, 404, {
          status: 404,
          message: "No data found for this domain and memberId.",
        }),
      ).toEqual({ kind: "quarantined", reason: "provider_read_failed" });
    }
  });
  it("recognizes only the exact no-data terminal response after a valid request", () => {
    const p = plan("linkedin", "snapshot", "li-snapshot:1");
    expect(
      mapSocialProviderResponse(p, 404, {
        message: "No data found for this memberId",
      }),
    ).toMatchObject({
      kind: "page",
      request: { complete: true, cursor: null, items: [] },
    });
    expect(
      mapSocialProviderResponse(p, 500, {
        message: "No data found for this memberId",
      }).kind,
    ).toBe("quarantined");
    expect(
      mapSocialProviderResponse(p, 403, { message: "Forbidden" }).kind,
    ).toBe("quarantined");
  });
  it("does not treat an unready first snapshot page as completed history", () => {
    expect(
      mapSocialProviderResponse(plan("linkedin"), 404, {
        message: "No data found for this memberId",
      }).kind,
    ).toBe("quarantined");
  });
  it("rejects non-INBOX snapshot domains and unexpected wrappers", () => {
    const p = plan("linkedin");
    expect(
      mapSocialProviderResponse(p, 200, {
        ...page(),
        elements: [{ snapshotDomain: "PROFILE", snapshotData: [] }],
      }).kind,
    ).toBe("quarantined");
    expect(mapSocialProviderResponse(p, 200, { data: [] }).kind).toBe(
      "quarantined",
    );
  });
  it("verifies LinkedIn consent owner and returns the real consent baseline", () => {
    const p = plan("linkedin", "identity");
    expect(
      mapSocialProviderResponse(p, 200, {
        elements: [
          {
            memberComplianceAuthorizationKey: {
              member: "urn:li:person:owner",
              developerApplication: "urn:li:developerApplication:fictional",
            },
            regulatedAt: now.getTime() - 1000,
            memberComplianceScopes: ["DMA"],
          },
        ],
      }),
    ).toMatchObject({
      kind: "identity",
      owner_verified: true,
      baseline_cursor: linkedInChangeCursor(now.getTime() - 1000),
    });
  });
  it("requires a proven changelog watermark and rejects retention gaps", () => {
    expect(() => plan("linkedin", "changes")).toThrow();
    expect(() =>
      plan(
        "linkedin",
        "changes",
        linkedInChangeCursor(now.getTime() - 29 * 86400000),
      ),
    ).toThrow();
  });
  it("reports a saturated timestamp tie instead of silently polling the same page forever", () => {
    const watermark = now.getTime() - 1000;
    const p = plan("linkedin", "changes", linkedInChangeCursor(watermark));
    expect(new URL(p.url).searchParams.get("count")).toBe("50");
    const events = Array.from({ length: 50 }, (_, i) => ({
      owner: "urn:li:person:owner",
      resourceName: "messages",
      processedAt: watermark,
      activityId: `activity-${i}`,
      resourceId: `message-${i}`,
    }));
    expect(mapSocialProviderResponse(p, 200, { elements: events })).toEqual({
      kind: "quarantined",
      reason: "changelog_timestamp_tie_requires_reconciliation",
    });
    expect(
      mapSocialProviderResponse(p, 200, { elements: events.slice(0, 49) }),
    ).toMatchObject({ kind: "page", request: { complete: false } });
  });
  it("reuses processedAt inclusively without +1 and keeps empty watermark", () => {
    const cursor = linkedInChangeCursor(now.getTime() - 1000),
      p = plan("linkedin", "changes", cursor);
    expect(new URL(p.url).searchParams.get("startTime")).toBe(
      String(now.getTime() - 1000),
    );
    expect(mapSocialProviderResponse(p, 200, { elements: [] })).toMatchObject({
      kind: "page",
      request: { cursor, complete: false },
    });
    const event = {
      owner: "urn:li:person:owner",
      resourceName: "messages",
      processedAt: now.getTime(),
      capturedAt: now.getTime() - 1000,
      activityId: "activity-one",
      resourceId: "message-one",
    };
    expect(
      mapSocialProviderResponse(p, 200, { elements: [event] }),
    ).toMatchObject({
      kind: "page",
      request: {
        cursor: linkedInChangeCursor(now.getTime()),
        complete: false,
        items: [event],
      },
    });
  });
  it("never persists unrelated changelog activity and never claims gap-free completion", () => {
    const p = plan(
      "linkedin",
      "changes",
      linkedInChangeCursor(now.getTime() - 1000),
    );
    expect(
      mapSocialProviderResponse(p, 200, {
        elements: [
          {
            owner: "urn:li:person:owner",
            resourceName: "shares",
            processedAt: now.getTime(),
          },
        ],
      }),
    ).toMatchObject({ kind: "page", request: { items: [], complete: false } });
  });
  it("rejects revoked/foreign source state and invents no Meta history read", () => {
    const s = state();
    expect(() =>
      planSocialProviderRead(
        policy,
        "whatsapp_personal",
        s.account_id,
        { ...s, status: "revoked" },
        "snapshot",
        now,
      ),
    ).toThrow();
    const m = state("whatsapp_business");
    expect(
      planSocialProviderRead(
        policy,
        "whatsapp_business",
        m.account_id,
        m,
        "snapshot",
        now,
      ),
    ).toMatchObject({ kind: "webhook_only" });
  });
});
