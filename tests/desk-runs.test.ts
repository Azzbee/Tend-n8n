import { describe, expect, it, vi } from "vitest";
import {
  createWorkflowRunsReader,
  dockerRunner,
  exportedWorkflowNames,
  insightsScript,
  runsFromRows,
} from "../src/desk-runs.ts";
import { buildDeskRuns } from "../src/desk-model.ts";

const names = exportedWorkflowNames();
const gmail = [...names].find(([, id]) => id === "11")![0];
const daily = [...names].find(([, id]) => id === "20")![0];

describe("workflow run reader", () => {
  it("maps exported workflow names to catalog IDs and ignores probes and copies", () => {
    expect(names.get(gmail)).toBe("11");
    expect(names.size).toBe(29);
    expect(names.get("Tend private scheduled business bounded polling")).toBe(
      "19",
    );
    const runs = runsFromRows(
      [
        {
          name: gmail,
          last_success: "2026-10-22 07:00:00.000",
          last_failure: "2026-10-22 08:30:00.000",
        },
        {
          name: daily,
          last_success: "2026-10-22 07:00:01",
          last_failure: null,
        },
        {
          name: "Probe: Gmail diagnostics",
          last_success: "2026-10-22 09:00:00",
          last_failure: null,
        },
        {
          name: gmail + " (copy)",
          last_success: "2026-10-22 09:00:00",
          last_failure: null,
        },
      ],
      names,
    );
    expect(runs).toEqual([
      {
        id: "11",
        name: "11",
        lane: "private",
        last_status: "error",
        last_run_at: "2026-10-22T08:30:00.000Z",
      },
      {
        id: "20",
        name: "20",
        lane: "private",
        last_status: "success",
        last_run_at: "2026-10-22T07:00:01.000Z",
      },
    ]);
  });
  it("keeps the newest row when n8n holds two workflows with the same exported name", () => {
    const runs = runsFromRows(
      [
        {
          name: gmail,
          last_success: "2026-10-21 07:00:00",
          last_failure: null,
        },
        {
          name: gmail,
          last_success: null,
          last_failure: "2026-10-22 07:00:00",
        },
      ],
      names,
    );
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ last_status: "error" });
  });
  it("feeds How it runs with real status and leaves workflows without insights unknown", () => {
    const runs = runsFromRows(
      [
        {
          name: gmail,
          last_success: "2026-10-22 07:00:00",
          last_failure: null,
        },
      ],
      names,
    );
    const view = buildDeskRuns(runs, []);
    expect(view.workflows.find((w) => w.id === "11")).toMatchObject({
      lane: "private",
      last_status: "success",
      name: "Read-only Gmail sync",
    });
    expect(view.workflows.find((w) => w.id === "12")!.last_status).toBe(
      "unknown",
    );
    expect(view.runs_connected).toBe(true);
    expect(buildDeskRuns(null, []).runs_connected).toBe(false);
  });
  it("caches for 60 seconds, shares one read, and fails closed to no run data", async () => {
    let now = 0;
    const run = vi
      .fn<(script: string, timeout: number) => Promise<string>>()
      .mockResolvedValueOnce(
        JSON.stringify([
          {
            name: gmail,
            last_success: "2026-10-22 07:00:00",
            last_failure: null,
          },
        ]),
      )
      .mockRejectedValueOnce(new Error("container down"))
      .mockResolvedValueOnce("not json");
    const read = createWorkflowRunsReader({
      run,
      names,
      clock: () => now,
      timeoutMs: 1234,
    });
    const [a, b] = await Promise.all([read(), read()]);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]![1]).toBe(1234);
    expect(a).toEqual(b);
    expect(a[0]!.last_status).toBe("success");
    now = 59_999;
    await read();
    expect(run).toHaveBeenCalledTimes(1);
    now = 60_000;
    expect(await read()).toEqual([]);
    now = 130_000;
    expect(await read()).toEqual([]);
    expect(run).toHaveBeenCalledTimes(3);
  });
  it("opens the n8n database read-only and selects only names, outcomes and times", () => {
    const script = insightsScript("/home/node/.n8n/database.sqlite");
    expect(script).toContain("readOnly: true");
    expect(script).toContain("WHEN x.type = 2 THEN x.at END) AS last_success");
    expect(script).toContain("WHEN x.type = 3 THEN x.at END) AS last_failure");
    expect(script).toMatch(/SELECT m\.workflowName AS name/);
    expect(script).not.toMatch(
      /execution_data|execution_entity|credentials|INSERT|UPDATE|DELETE|DROP/i,
    );
  });
  it("refuses container names that could become extra docker arguments", () => {
    expect(() => dockerRunner("--privileged")).toThrow();
    expect(() => dockerRunner("tend nocode")).toThrow();
    expect(() => dockerRunner("tend-nocode-live")).not.toThrow();
  });
});

describe("How it runs through the live server", () => {
  it("serves the injected last-run status on /private/api/runs", async () => {
    const { createLiveServer } = await import("../src/live-api.ts");
    const { InternalAuth } = await import("../src/internal-auth.ts");
    const { exampleLivePolicy } = await import("../src/live-policy.ts");
    const { createDeskFixtureStore } = await import("../src/desk-fixture.ts");
    const store = createDeskFixtureStore(() => new Date());
    const server = createLiveServer({
      policy: exampleLivePolicy,
      auth: new InternalAuth(),
      store,
      workflowRuns: () =>
        Promise.resolve(
          runsFromRows(
            [
              {
                name: gmail,
                last_success: null,
                last_failure: "2026-10-22 08:30:00",
              },
            ],
            names,
          ),
        ),
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("address");
      const base = `http://127.0.0.1:${address.port}`;
      const page = await fetch(`${base}/private`);
      const pre = page.headers.getSetCookie()[0]!.split(";")[0]!;
      const nonce = /name="nonce" value="([^"]+)"/.exec(await page.text())![1]!;
      const unlock = await fetch(`${base}/private/unlock`, {
        method: "POST",
        redirect: "manual",
        headers: {
          origin: base,
          "content-type": "application/x-www-form-urlencoded",
          cookie: pre,
        },
        body: new URLSearchParams({ nonce }),
      });
      const session = unlock.headers
        .getSetCookie()
        .find((c) => c.startsWith("tend_private="))!
        .split(";")[0]!;
      const runs = (await (
        await fetch(`${base}/private/api/runs`, {
          headers: { cookie: session },
        })
      ).json()) as {
        workflows: {
          id: string;
          last_status: string;
          last_run_at: string | null;
        }[];
      };
      expect(runs.workflows.find((w) => w.id === "11")).toMatchObject({
        last_status: "error",
        last_run_at: "2026-10-22T08:30:00.000Z",
      });
      expect(runs.workflows.find((w) => w.id === "01")!.last_status).toBe(
        "unknown",
      );
    } finally {
      await new Promise((resolve) => server.close(resolve));
      store.close();
    }
  });
});
