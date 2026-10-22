import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import {
  WITHHELD,
  acceptFailure,
  createFailureLog,
  guardMessages,
  loadPrivateGuardMessages,
  redactorCode,
} from "../src/failure-redaction.ts";

const secret = "Mira Tan wrote: send the F17 contract to mira@example.test";
const run = (code: string, payload: unknown) =>
  vm.runInNewContext(`(()=>{${code}})()`, {
    $input: { first: () => ({ json: payload }) },
  }) as { json: Record<string, string> }[];
const url = "http://localhost:5678/workflow/TendGoogle11/executions/4821";
const payload = (
  message: string,
  extra: Record<string, unknown> = {},
  executionUrl: unknown = url,
) => ({
  workflow: { id: "TendGoogle11", name: "Tend 11: Read-only Gmail sync" },
  execution: {
    id: "4821",
    url: executionUrl,
    lastNodeExecuted: "Check Gmail profile",
    error: { message, stack: `Error: ${secret}\n at x`, ...extra },
  },
});

describe("private-lane failure redaction", () => {
  const allowed = ["Exact configured owner required"];
  const code = redactorCode(allowed);

  it("collects only literal guard messages, never concatenated text", () => {
    expect(
      guardMessages([
        "throw new Error('Exact configured owner required');",
        'throw new Error("bad "+record.text);',
        "throw new Error(`x ${y}`);",
      ]),
    ).toEqual(["Exact configured owner required"]);
  });

  it("keeps an allowlisted guard message with names and execution id", () => {
    expect(
      run(code, payload("Exact configured owner required"))[0]!.json,
    ).toEqual({
      workflow: "Tend 11: Read-only Gmail sync",
      node: "Check Gmail profile",
      message: "Exact configured owner required",
      execution_id: "4821",
      execution_url: url,
    });
  });

  it("keeps the n8n execution link only when it is a bare execution URL", () => {
    for (const bad of [
      `${url}?text=${encodeURIComponent(secret)}`,
      `${url}#F17`,
      "javascript:alert(1)",
      `http://localhost:5678/workflow/TendGoogle11/executions/4821/${secret}`,
      42,
    ])
      expect(
        run(code, payload("Exact configured owner required", {}, bad))[0]!.json
          .execution_url,
        String(bad),
      ).toBe("");
    expect(run(code, payload("x", {}, null))[0]!.json.execution_url).toBe("");
  });

  it("reduces provider errors to an HTTP status and withholds any other text", () => {
    const http = run(
      code,
      payload(`Request failed with status code 429 ${secret}`),
    );
    expect(http[0]!.json.message).toBe("HTTP 429");
    const coded = run(code, payload(secret, { httpCode: "503" }));
    expect(coded[0]!.json.message).toBe("HTTP 503");
    const other = run(code, payload(secret));
    expect(other[0]!.json.message).toBe(WITHHELD);
    for (const out of [http, coded, other]) {
      const text = JSON.stringify(out);
      expect(text).not.toContain("Mira");
      expect(text).not.toContain("F17");
      expect(text).not.toContain("example.test");
      expect(Object.keys(out[0]!.json).sort()).toEqual([
        "execution_id",
        "execution_url",
        "message",
        "node",
        "workflow",
      ]);
    }
  });

  it("rejects unredacted text, extra fields and oversize names at the API", () => {
    const ok = {
      workflow: "Tend 11",
      node: "Read Gmail profile",
      message: "HTTP 429",
      execution_id: "4821",
    };
    expect(acceptFailure(ok, allowed)).toEqual({ ...ok, execution_url: "" });
    const linked = { ...ok, execution_url: url };
    expect(acceptFailure(linked, allowed)).toEqual(linked);
    expect(() =>
      acceptFailure({ ...ok, execution_url: `${url}?q=${secret}` }, allowed),
    ).toThrow();
    expect(() => acceptFailure({ ...ok, message: secret }, allowed)).toThrow(
      "not redacted",
    );
    expect(() => acceptFailure({ ...ok, item: secret }, allowed)).toThrow();
    expect(() =>
      acceptFailure({ ...ok, node: "n".repeat(121) }, allowed),
    ).toThrow();
    expect(() =>
      acceptFailure({ ...ok, execution_id: secret }, allowed),
    ).toThrow();
  });

  it("keeps only the last 50 entries", () => {
    const log = createFailureLog(allowed);
    for (let i = 0; i < 55; i++)
      log.add(
        {
          workflow: "Tend 11",
          node: "n",
          message: WITHHELD,
          execution_id: String(i),
        },
        new Date("2026-10-22T08:00:00Z"),
      );
    expect(log.list()).toHaveLength(50);
    expect(log.list()[0]!.execution_id).toBe("5");
  });

  it("builds the allowlist from the private exports and embeds it in workflow 22", () => {
    const loaded = loadPrivateGuardMessages();
    expect(loaded).toContain("Exact configured owner required");
    const w = JSON.parse(
      readFileSync("workflows/22-private-error-handler.json", "utf8"),
    ) as {
      settings: Record<string, unknown>;
      nodes: { type: string; parameters: { jsCode?: string } }[];
    };
    expect(w.settings.saveDataErrorExecution).toBe("none");
    expect(w.settings.saveDataSuccessExecution).toBe("none");
    const redactor = w.nodes.find((n) => n.parameters.jsCode)!;
    expect(redactor.parameters.jsCode).toBe(redactorCode(loaded));
  });

  it("points every private export at workflow 22 and every fictional one at 21", () => {
    for (const [file, id] of [
      ["10-telegram-private.json", "TendPrivate22"],
      ["16-live-ai-review.json", "TendPrivate22"],
      ["20-daily-owner-briefing.json", "TendPrivate22"],
      ["03-whatsapp-personal.json", "TendReview21"],
    ] as const) {
      const w = JSON.parse(readFileSync(`workflows/${file}`, "utf8")) as {
        settings: { errorWorkflow?: string };
      };
      expect(w.settings.errorWorkflow, file).toBe(id);
    }
  });
});

describe("private failure-log allowlist location", () => {
  it("loads the same allowlist when the API starts outside the repo", () => {
    const expected = loadPrivateGuardMessages();
    const cwd = process.cwd();
    const away = mkdtempSync(join(tmpdir(), "tend-cwd-"));
    try {
      process.chdir(away);
      expect(loadPrivateGuardMessages()).toEqual(expected);
      expect(expected).toContain("Exact configured owner required");
    } finally {
      process.chdir(cwd);
      rmSync(away, { recursive: true, force: true });
    }
  });
});
