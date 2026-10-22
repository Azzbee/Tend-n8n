import { describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createPrivateWebHandler } from "../src/private-web.ts";
import { exampleLivePolicy } from "../src/live-policy.ts";
import {
  createDeskFixtureStore,
  deskFixtureClock,
  deskFixtureFailures,
  deskFixtureOutreach,
} from "../src/desk-fixture.ts";
import type { DeskOptions } from "../src/desk-api.ts";
import type { OutreachItem } from "../src/desk-model.ts";

// In-memory requests: the handler only needs headers, a body stream and the local port.
const port = 18795,
  origin = `http://127.0.0.1:${port}`,
  owner = exampleLivePolicy.principal_id;
interface Result {
  status: number;
  headers: Record<string, unknown>;
  body: string;
  json: () => Record<string, unknown>;
}
type Handler = ReturnType<typeof createPrivateWebHandler>;
async function call(
  handler: Handler,
  method: string,
  path: string,
  options: { headers?: Record<string, string>; body?: string } = {},
): Promise<Result> {
  const req = Readable.from(
    options.body ? [Buffer.from(options.body)] : [],
  ) as unknown as IncomingMessage;
  Object.assign(req, {
    method,
    url: path,
    headers: { host: `127.0.0.1:${port}`, ...options.headers },
  });
  const out: Result = {
    status: 0,
    headers: {},
    body: "",
    json: () => JSON.parse(out.body) as Record<string, unknown>,
  };
  const res = {
    socket: { localPort: port },
    setHeader(k: string, v: unknown) {
      out.headers[k.toLowerCase()] = v;
    },
    writeHead(status: number, headers: Record<string, unknown> = {}) {
      out.status = status;
      for (const [k, v] of Object.entries(headers))
        out.headers[k.toLowerCase()] = v;
    },
    end(chunk?: string | Buffer) {
      if (chunk) out.body += chunk.toString();
    },
  } as unknown as ServerResponse;
  expect(await handler(req, res)).toBe(true);
  return out;
}
const cookieValue = (
  headers: Record<string, unknown>,
  name: string,
): string => {
  const raw = headers["set-cookie"];
  const list = Array.isArray(raw) ? raw : [raw];
  const hit = list.find((c) => String(c).startsWith(name + "="));
  return String(hit).split(";")[0]!.split("=")[1]!;
};
async function unlocked(options: DeskOptions = {}) {
  const store = createDeskFixtureStore();
  const handler = createPrivateWebHandler({
    store,
    policy: exampleLivePolicy,
    clock: deskFixtureClock,
    ...options,
  });
  const page = await call(handler, "GET", "/private");
  const nonce = /name="nonce" value="([^"]+)"/.exec(page.body)![1]!;
  const unlock = await call(handler, "POST", "/private/unlock", {
    headers: {
      origin,
      "content-type": "application/x-www-form-urlencoded",
      cookie: `tend_pre=${cookieValue(page.headers, "tend_pre")}`,
    },
    body: new URLSearchParams({ nonce }).toString(),
  });
  expect(unlock.status).toBe(303);
  const cookie = `tend_private=${cookieValue(unlock.headers, "tend_private")}`;
  const csrf = String(
    (
      await call(handler, "GET", "/private/api/session", {
        headers: { cookie },
      })
    ).json().csrf,
  );
  const get = (path: string) =>
    call(handler, "GET", path, { headers: { cookie } });
  const post = (
    path: string,
    data: unknown,
    extra: Record<string, string> = {},
  ) =>
    call(handler, "POST", path, {
      headers: {
        cookie,
        origin,
        "content-type": "application/json",
        "x-tend-csrf": csrf,
        ...extra,
      },
      body: JSON.stringify(data),
    });
  return { store, handler, get, post, cookie };
}
const auth = {
  owner_id: owner,
  user_id: "live-owner",
  chat_id: "live-private",
  chat_type: "private",
};

