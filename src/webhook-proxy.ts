import { timingSafeEqual } from "node:crypto";
import {
  createServer,
  request as upstreamRequest,
  type Server,
} from "node:http";
import { readFileSync } from "node:fs";
import { isRecord } from "./engine.ts";

export interface ProxyConfig {
  path: string;
  secret: string;
  upstreamPort: number;
  enrollment?: boolean;
}
export function deploymentProxyConfig(
  workflow: unknown,
  upstreamPort = 5678,
): ProxyConfig {
  if (
    !isRecord(workflow) ||
    typeof workflow.id !== "string" ||
    !Array.isArray(workflow.nodes)
  )
    throw new Error("invalid private deployment");
  const trigger = workflow.nodes.find(
    (n) => isRecord(n) && n.type === "n8n-nodes-base.telegramTrigger",
  );
  if (
    !isRecord(trigger) ||
    typeof trigger.id !== "string" ||
    typeof trigger.webhookId !== "string"
  )
    throw new Error("missing private trigger");
  const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
  if (
    !uuid.test(workflow.id) ||
    !uuid.test(trigger.id) ||
    !uuid.test(trigger.webhookId)
  )
    throw new Error("public template cannot be used for webhook deployment");
  return {
    path: `/webhook/${trigger.webhookId}/webhook`,
    secret: `${workflow.id}_${trigger.id}`.replace(/[^a-zA-Z0-9_-]/g, ""),
    upstreamPort,
  };
}
export function createWebhookProxy(config: ProxyConfig): Server {
  return createServer(async (req, res) => {
    const deny = (status: number): void => {
      res.writeHead(status, {
        "Content-Type": "text/plain",
        "Cache-Control": "no-store",
      });
      res.end("Rejected");
    };
    const allowedPath =
      req.url === config.path ||
      (config.enrollment === true &&
        req.url === config.path.replace("/webhook/", "/webhook-test/"));
    if (req.method !== "POST" || !allowedPath) {
      deny(404);
      return;
    }
    const supplied = String(
      req.headers["x-telegram-bot-api-secret-token"] ?? "",
    );
    const expected = Buffer.from(config.secret),
      actual = Buffer.from(supplied);
    if (
      expected.length !== actual.length ||
      !timingSafeEqual(expected, actual)
    ) {
      deny(403);
      return;
    }
    if (
      !req.headers["content-type"]?.toLowerCase().startsWith("application/json")
    ) {
      deny(415);
      return;
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    try {
      for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(String(chunk));
        bytes += buffer.length;
        if (bytes > 65536) {
          deny(413);
          return;
        }
        chunks.push(buffer);
      }
      const body = Buffer.concat(chunks);
      JSON.parse(body.toString("utf8"));
      const forwarded = upstreamRequest(
        {
          hostname: "127.0.0.1",
          port: config.upstreamPort,
          path: req.url,
          method: "POST",
          agent: false,
          headers: {
            "Content-Type": "application/json",
            "Content-Length": body.length,
            "x-telegram-bot-api-secret-token": supplied,
          },
        },
        (upstream) => {
          res.writeHead(upstream.statusCode ?? 502, {
            "Content-Type": "text/plain",
            "Cache-Control": "no-store",
          });
          upstream.pipe(res);
          upstream.on("error", () => res.destroy());
        },
      );
      forwarded.setTimeout(15000, () =>
        forwarded.destroy(new Error("upstream timeout")),
      );
      forwarded.on("error", () => {
        if (!res.headersSent) {
          res.writeHead(502, { "Content-Type": "text/plain" });
          res.end("Unavailable");
        } else res.destroy();
      });
      forwarded.end(body);
    } catch {
      if (!res.headersSent) deny(400);
      else res.destroy();
    }
  });
}
if (process.argv[1]?.endsWith("webhook-proxy.ts")) {
  const workflow: unknown = JSON.parse(
    readFileSync(".scratch/live-telegram/workflow.json", "utf8"),
  );
  const server = createWebhookProxy({
    ...deploymentProxyConfig(workflow),
    enrollment: process.argv.includes("--enrollment"),
  });
  server.listen(18769, "127.0.0.1", () =>
    console.log(
      "Private webhook-only proxy listening on localhost:18769. Route and header secret are not logged.",
    ),
  );
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, () => server.close(() => process.exit(0)));
}
