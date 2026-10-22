import { describe, it, expect } from "vitest";
import vm from "node:vm";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TendStore } from "../src/engine.ts";
import { demoAuth, fixtureRecords } from "../src/fixtures.ts";
import { buildOutreachWorkflows } from "../src/outreach-workflows.ts";
import { createPrivateOutreach } from "../src/outreach-service.ts";
import { createLiveServer } from "../src/live-api.ts";
import { InternalAuth, verificationHash } from "../src/internal-auth.ts";
import { exampleLivePolicy } from "../src/live-policy.ts";
import type { LiveStore } from "../src/live-store.ts";

const flows = buildOutreachWorkflows();
const code = (file: string, name: string): string =>
  String(
    flows
      .find((f) => f.file === file)!
      .workflow.nodes.find((n) => n.name === name)!.parameters.jsCode,
  );
type Item = { json: Record<string, unknown> };
const runCode = (src: string, ctx: Record<string, unknown>): Item[] =>
  vm.runInNewContext(`(function(){${src}})()`, ctx) as Item[];
async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

describe("fictional outreach lane over HTTP", () => {
  it("walks workflows 22 and 23 against the fixture API with zero real sends", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tend-outreach-"));
    const port = await freePort();
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      TEND_DEMO_PORT: String(port),
      TEND_DEMO_DB: join(dir, "demo.sqlite"),
      TEND_OUTREACH_DB: join(dir, "outreach.sqlite"),
    };
    delete env.TEND_SERVER_MODE;
    delete env.TEND_OUTREACH_CLOCK;
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", "src/server.ts"],
      {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdout.on("data", (d: Buffer) => {
          if (d.toString().includes("listening")) resolve();
        });
        child.on("exit", () => reject(new Error("fixture server exited")));
      });
      const base = `http://127.0.0.1:${port}`;
      const call = async (
        path: string,
        body?: unknown,
      ): Promise<{ status: number; json: Record<string, unknown> }> => {
        const r = await fetch(base + path, {
          method: body === undefined ? "GET" : "POST",
          headers: { "Content-Type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        return {
          status: r.status,
          json: (await r.json()) as Record<string, unknown>,
        };
      };
      expect(
        (await call("/api/ingest", { records: fixtureRecords, cursor: "f" }))
          .status,
      ).toBe(200);
      for (const [id, action, due] of [
        ["g1", "send the demo", "2026-10-15"],
        ["g2", "review your demo", "2026-10-16"],
      ] as const) {
        const record = fixtureRecords.find((r) => r.source_record_id === id)!;
        const c = await call("/api/candidates", {
          record,
          candidate: { quote: record.body_text, action, suggested_due: due },
        });
        const cid = (c.json.candidate as { commitment_id: string })
          .commitment_id;
        await call("/api/command", {
          ...demoAuth,
          text: `/confirm ${cid} ${due}`,
        });
      }
      // Workflow 22: plan, split, local AI (unavailable here), save, notify.
      const plan = await call("/api/outreach/plan", {});
      expect(plan.json.quiet_hours).toBe(false);
      const split = runCode(
        code("23-outreach-planner.json", "One item per proposal"),
        { $input: { first: () => ({ json: plan.json }) } },
      );
      expect(split).toHaveLength(5);
      const read = runCode(
        code("23-outreach-planner.json", "Read model text"),
        {
          $: () => ({ all: () => split }),
          $input: {
            all: () =>
              split.map(() => ({ json: { error: { message: "down" } } })),
          },
        },
      );
      for (const r of read) {
        const saved = await call("/api/outreach/draft", r.json);
        expect(saved.json).toMatchObject({ accepted: false });
      }
      const notice = runCode(code("23-outreach-planner.json", "Owner notice"), {
        $input: { all: () => read },
      });
      expect(
        (
          await call(
            "/api/mock-telegram/botFIXTURE_ONLY/sendMessage",
            notice[0]!.json,
          )
        ).json.ok,
      ).toBe(true);
      // Owner approves one email draft (Desk or /approve).
      const listed = (await call("/api/outreach")).json.items as {
        id: string;
        reason: string;
        status: string;
        text_code: string;
      }[];
      const target = listed.find((i) => i.reason === "overdue_owed_to_you")!;
      expect((await call("/api/outreach/approved-email")).json.items).toEqual(
        [],
      );
      // A web page can POST text/plain cross-origin without a preflight; the
      // fixture API must not treat that as an approval.
      const simple = await fetch(base + "/api/outreach/approve", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: JSON.stringify({ id: target.id, text_code: target.text_code }),
      });
      expect(simple.status).toBe(400);
      expect(
        (
          (await call("/api/outreach")).json.items as {
            id: string;
            status: string;
          }[]
        ).find((i) => i.id === target.id)!.status,
      ).toBe("pending");
      expect(
        (
          await call("/api/outreach/approve", {
            id: target.id,
            text_code: target.text_code,
          })
        ).json.item,
      ).toMatchObject({ status: "approved" });
      // Workflow 23: approved email only, mock drafts.create, ledger.
      const approved = await call("/api/outreach/approved-email");
      const items = runCode(
        code("24-outreach-gmail-drafts.json", "One item per approved draft"),
        { $input: { first: () => ({ json: approved.json }) } },
      );
      expect(items.map((i) => i.json.id)).toEqual([target.id]);
      const created: Item[] = [];
      for (const i of items)
        created.push({
          json: (
            await call("/api/mock-gmail/gmail/v1/users/me/drafts", {
              message: i.json.message,
            })
          ).json,
        });
      const receipts = runCode(
        code("24-outreach-gmail-drafts.json", "Read draft receipt"),
        { $: () => ({ all: () => items }), $input: { all: () => created } },
      );
      const recorded = await call(
        "/api/outreach/gmail-draft",
        receipts[0]!.json,
      );
      expect(recorded.json.item).toMatchObject({
        id: target.id,
        status: "gmail_draft_created",
      });
      // A retried node re-posts the same receipt: same item back, no second
      // draft (the ledger below still holds exactly one).
      const repeated = await call(
        "/api/outreach/gmail-draft",
        receipts[0]!.json,
      );
      expect(repeated.status).toBe(200);
      expect(repeated.json.item).toMatchObject({
        id: target.id,
        status: "gmail_draft_created",
      });
      expect(
        (
          await call("/api/outreach/gmail-draft", {
            ...receipts[0]!.json,
            draft_id: "r-mock-other",
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await call("/api/mock-gmail/gmail/v1/users/me/messages/send", {
            message: items[0]!.json.message,
          })
        ).status,
      ).toBe(404);
      const ledger = await call("/api/outreach/ledger");
      expect(ledger.json.mock_gmail_drafts).toEqual([
        expect.objectContaining({
          id: "r-mock-1",
          to: "mira@example.invalid",
          subject: "Following up",
        }),
      ]);
      expect(JSON.stringify(ledger.json)).not.toContain("attacker");
      const status = await call("/api/status");
      expect(
        (status.json.mock_telegram_replies as { text: string }[]).at(-1)!.text,
      ).toContain("5 outreach draft(s)");
    } finally {
      child.kill("SIGTERM");
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});

describe("private outreach routes", () => {
  it("require internal auth, keep sending shut by default and never expose approval", async () => {
    const policy = exampleLivePolicy;
    const clock = () => new Date("2026-10-14T10:00:00Z");
    const store = new TendStore(":memory:", {
      mode: "live",
      principal: {
        owner_id: policy.principal_id,
        user_id: "live-owner",
        chat_id: "live-private",
      },
      clock,
    });
    const key = "FICTIONAL_ONLY_0123456789_abcdefghijklmnopqrstuvwxyz_ABCD";
    const dbDir = mkdtempSync(join(tmpdir(), "tend-private-outreach-"));
    const outreach = createPrivateOutreach(
      store as unknown as LiveStore,
      policy.principal_id,
      { TEND_OUTREACH_DB: join(dbDir, "nested", "outreach.sqlite") },
    );
    const server = createLiveServer({
      policy,
      store,
      auth: new InternalAuth(undefined, verificationHash(key)),
      clock,
      outreach,
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const headers = {
      Authorization: "Bearer " + key,
      "Content-Type": "application/json",
    };
    try {
      expect(
        (await fetch(base + "/api/live/outreach/approved-email")).status,
      ).toBe(401);
      const plan = await fetch(base + "/api/live/outreach/plan", {
        method: "POST",
        headers,
        body: "{}",
      });
      expect(plan.status).toBe(200);
      expect(await plan.json()).toMatchObject({
        fictional: false,
        created: [],
      });
      const ready = await fetch(base + "/api/live/outreach/approved-email", {
        headers,
      });
      expect(await ready.json()).toEqual({ enabled: false, items: [] });
      for (const action of ["approve", "edit", "skip"])
        expect(
          (
            await fetch(base + "/api/live/outreach/" + action, {
              method: "POST",
              headers,
              body: JSON.stringify({ id: "O0123456789" }),
            })
          ).status,
        ).toBe(404);
      expect(
        (
          await fetch(base + "/api/live/outreach/plan", {
            method: "POST",
            headers,
            body: JSON.stringify({ now: "2026-10-17T07:00:00Z" }),
          })
        ).status,
      ).toBeGreaterThanOrEqual(400);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      outreach.service.book.close();
      rmSync(dbDir, { recursive: true, force: true });
    }
  });
});

describe("private outreach kill switch", () => {
  it("opens the send path only for OUTREACH_ENABLED=true exactly", () => {
    const store = new TendStore(":memory:", {
      mode: "live",
      principal: {
        owner_id: exampleLivePolicy.principal_id,
        user_id: "live-owner",
        chat_id: "live-private",
      },
    });
    const enabled = (value: string | undefined): boolean => {
      const env: Record<string, string | undefined> = {
        TEND_OUTREACH_DB: ":memory:",
      };
      if (value !== undefined) env.OUTREACH_ENABLED = value;
      const { service } = createPrivateOutreach(
        store as unknown as LiveStore,
        exampleLivePolicy.principal_id,
        env,
      );
      try {
        return service.book.options.sendingEnabled;
      } finally {
        service.book.close();
      }
    };
    expect(enabled(undefined)).toBe(false);
    for (const off of ["false", "", "1", "yes", "TRUE", " true"])
      expect(enabled(off)).toBe(false);
    expect(enabled("true")).toBe(true);
    store.close();
  });
});