describe("desk routes", () => {
  it("require an unlocked session", async () => {
    const { handler, store } = await unlocked();
    try {
      for (const path of ["/private/api/desk", "/private/api/runs"])
        expect((await call(handler, "GET", path)).status).toBe(401);
    } finally {
      store.close();
    }
  });
  it("serve the desk snapshot with no-store headers and the fictional groups", async () => {
    const { get, store } = await unlocked({
      failureLog: () => Promise.resolve(deskFixtureFailures),
    });
    try {
      const res = await get("/private/api/desk");
      expect(res.status).toBe(200);
      expect(res.headers["cache-control"]).toBe("no-store");
      const desk = res.json() as Record<string, { record_id: string }[]>;
      expect(desk.you_owe!.map((c) => c.record_id)).toEqual(["g2"]);
      expect(desk.pending!.map((c) => c.record_id)).toEqual(["li1"]);
      expect(desk.held_back!.map((c) => c.record_id)).toEqual(["g-injection"]);
      expect(JSON.stringify(desk.pipeline)).toContain("1 failure logged");
    } finally {
      store.close();
    }
  });
  it("confirm through the same /confirm command as Telegram, with the chosen date", async () => {
    const { post, store } = await unlocked();
    try {
      const spy = vi.spyOn(store, "command");
      const id = store
        .commitments(owner)
        .find((c) => c.status === "pending")!.commitment_id;
      const res = await post("/private/api/desk/confirm", {
        id,
        due_date: "2026-10-17",
      });
      expect(res.status).toBe(200);
      expect(spy).toHaveBeenCalledWith({
        ...auth,
        text: `/confirm ${id} 2026-10-17`,
      });
      expect(
        store.commitments(owner).find((c) => c.commitment_id === id),
      ).toMatchObject({
        status: "confirmed",
        due_date: "2026-10-17",
      });
      const again = await post("/private/api/desk/dismiss", { id });
      expect(again.status).toBe(409);
      expect(again.json().error).toBe("Not changed: invalid transition.");
    } finally {
      store.close();
    }
  });
  it("dismiss and mark done through /dismiss and /done", async () => {
    const { post, store } = await unlocked();
    try {
      const spy = vi.spyOn(store, "command");
      const pending = store
        .commitments(owner)
        .find((c) => c.status === "pending")!;
      expect(
        (await post("/private/api/desk/dismiss", { id: pending.commitment_id }))
          .status,
      ).toBe(200);
      expect(spy).toHaveBeenLastCalledWith({
        ...auth,
        text: `/dismiss ${pending.commitment_id}`,
      });
      const owe = store
        .commitments(owner)
        .find((c) => c.direction === "owed_by_me")!;
      expect(
        (await post("/private/api/desk/done", { id: owe.commitment_id }))
          .status,
      ).toBe(200);
      expect(
        store
          .commitments(owner)
          .map((c) => c.status)
          .sort(),
      ).toEqual(["confirmed", "dismissed", "done"]);
    } finally {
      store.close();
    }
  });
  it("reject missing CSRF, bad IDs, bad dates and extra fields without touching the ledger", async () => {
    const { post, store } = await unlocked();
    try {
      const spy = vi.spyOn(store, "command");
      const id = store
        .commitments(owner)
        .find((c) => c.status === "pending")!.commitment_id;
      expect(
        (
          await post(
            "/private/api/desk/dismiss",
            { id },
            { "x-tend-csrf": "wrong" },
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await post(
            "/private/api/desk/dismiss",
            { id },
            { origin: "http://evil.invalid" },
          )
        ).status,
      ).toBe(403);
      expect(
        (await post("/private/api/desk/dismiss", { id: "C1 /done C2" })).status,
      ).toBe(400);
      expect(
        (await post("/private/api/desk/confirm", { id, due_date: "tomorrow" }))
          .status,
      ).toBe(400);
      expect((await post("/private/api/desk/confirm", { id })).status).toBe(
        400,
      );
      expect(
        (await post("/private/api/desk/dismiss", { id, extra: 1 })).status,
      ).toBe(400);
      expect(
        (
          await post("/private/api/desk/confirm", {
            id: "Cnope",
            due_date: "2026-10-17",
          })
        ).json().error,
      ).toBe("Not changed: unknown commitment.");
      expect(spy).toHaveBeenCalledTimes(1);
      expect(
        store.commitments(owner).find((c) => c.commitment_id === id)!.status,
      ).toBe("pending");
    } finally {
      store.close();
    }
  });
  it("list both lanes and the redacted failure log, and say when the log is not connected", async () => {
    const connected = await unlocked({
      failureLog: () => Promise.resolve(deskFixtureFailures),
      workflowRuns: () =>
        Promise.resolve([
          {
            id: "07",
            name: "x",
            lane: "classroom",
            last_status: "error",
            last_run_at: null,
          },
        ]),
    });
    const bare = await unlocked();
    try {
      const runs = (await connected.get("/private/api/runs")).json();
      expect(runs.failure_log_connected).toBe(true);
      expect(runs.failures).toEqual(deskFixtureFailures);
      expect(
        (runs.workflows as { id: string; last_status: string }[]).find(
          (w) => w.id === "07",
        )!.last_status,
      ).toBe("error");
      expect((await bare.get("/private/api/runs")).json()).toMatchObject({
        failure_log_connected: false,
        failures: [],
      });
      const failing = await unlocked({
        failureLog: () => Promise.reject(new Error("down")),
      });
      expect(
        (await failing.get("/private/api/runs")).json().failure_log_connected,
      ).toBe(false);
      failing.store.close();
    } finally {
      connected.store.close();
      bare.store.close();
    }
  });
});

describe("outreach routes", () => {
  function backend() {
    let items: OutreachItem[] = deskFixtureOutreach(deskFixtureClock());
    const update = (id: string, change: Partial<OutreachItem>) => {
      const hit = items.find((i) => i.id === id);
      if (!hit) throw new Error("unknown outreach item");
      items = items.map((i) => (i.id === id ? { ...i, ...change } : i));
      return Promise.resolve(items.find((i) => i.id === id));
    };
    return {
      list: vi.fn(() => Promise.resolve({ items })),
      approve: vi.fn((id: string) => update(id, { status: "approved" })),
      edit: vi.fn((id: string, text: string) =>
        update(id, { draft_text: text }),
      ),
      skip: vi.fn((id: string) => update(id, { status: "skipped" })),
    };
  }
  it("return 404 for every outreach route when outreach is not enabled", async () => {
    const { get, post, store } = await unlocked();
    try {
      expect((await get("/private/api/outreach")).status).toBe(404);
      for (const verb of ["approve", "skip"])
        expect(
          (await post(`/private/api/outreach/${verb}`, { id: "OUT-F17-1" }))
            .status,
        ).toBe(404);
      expect(
        (
          await post("/private/api/outreach/edit", {
            id: "OUT-F17-1",
            text: "Hi",
          })
        ).status,
      ).toBe(404);
    } finally {
      store.close();
    }
  });
  it("list, approve, edit and skip exactly the named draft with CSRF", async () => {
    const outreach = backend();
    const { get, post, store } = await unlocked({ outreach });
    try {
      const list = (await get("/private/api/outreach")).json();
      expect((list.items as OutreachItem[]).map((i) => i.id)).toEqual([
        "OUT-F17-1",
        "OUT-F17-2",
      ]);
      expect(
        (
          await post(
            "/private/api/outreach/approve",
            { id: "OUT-F17-1" },
            { "x-tend-csrf": "no" },
          )
        ).status,
      ).toBe(403);
      expect(outreach.approve).not.toHaveBeenCalled();
      expect(
        (
          await post("/private/api/outreach/approve", { id: "OUT-F17-1" })
        ).json().item,
      ).toMatchObject({ status: "approved" });
      expect(outreach.approve).toHaveBeenCalledWith("OUT-F17-1");
      expect(
        (
          await post("/private/api/outreach/edit", {
            id: "OUT-F17-2",
            text: "Hi Mira, thanks.",
          })
        ).status,
      ).toBe(200);
      expect(outreach.edit).toHaveBeenCalledWith(
        "OUT-F17-2",
        "Hi Mira, thanks.",
      );
      expect(
        (await post("/private/api/outreach/skip", { id: "OUT-F17-2" })).status,
      ).toBe(200);
      expect(
        (
          await post("/private/api/outreach/edit", {
            id: "OUT-F17-2",
            text: "  ",
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await post("/private/api/outreach/edit", {
            id: "OUT-F17-2",
            text: "x".repeat(2001),
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await post("/private/api/outreach/approve", {
            id: "OUT-F17-1",
            text: "x",
          })
        ).status,
      ).toBe(400);
      expect(
        (await post("/private/api/outreach/approve", { id: "missing" })).status,
      ).toBe(409);
      expect(outreach.edit).toHaveBeenCalledTimes(1);
    } finally {
      store.close();
    }
  });
});
