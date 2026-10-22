import { randomBytes, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  isRecord,
  sources,
  type TendStore,
  type AuthCommand,
  type Reply,
} from "./engine.ts";
import type { LiveStore } from "./live-store.ts";
import {
  allAvailableHistory,
  calendarWindow,
  calendarHistoryWindow,
  gmailWindow,
  messageHistoryStart,
  type LivePolicy,
  type VerifiedContactGroup,
} from "./live-policy.ts";
import {
  prepareNormalReply,
  type NormalModel,
  type PreparedTelegramRead,
} from "./telegram-normal.ts";
import { PrivateWebSessions } from "./private-web-session.ts";
import type {
  PrivateHistoryQuery,
  PrivateSemanticSearch,
  PrivateContactsResponse,
} from "./private-web-types.ts";
import {
  DeskRequestError,
  deskRoutes,
  handleDeskRoute,
  outreachRoutes,
  type DeskOptions,
} from "./desk-api.ts";
interface Options extends DeskOptions {
  store: TendStore | LiveStore;
  policy: LivePolicy;
  clock?: () => Date;
  normalModel?: NormalModel;
  semanticSearch?: PrivateSemanticSearch;
  ready?: Promise<unknown>;
  dailyStatus?: () => Promise<unknown>;
  historyStatus?: () => Promise<unknown>;
  resolveGroup?: (id: string) => Promise<VerifiedContactGroup | undefined>;
}
const token = (): string => randomBytes(24).toString("base64url");
const cookie = (req: IncomingMessage, name: string): string => {
  const pairs = (req.headers.cookie ?? "")
    .split(";")
    .map((p) => p.trim().split("="));
  return pairs.find((p) => p[0] === name)?.[1] ?? "";
};
const stamp = (v: unknown): string =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
async function body(req: IncomingMessage, limit = 4096): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const b = Buffer.from(chunk as Uint8Array);
    size += b.length;
    if (size > limit) throw new Error("Request too large");
    chunks.push(b);
  }
  return Buffer.concat(chunks).toString("utf8");
}
export function samePrivateReply(
  expected: Reply,
  checked: Reply,
  scopedFreshness: boolean,
): boolean {
  const clean = (reply: Reply): Reply => {
    const result = { ...reply };
    if (scopedFreshness) delete result.coverage;
    return result;
  };
  return JSON.stringify(clean(expected)) === JSON.stringify(clean(checked));
}
export function createPrivateWebHandler(
  options: Options,
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const { store, policy } = options,
    clock = options.clock ?? (() => new Date()),
    sessions = new PrivateWebSessions(clock);
  const cursors = new Map<
    string,
    {
      session: string;
      scope: string;
      revision: string;
      after: { occurred_at: string; record_key: string } | string;
      expires: number;
    }
  >();
  const views = new Map<
    string,
    {
      session: string;
      prepared: PreparedTelegramRead;
      auth: AuthCommand;
      expires: number;
    }
  >();
  let active = 0;
  const cleanup = (): void => {
    const now = clock().getTime();
    for (const [k, v] of cursors)
      if (v.expires <= now || !sessions.get(v.session)) cursors.delete(k);
    for (const [k, v] of views)
      if (v.expires <= now || !sessions.get(v.session)) views.delete(k);
  };
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/private" && !url.pathname.startsWith("/private/"))
      return false;
    const headers = {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy":
        "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    };
    let authenticatedKey: string | null = null;
    const send = (status: number, data: unknown): void => {
      if (authenticatedKey && !sessions.get(authenticatedKey)) {
        status = 401;
        data = { error: "Private session expired. Unlock again." };
      }
      res.writeHead(status, {
        ...headers,
        "Content-Type": "application/json; charset=utf-8",
      });
      res.end(JSON.stringify(data));
    };
    const port = res.socket?.localPort,
      origin = `http://127.0.0.1:${port}`;
    if (
      req.headers.host !== `127.0.0.1:${port}` ||
      (req.headers.origin && req.headers.origin !== origin) ||
      ["cross-site", "same-site"].includes(
        String(req.headers["sec-fetch-site"] ?? ""),
      )
    ) {
      send(403, {
        error: "Private access requires this laptop and its local address.",
      });
      return true;
    }
    cleanup();
    try {
      if (req.method === "POST" && url.pathname === "/private/unlock") {
        if (
          req.headers.origin !== origin ||
          req.headers["content-type"] !== "application/x-www-form-urlencoded"
        ) {
          send(403, { error: "Unlock rejected" });
          return true;
        }
        const fields = new URLSearchParams(await body(req)),
          session = sessions.unlock(
            cookie(req, "tend_pre"),
            fields.get("nonce") ?? "",
          );
        if (!session) {
          send(403, { error: "Unlock expired. Reload the private page." });
          return true;
        }
        res.writeHead(303, {
          ...headers,
          Location: "/private",
          "Set-Cookie": [
            `tend_private=${session.key}; Path=/private; HttpOnly; SameSite=Strict; Max-Age=1800`,
            "tend_pre=; Path=/private; HttpOnly; SameSite=Strict; Max-Age=0",
          ],
        });
        res.end();
        return true;
      }
      if (
        req.method === "GET" &&
        ["/private", "/private/"].includes(url.pathname)
      ) {
        const pre = sessions.preauth();
        const html = (
          await readFile(
            new URL("../web/private/index.html", import.meta.url),
            "utf8",
          )
        ).replaceAll("__TEND_NONCE__", pre.nonce);
        res.writeHead(200, {
          ...headers,
          "Content-Type": "text/html; charset=utf-8",
          "Set-Cookie": `tend_pre=${pre.key}; Path=/private; HttpOnly; SameSite=Strict; Max-Age=300`,
        });
        res.end(html);
        return true;
      }
      const asset = new Map([
        ["/private/styles.css", "styles.css"],
        ["/private/app.js", "app.js"],
      ]).get(url.pathname);
      if (asset && req.method === "GET") {
        const content = await readFile(
          new URL("../web/private/" + asset, import.meta.url),
        );
        res.writeHead(200, {
          ...headers,
          "Content-Type": asset.endsWith(".css")
            ? "text/css; charset=utf-8"
            : "text/javascript; charset=utf-8",
        });
        res.end(content);
        return true;
      }
      const session = sessions.get(cookie(req, "tend_private"));
      if (!session) {
        send(401, { error: "Unlock this device to view private data." });
        return true;
      }
      authenticatedKey = session.key;
      if (req.method === "GET" && url.pathname === "/private/api/session") {
        send(200, {
          unlocked: true,
          csrf: session.csrf,
          expires_at: session.expires_at,
        });
        return true;
      }
      if (req.method === "GET" && url.pathname === "/private/api/progress") {
        send(200, {
          history: options.historyStatus ? await options.historyStatus() : [],
          daily: options.dailyStatus
            ? await options.dailyStatus()
            : { enabled: false },
        });
        return true;
      }
      if (
        req.method === "POST" &&
        (req.headers.origin !== origin ||
          req.headers["content-type"] !== "application/json" ||
          req.headers["x-tend-csrf"] !== session.csrf)
      ) {
        send(403, { error: "Private request rejected" });
        return true;
      }
      if (req.method === "POST" && url.pathname === "/private/api/logout") {
        sessions.lock(session.key);
        authenticatedKey = null;
        cleanup();
        res.setHeader(
          "Set-Cookie",
          "tend_private=; Path=/private; HttpOnly; SameSite=Strict; Max-Age=0",
        );
        send(200, { locked: true });
        return true;
      }
      const allowed = [
        "/private/api/contacts",
        "/private/api/history",
        "/private/api/search",
        "/private/api/briefing",
        "/private/api/draft",
        "/private/api/revalidate",
        "/private/api/history-retry",
        ...deskRoutes,
        ...(options.outreach ? outreachRoutes : []),
      ];
      if (!allowed.includes(url.pathname)) {
        send(404, { error: "Unknown private route" });
        return true;
      }
      if (active >= 2) {
        send(429, { error: "Private assistant is busy. Try again shortly." });
        return true;
      }
      active++;
      try {
        if (options.ready && !(await options.ready)) {
          send(503, { error: "Private storage is not ready" });
          return true;
        }
        const owner = policy.principal_id;
        if (
          deskRoutes.includes(url.pathname) ||
          outreachRoutes.includes(url.pathname)
        ) {
          if (url.search && req.method === "POST")
            throw new Error("Unexpected query");
          let data: Record<string, unknown> | null = null;
          if (req.method === "POST") {
            const parsed: unknown = JSON.parse(
              await body(
                req,
                url.pathname === "/private/api/outreach/edit" ? 16384 : 4096,
              ),
            );
            if (!isRecord(parsed)) throw new Error("Invalid request");
            data = parsed;
          }
          try {
            const result = await handleDeskRoute({
              path: url.pathname,
              method: req.method ?? "GET",
              data,
              store,
              auth: {
                owner_id: owner,
                user_id: "live-owner",
                chat_id: "live-private",
                chat_type: "private",
              },
              now: clock(),
              options,
            });
            send(result.status, result.body);
          } catch (error) {
            if (!(error instanceof DeskRequestError)) throw error;
            send(error.status, { error: error.message });
          }
          return true;
        }
        if (req.method === "GET" && url.pathname === "/private/api/contacts") {
          const q = url.searchParams.get("q") ?? "";
          if (q.length > 150) throw new Error("Invalid contact query");
          const scope = stamp({ kind: "contacts", q }),
            cursor = url.searchParams.get("cursor"),
            prior = cursor ? cursors.get(cursor) : undefined;
          if (
            cursor &&
            (!prior ||
              prior.session !== session.key ||
              prior.scope !== scope ||
              typeof prior.after !== "string")
          )
            throw new Error("Stale contact cursor");
          const groups: PrivateContactsResponse["contacts"] = [];
          if (!prior && options.resolveGroup)
            for (const candidate of policy.verified_contact_groups ?? []) {
              const group = await options.resolveGroup(candidate.id);
              const members = group
                ? await Promise.all(
                    group.members.map(async (member) =>
                      (await store.contacts(owner, member.contact_id)).find(
                        (contact) => contact.contact_id === member.contact_id,
                      ),
                    ),
                  )
                : [];
              const readableName =
                members.find(
                  (member) =>
                    member?.name.trim() &&
                    member.name !== member.contact_id &&
                    !member.name.includes("@") &&
                    !/^\+?[\d\s]+$/u.test(member.name),
                )?.name ?? group?.name;
              if (
                group &&
                (!q ||
                  readableName!.toLowerCase().includes(q.toLowerCase()) ||
                  group.name.toLowerCase().includes(q.toLowerCase()) ||
                  group.id === q)
              )
                groups.push({
                  owner_id: owner,
                  contact_id: group.id,
                  name: readableName!,
                  verified_group: true,
                  provenance: group.proof_kind,
                  emails: group.members.map((m) => m.identity),
                });
            }
          if (groups.length > 20) throw new Error("Too many verified groups");
          const pageSize = 50 - groups.length;
          const contacts = await store.privateContacts(
              owner,
              q,
              typeof prior?.after === "string" ? prior.after : "",
              pageSize + 1,
            ),
            page = contacts.slice(0, pageSize);
          let next: string | null = null;
          if (contacts.length > pageSize) {
            next = token();
            if (cursors.size >= 500) throw new Error("Too many open pages");
            cursors.set(next, {
              session: session.key,
              scope,
              revision: "",
              after: page.at(-1)!.contact_id,
              expires: clock().getTime() + 5 * 60000,
            });
          }
          const visible = [...groups, ...page],
            now = clock(),
            states = await store.sourceStatus(owner);
          const accounts = states
            .filter(
              (s) =>
                s.status !== "revoked" &&
                (s.source === "gmail"
                  ? s.account_id.toLowerCase() ===
                    policy.account_email.toLowerCase()
                  : s.source === "calendar"
                    ? policy.calendar_ids.includes(s.account_id)
                    : policy.social?.accounts.some(
                        (a) =>
                          a.source === s.source &&
                          a.account_id === s.account_id &&
                          a.owner_verified,
                      )),
            )
            .map((s) => ({ source: s.source, account_id: s.account_id }));
          const aggregate = visible.length
            ? await store.privateHistory(owner, {
                contact_ids: [],
                accounts,
                now: now.toISOString(),
                message_start: gmailWindow(policy, now).start,
                social_start: messageHistoryStart(policy, "linkedin", now),
                calendar_end: calendarWindow(policy, now).end,
                calendar_start: calendarHistoryWindow(policy, now).start,
                snapshots:
                  policy.manual_calendar_snapshots?.map(
                    ({ calendar_id, event_id }) => ({ calendar_id, event_id }),
                  ) ?? [],
                limit: 1,
                activity_for: visible.map((c) => {
                  const group = groups.some(
                    (g) => g.contact_id === c.contact_id,
                  )
                    ? policy.verified_contact_groups?.find(
                        (g) => g.id === c.contact_id,
                      )
                    : undefined;
                  return {
                    selector: c.contact_id,
                    contact_ids: group
                      ? group.members.map((m) => m.contact_id)
                      : [c.contact_id],
                    ...(group
                      ? {
                          members: group.members.map(
                            ({ source, account_id, contact_id }) => ({
                              source,
                              account_id,
                              contact_id,
                            }),
                          ),
                        }
                      : {}),
                  };
                }),
              })
            : undefined;
          send(200, {
            contacts: visible.map((c) => ({
              ...c,
              activity: aggregate?.activity?.[c.contact_id] ?? {
                count: 0,
                last_at: null,
                sources: [],
              },
            })),
            next_cursor: next,
          });
          return true;
        }
        if (req.method === "GET" && url.pathname === "/private/api/history") {
          const selector = url.searchParams.get("selector") ?? "";
          const contacts = await store.contacts(owner, selector);
          const selected = contacts.find((c) => c.contact_id === selector);
          const group = await options.resolveGroup?.(selector);
          if (!selected && !group) throw new Error("Choose an exact contact");
          const now = clock(),
            states = await store.sourceStatus(owner),
            window = calendarWindow(policy, now);
          const approved = states
            .filter(
              (s) =>
                s.status !== "revoked" &&
                (s.source === "gmail"
                  ? s.account_id.toLowerCase() ===
                    policy.account_email.toLowerCase()
                  : s.source === "calendar"
                    ? policy.calendar_ids.includes(s.account_id)
                    : policy.social?.accounts.some(
                        (a) =>
                          a.source === s.source &&
                          a.account_id === s.account_id &&
                          a.owner_verified,
                      )),
            )
            .map((s) => ({ source: s.source, account_id: s.account_id }));
          const query: PrivateHistoryQuery = {
            contact_ids: group
              ? group.members.map((m) => m.contact_id)
              : [selected!.contact_id],
            ...(group
              ? {
                  members: group.members.map(
                    ({ source, account_id, contact_id }) => ({
                      source,
                      account_id,
                      contact_id,
                    }),
                  ),
                }
              : {}),
            snapshots:
              policy.manual_calendar_snapshots?.map(
                ({ calendar_id, event_id }) => ({ calendar_id, event_id }),
              ) ?? [],
            accounts: group
              ? approved.filter((a) =>
                  group.members.some(
                    (m) =>
                      m.source === a.source && m.account_id === a.account_id,
                  ),
                )
              : approved,
            now: now.toISOString(),
            message_start: gmailWindow(policy, now).start,
            social_start: messageHistoryStart(policy, "linkedin", now),
            calendar_end: window.end,
            calendar_start: calendarHistoryWindow(policy, now).start,
            limit: 51,
          };
          for (const key of ["source", "direction", "from", "to"] as const) {
            const value = url.searchParams.get(key);
            if (value) {
              if (
                key === "source" &&
                !sources.includes(value as (typeof sources)[number])
              )
                throw new Error("Invalid source");
              if (
                key === "direction" &&
                !["sent", "received", "event"].includes(value)
              )
                throw new Error("Invalid direction");
              if (
                (key === "from" || key === "to") &&
                !Number.isFinite(Date.parse(value))
              )
                throw new Error("Invalid date");
              query[key] =
                key === "from" || key === "to"
                  ? new Date(value).toISOString()
                  : value;
            }
          }
          const access = states.map(({ source, account_id, status }) => ({
            source,
            account_id,
            status,
          }));
          const scope = stamp({
              selector,
              group,
              snapshots: query.snapshots,
              source: query.source,
              direction: query.direction,
              from: query.from,
              to: query.to,
              access,
            }),
            cursor = url.searchParams.get("cursor"),
            prior = cursor ? cursors.get(cursor) : undefined;
          if (
            cursor &&
            (!prior ||
              prior.session !== session.key ||
              prior.scope !== scope ||
              typeof prior.after === "string")
          )
            throw new Error("Stale history cursor");
          if (prior && typeof prior.after !== "string")
            query.after = prior.after;
          const page = await store.privateHistory(owner, query);
          if (prior && prior.revision !== page.revision)
            throw new Error("History changed. Reload this contact.");
          const records = page.records.slice(0, 50);
          let next: string | null = null;
          if (page.records.length > 50) {
            next = token();
            if (cursors.size >= 500) throw new Error("Too many open pages");
            const last = records.at(-1)!;
            cursors.set(next, {
              session: session.key,
              scope,
              revision: page.revision,
              after: {
                occurred_at: last.occurred_at,
                record_key: last.record_key,
              },
              expires: clock().getTime() + 5 * 60000,
            });
          }
          send(200, {
            records,
            next_cursor: next,
            total: page.total,
            sources: states,
            commitments: (await store.commitments(owner)).filter((c) =>
              query.contact_ids.includes(c.contact_id),
            ),
          });
          return true;
        }
        if (req.method !== "POST") {
          send(405, { error: "Method not allowed" });
          return true;
        }
        const data: unknown = JSON.parse(await body(req));
        if (!isRecord(data)) throw new Error("Invalid request");
        if (url.pathname === "/private/api/history-retry") {
          if (
            url.search ||
            Object.keys(data).length !== 3 ||
            Object.keys(data).some(
              (key) => !["source", "account_id", "confirm"].includes(key),
            ) ||
            data.confirm !== "RETRY_HELD_HISTORY_PAGE" ||
            typeof data.source !== "string" ||
            !sources.includes(data.source as (typeof sources)[number]) ||
            typeof data.account_id !== "string"
          )
            throw new Error("Exact approved history retry required");
          const source = data.source as (typeof sources)[number],
            account = data.account_id;
          const historyApproved =
            source === "gmail" || source === "calendar"
              ? allAvailableHistory(policy)
              : Boolean(policy.social && allAvailableHistory(policy.social));
          const approved =
            source === "gmail"
              ? account === policy.account_email
              : source === "calendar"
                ? policy.calendar_ids.includes(account)
                : policy.social?.accounts.some(
                    (binding) =>
                      binding.source === source &&
                      binding.account_id === account &&
                      binding.owner_verified,
                  );
          const state = (await store.sourceStatus(owner)).find(
            (state) => state.source === source && state.account_id === account,
          );
          const checkpoint = (await store.historyBackfills(owner)).find(
            (entry) => entry.source === source && entry.account_id === account,
          );
          if (
            !historyApproved ||
            !approved ||
            !state ||
            state.mode !== "live" ||
            state.status === "revoked" ||
            !checkpoint ||
            checkpoint.status !== "paused" ||
            checkpoint.last_error !== "history_page_requires_review"
          )
            throw new Error("Approved live page must still be held for review");
          if (
            !(await store.retryHistoryBackfill(
              owner,
              source,
              account,
              "history_page_requires_review",
            ))
          )
            throw new Error(
              "History hold changed; reload progress before retrying",
            );
          send(200, {
            retry_requested: true,
            provider_called: false,
            skipped_records: 0,
          });
          return true;
        }
        if (url.pathname === "/private/api/revalidate") {
          const v =
            typeof data.view_id === "string"
              ? views.get(data.view_id)
              : undefined;
          if (!v || v.session !== session.key) {
            send(410, { error: "View expired. Prepare it again." });
            return true;
          }
          if (v.prepared.ai_guard?.prepared.contact_group)
            v.prepared.ai_guard.current_group =
              (await options.resolveGroup?.(
                v.prepared.ai_guard.prepared.contact_id,
              )) ?? null;
          const reply = await store.validatePreparedRead(
            v.auth,
            v.prepared,
            policy,
          );
          const valid = samePrivateReply(
            v.prepared.reply,
            reply,
            Boolean(v.prepared.ai_guard?.freshness),
          );
          if (!valid) views.delete(String(data.view_id));
          send(200, {
            view_id: data.view_id,
            valid,
            ...(valid ? { reply } : {}),
            checked_at: clock().toISOString(),
            expires_at: new Date(v.expires).toISOString(),
          });
          return true;
        }
        if (
          url.pathname === "/private/api/search" &&
          data.mode === "semantic"
        ) {
          if (
            typeof data.query !== "string" ||
            !data.query.trim() ||
            data.query.length > 500
          )
            throw new Error("Invalid search");
          if (!options.semanticSearch) {
            send(503, {
              error: "Semantic index is unavailable. Choose Keyword search.",
            });
            return true;
          }
          send(
            200,
            await options.semanticSearch({
              query: data.query,
              ...(typeof data.selector === "string" && data.selector
                ? { selector: data.selector }
                : {}),
            }),
          );
          return true;
        }
        if (url.pathname === "/private/api/search") {
          if (
            typeof data.query !== "string" ||
            !data.query.trim() ||
            data.query.length > 400 ||
            data.mode !== "keyword"
          )
            throw new Error("Invalid search");
          const selector =
            typeof data.selector === "string" ? data.selector : "";
          const group = selector
            ? await options.resolveGroup?.(selector)
            : undefined;
          const contact =
            selector && !group
              ? (await store.contacts(owner, selector)).find(
                  (c) => c.contact_id === selector,
                )
              : undefined;
          if (selector && !group && !contact)
            throw new Error("Choose an exact contact");
          const states = await store.sourceStatus(owner),
            now = clock();
          const accounts = states
            .filter(
              (s) =>
                s.status !== "revoked" &&
                (s.source === "gmail"
                  ? s.account_id.toLowerCase() ===
                    policy.account_email.toLowerCase()
                  : s.source === "calendar"
                    ? policy.calendar_ids.includes(s.account_id)
                    : policy.social?.accounts.some(
                        (a) =>
                          a.source === s.source &&
                          a.account_id === s.account_id &&
                          a.owner_verified,
                      )),
            )
            .filter(
              (s) =>
                !group ||
                group.members.some(
                  (m) => m.source === s.source && m.account_id === s.account_id,
                ),
            )
            .map((s) => ({ source: s.source, account_id: s.account_id }));
          const terms = [
            ...new Set(data.query.match(/[\p{L}\p{N}]+/gu) ?? []),
          ].slice(0, 12);
          if (!terms.length) throw new Error("Enter search words");
          const page = await store.privateHistory(owner, {
            contact_ids: group
              ? group.members.map((m) => m.contact_id)
              : contact
                ? [contact.contact_id]
                : [],
            accounts,
            ...(group
              ? {
                  members: group.members.map(
                    ({ source, account_id, contact_id }) => ({
                      source,
                      account_id,
                      contact_id,
                    }),
                  ),
                }
              : {}),
            snapshots:
              policy.manual_calendar_snapshots?.map(
                ({ calendar_id, event_id }) => ({ calendar_id, event_id }),
              ) ?? [],
            now: now.toISOString(),
            message_start: gmailWindow(policy, now).start,
            social_start: messageHistoryStart(policy, "linkedin", now),
            calendar_end: calendarWindow(policy, now).end,
            calendar_start: calendarHistoryWindow(policy, now).start,
            terms,
            limit: 10,
          });
          send(200, {
            records: page.records,
            mode: "keyword",
            coverage: states,
            warning:
              "Literal keyword matches over eligible imported text. Account coverage may be partial.",
          });
          return true;
        }
        const kind = url.pathname.split("/").at(-1);
        const selector = typeof data.selector === "string" ? data.selector : "";
        const contact = (await store.contacts(owner, selector)).find(
          (c) => c.contact_id === selector,
        );
        const group = await options.resolveGroup?.(selector);
        if (!contact && !group) throw new Error("Choose an exact contact");
        const text =
          (kind === "draft"
            ? "Draft a personalised follow-up for "
            : "Give me a contact briefing for ") + selector;
        const auth: AuthCommand = {
          owner_id: owner,
          user_id: "live-owner",
          chat_id: "live-private",
          chat_type: "private",
          text,
        };
        const prepared = await prepareNormalReply({
          auth,
          exactContactIntent: {
            intent: kind === "draft" ? "draft_preview" : "briefing",
            query: selector,
          },
          store,
          policy,
          clock,
          ...(options.resolveGroup
            ? {
                resolveGroup: async (id: string) =>
                  (await options.resolveGroup!(id)) ?? null,
              }
            : {}),
          ...(options.normalModel ? { model: options.normalModel } : {}),
        });
        if (prepared.ai_guard?.prepared.contact_group)
          prepared.ai_guard.current_group =
            (await options.resolveGroup?.(
              prepared.ai_guard.prepared.contact_id,
            )) ?? null;
        if (
          prepared.ai_guard?.prepared.contact_id !== selector ||
          prepared.ai_guard.prepared.purpose !== kind
        ) {
          send(503, {
            error:
              "The local assistant could not prepare this exact contact. Please try again.",
          });
          return true;
        }
        const reply = await store.validatePreparedRead(auth, prepared, policy);
        if (
          !samePrivateReply(
            prepared.reply,
            reply,
            Boolean(prepared.ai_guard?.freshness),
          )
        ) {
          send(409, {
            error: "Evidence changed while preparing. Please try again.",
          });
          return true;
        }
        if (views.size >= 50) throw new Error("Too many prepared views");
        const id = token(),
          expires = Math.min(
            Date.parse(session.expires_at),
            clock().getTime() + 5 * 60000,
          );
        views.set(id, { session: session.key, prepared, auth, expires });
        send(200, {
          view_id: id,
          reply,
          checked_at: clock().toISOString(),
          expires_at: new Date(expires).toISOString(),
        });
        return true;
      } finally {
        active--;
      }
    } catch {
      send(400, {
        error:
          "Private request could not be completed. Reload changed pages or try again.",
      });
      return true;
    }
  };
}
