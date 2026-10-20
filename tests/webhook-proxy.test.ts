import { afterEach, describe, it, expect } from "vitest";
import { createServer, type Server } from "node:http";
import {
  createWebhookProxy,
  deploymentProxyConfig,
} from "../src/webhook-proxy.ts";
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0))
    await new Promise<void>((resolve) => s.close(() => resolve()));
});
async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("invalid port");
  return address.port;
}
describe("webhook-only public boundary", () => {
  it("blocks editor, API, GET and an invalid Telegram secret before forwarding", async () => {
    let hits = 0;
    const upstreamPort = await listen(
      createServer((_req, res) => {
        hits++;
        res.end("ok");
      }),
    );
    const port = await listen(
      createWebhookProxy({
        path: "/webhook/fixture/webhook",
        secret: "FICTIONAL_HEADER",
        upstreamPort,
      }),
    );
    for (const path of [
      "/",
      "/rest/settings",
      "/api/status",
      "/private",
      "/private/unlock",
      "/private/app.js",
      "/private/api/session",
      "/private/api/history?selector=F17",
      "/private/api/search",
      "/webhook/other/webhook",
    ]) {
      const r = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: "POST",
      });
      expect(r.status).toBe(404);
    }
    expect(
      (await fetch(`http://127.0.0.1:${port}/webhook/fixture/webhook`)).status,
    ).toBe(404);
    expect(
      (
        await fetch(`http://127.0.0.1:${port}/webhook/fixture/webhook`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(403);
    expect(hits).toBe(0);
    const r = await fetch(`http://127.0.0.1:${port}/webhook/fixture/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-telegram-bot-api-secret-token": "FICTIONAL_HEADER",
      },
      body: "{}",
    });
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("ok");
    expect(hits).toBe(1);
  });
  it("refuses predictable public template IDs", () =>
    expect(() =>
      deploymentProxyConfig({ id: "TendLiveTelegram", nodes: [] }),
    ).toThrow());
});
