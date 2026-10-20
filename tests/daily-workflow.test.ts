import { describe, expect, it } from "vitest";
import vm from "node:vm";
import { buildDailyBriefingWorkflow } from "../src/daily-workflow.ts";

describe("inactive owner daily briefing workflow", () => {
  it("uses Paris scheduling, held transport and private placeholders", () => {
    const w = buildDailyBriefingWorkflow();
    expect(w.active).toBe(false);
    expect(w.settings.timezone).toBe("Europe/Paris");
    expect(w.settings.saveDataSuccessExecution).toBe("none");
    expect(w.settings.saveDataErrorExecution).toBe("none");
    const triggers = w.nodes.filter(
      (n) => n.type === "n8n-nodes-base.scheduleTrigger",
    );
    expect(triggers).toHaveLength(1);
    expect(JSON.stringify(triggers[0]?.parameters)).toContain("0 0 9 * * *");
    expect(JSON.stringify(triggers[0]?.parameters)).toContain(
      "0 */5 9-12 * * *",
    );
    expect(JSON.stringify(w)).toContain("CONFIGURE_OWNER_CHAT_ID");
    expect(JSON.stringify(w)).not.toMatch(
      /telegram_update_id|api\.telegram\.org|setWebhook/,
    );
  });
  it("has one non-retrying Telegram send followed by actual receipt and uncertain branches", () => {
    const w = buildDailyBriefingWorkflow();
    const send = w.nodes.filter((n) => n.type === "n8n-nodes-base.telegram");
    expect(send).toHaveLength(1);
    expect(send[0]?.retryOnFail).toBe(false);
    expect(send[0]?.continueOnFail).toBe(true);
    expect(JSON.stringify(send[0]?.parameters)).not.toContain("parse_mode");
    const routes = w.nodes.filter(
      (n) => n.type === "n8n-nodes-base.httpRequest",
    );
    expect(routes).toHaveLength(4);
    expect(routes.every((n) => n.retryOnFail === false)).toBe(true);
    expect(JSON.stringify(w.connections)).toContain(
      "Hold uncertain owner delivery",
    );
    expect(JSON.stringify(w.connections)).toContain(
      "Record actual owner acknowledgement",
    );
  });
  it("default unconfigured transport owner guard rejects all destinations", () => {
    const guard = buildDailyBriefingWorkflow().nodes.find(
      (n) => n.name === "Validate exact owner transport",
    )!;
    const code = String(guard.parameters.jsCode);
    expect(() =>
      vm.runInNewContext(`(function(){${code}})()`, {
        $input: {
          first: () => ({
            json: {
              transport: {
                paris_date: "2026-10-20",
                delivery_id: "x",
                chat_id: "12345",
                text: "hello",
              },
            },
          }),
        },
      }),
    ).toThrow(/owner/);
  });
  it("acknowledgement validator refuses a different destination and recognises the actual owner", () => {
    const raw = String(
      buildDailyBriefingWorkflow().nodes.find(
        (n) => n.name === "Inspect actual Telegram receipt",
      )!.parameters.jsCode,
    );
    const code = raw
      .replaceAll("CONFIGURE_OWNER_CHAT_ID", "12345")
      .replaceAll("CONFIGURE_OWNER_USER_ID", "12345");
    const run = (receipt: unknown) =>
      vm.runInNewContext(`(function(){${code}})()`, {
        $input: { first: () => ({ json: receipt }) },
        $: () => ({
          first: () => ({
            json: { paris_date: "2026-10-20", delivery_id: "selected" },
          }),
        }),
      });
    expect(
      run({ message_id: 12, chat: { type: "private", id: 12345 } })[0].json
        .receipt_valid,
    ).toBe(true);
    expect(
      run({ message_id: 12, chat: { type: "private", id: 99 } })[0].json
        .receipt_valid,
    ).toBe(false);
    expect(
      run({ message_id: 12, chat: { type: "group", id: 12345 } })[0].json
        .receipt_valid,
    ).toBe(false);
    expect(run({ error: "timeout" })[0].json.receipt_valid).toBe(false);
  });
});
