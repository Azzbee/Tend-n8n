import { PostgresStore } from "./postgres-store.ts";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { TendStore, isRecord } from "./engine.ts";
import type { LiveStore } from "./live-store.ts";
import {
  demoAuth,
  fixtureContacts,
  fixtureIdentities,
  fixtureRecords,
  fixtureSources,
} from "./fixtures.ts";
import {
  DEFAULT_DRAFT_MODEL,
  FALLBACK_DRAFT_MODEL,
  outreachWindow,
  type OutreachSnapshot,
} from "./outreach.ts";
import { OutreachBook, type OutreachItem } from "./outreach-store.ts";
import { MockGmail } from "./outreach-gmail.ts";

// Fixture world clock for outreach: four days after the fixture clock, at
// 09:00 Paris, so every planner rule has a fictional example.
export const FIXTURE_OUTREACH_CLOCK = "2026-10-17T07:00:00.000Z";

export function snapshotOf(store: TendStore, owner: string): OutreachSnapshot {
  return {
    contacts: store.contacts(owner),
    commitments: store.commitments(owner),
    interactions: store.interactions(owner),
  };
}
// Reads only the records the planner and the book can act on (see
// outreachWindow): the full history load under the principal lock is what
// timed out workflow 25's first hourly run.
export async function liveSnapshotOf(
  store: LiveStore,
  owner: string,
  book: OutreachBook,
  now: Date,
): Promise<OutreachSnapshot> {
  const [contacts, commitments] = await Promise.all([
    store.contacts(owner),
    store.commitments(owner),
  ]);
  const keys = [
    ...new Set([
      ...commitments.map((c) => c.record_key),
      ...book.openEvidenceKeys(),
    ]),
  ];
  const interactions =
    store instanceof PostgresStore
      ? await store.outreachInteractions(owner, now, keys)
      : outreachWindow(await store.interactions(owner), now, keys);
  return { contacts, commitments, interactions };
}
// Async backend the Desk's /private/api/outreach routes call
// (DeskOutreachBackend on improve/desk-ui). Throwing rejects the request.
export class OutreachService {
  readonly book: OutreachBook;
  private load: () => OutreachSnapshot | Promise<OutreachSnapshot>;
  constructor(
    book: OutreachBook,
    load: () => OutreachSnapshot | Promise<OutreachSnapshot>,
  ) {
    this.book = book;
    this.load = load;
  }
  async list(): Promise<ReturnType<OutreachBook["list"]>> {
    // The Desk: expired drafts are history, not something to act on.
    return this.book.list(await this.load(), false);
  }
  async approve(id: string, seen: string): Promise<OutreachItem> {
    return this.book.approve(id, seen, await this.load());
  }
  async edit(id: string, text: string): Promise<OutreachItem> {
    return this.book.edit(id, text, await this.load());
  }
  async skip(id: string): Promise<OutreachItem> {
    return this.book.skip(id, await this.load());
  }
}
// Confirms the two fictional promises (g1 owed to the owner, g2 owed by the
// owner) the way /confirm does, so the planner has open commitments.
export function confirmFixturePromises(store: TendStore): void {
  for (const id of ["g1", "g2"]) {
    const record = fixtureRecords.find((r) => r.source_record_id === id)!;
    const candidate = store.addCandidate(record, {
      quote: record.body_text,
      action: id === "g1" ? "send the demo" : "review your demo",
      suggested_due: id === "g1" ? "2026-10-15" : "2026-10-16",
    });
    if (candidate.status === "pending")
      store.command({
        ...demoAuth,
        text: `/confirm ${candidate.commitment_id} ${candidate.suggested_due}`,
      });
  }
}
// In-memory fictional lane for tests and Desk demos: Mira Tan (F17) data,
// confirmed promises and one planner run at the fixture outreach clock.
export function createFixtureOutreachService(
  clock: () => Date = () => new Date(FIXTURE_OUTREACH_CLOCK),
): { service: OutreachService; book: OutreachBook; store: TendStore } {
  const store = new TendStore(":memory:");
  store.seed(fixtureContacts, fixtureIdentities, fixtureSources);
  store.ingestBatch(fixtureRecords, "fixture");
  confirmFixturePromises(store);
  const book = new OutreachBook(":memory:", {
    owner_id: "demo-owner",
    lane: "fictional",
    clock,
    sendingEnabled: true,
  });
  const load = (): OutreachSnapshot => snapshotOf(store, "demo-owner");
  book.plan(load());
  return { service: new OutreachService(book, load), book, store };
}
type RouteResult = { status: number; body: unknown } | null;
// Picks the draft model for a planner run: the configured one (default
// qwen3:4b) when Ollama lists it, else the small fallback. Cached a minute
// so an hourly planner asks Ollama once per run.
export function createDraftModelResolver(
  configured: string | undefined,
  fetchFn: typeof fetch = fetch,
  now: () => number = Date.now,
  base = "http://127.0.0.1:11434",
): () => Promise<string> {
  const wanted = configured ?? DEFAULT_DRAFT_MODEL;
  let cached: { model: string; at: number } | null = null;
  return async () => {
    if (!/^[A-Za-z0-9._/-]{1,80}(?::[A-Za-z0-9._-]{1,40})?$/.test(wanted))
      return FALLBACK_DRAFT_MODEL;
    if (cached && now() - cached.at < 60000) return cached.model;
    let model = FALLBACK_DRAFT_MODEL;
    try {
      const r = await fetchFn(`${base}/api/tags`, {
        signal: AbortSignal.timeout(2000),
      });
      const body = (await r.json()) as { models?: { name?: unknown }[] };
      if (body.models?.some((m) => m.name === wanted)) model = wanted;
    } catch {
      // Ollama unreachable: the small model, and the template if that fails too.
    }
    cached = { model, at: now() };
    return model;
  };
}
// Fixture API routes for workflows 22-23 and the integration check.
export function fixtureOutreachRoute(
  book: OutreachBook,
  gmail: MockGmail,
  load: () => OutreachSnapshot,
  method: string,
  path: string,
  input: unknown,
  model?: string,
): RouteResult {
  if (path.startsWith("/api/mock-gmail/"))
    return gmail.handle(method, path, input);
  if (path !== "/api/outreach" && !path.startsWith("/api/outreach/"))
    return null;
  const body = isRecord(input) ? input : {};
  const id = typeof body.id === "string" ? body.id : "";
  const ok = (data: unknown): RouteResult => ({
    status: 200,
    body: { fictional: true, ...(data as object) },
  });
  if (method === "GET" && path === "/api/outreach")
    return ok(book.list(load()));
  if (method === "GET" && path === "/api/outreach/approved-email")
    return ok(book.approvedEmail(load()));
  if (method === "GET" && path === "/api/outreach/ledger")
    return ok({ ledger: book.ledger(), mock_gmail_drafts: gmail.drafts });
  if (method !== "POST") return null;
  if (path === "/api/outreach/plan") return ok(book.plan(load(), model));
  if (path === "/api/outreach/draft")
    return ok(book.modelDraft(id, body.text, load()));
  if (path === "/api/outreach/approve")
    return ok({
      item: book.approve(
        id,
        typeof body.text_code === "string" ? body.text_code : "",
        load(),
      ),
    });
  if (path === "/api/outreach/edit")
    return ok({ item: book.edit(id, String(body.text ?? ""), load()) });
  if (path === "/api/outreach/skip") return ok({ item: book.skip(id, load()) });
  if (path === "/api/outreach/gmail-draft")
    return ok({
      item: book.recordGmailDraft(
        id,
        body.approval_hash,
        body.draft_id,
        load(),
      ),
    });
  return null;
}
// Private lane: drafts live in their own SQLite file next to the private
// runtime state, and the send path stays shut unless OUTREACH_ENABLED=true.
// Internal routes let n8n plan, draft and record Gmail receipts; approval is
// only possible through the owner's Desk session or Telegram.
export function createPrivateOutreach(
  store: LiveStore,
  owner: string,
  env: Record<string, string | undefined> = process.env,
  clock?: () => Date,
  fetchFn: typeof fetch = fetch,
): {
  service: OutreachService;
  route: (method: string, path: string, input: unknown) => Promise<RouteResult>;
} {
  const path = env.TEND_OUTREACH_DB ?? ".scratch/live-private/outreach.sqlite";
  if (path !== ":memory:")
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const book = new OutreachBook(path, {
    owner_id: owner,
    lane: "private",
    sendingEnabled: env.OUTREACH_ENABLED === "true",
    ...(clock ? { clock } : {}),
  });
  const now = clock ?? (() => new Date());
  const load = () => liveSnapshotOf(store, owner, book, now());
  const draftModel = createDraftModelResolver(env.TEND_OUTREACH_MODEL, fetchFn);
  // The private bot routes /outreach /approve /edit /skip through the book;
  // every other command falls through to the store's own handler.
  if (store instanceof PostgresStore)
    store.setCommandExtension(async (auth, scoped) =>
      book.telegram(
        auth.text,
        await liveSnapshotOf(scoped, owner, book, now()),
      ),
    );
  return {
    service: new OutreachService(book, load),
    route: async (method, path, input) => {
      if (!path.startsWith("/api/live/outreach/")) return null;
      const body = isRecord(input) ? input : {};
      const id = typeof body.id === "string" ? body.id : "";
      if (method === "GET" && path === "/api/live/outreach/approved-email")
        return { status: 200, body: book.approvedEmail(await load()) };
      if (method !== "POST") return null;
      if (path === "/api/live/outreach/plan") {
        if (Object.keys(body).length) throw new Error("Plan takes no input");
        return {
          status: 200,
          body: book.plan(await load(), await draftModel()),
        };
      }
      if (path === "/api/live/outreach/draft")
        return {
          status: 200,
          body: book.modelDraft(id, body.text, await load()),
        };
      if (path === "/api/live/outreach/gmail-draft")
        return {
          status: 200,
          body: {
            item: book.recordGmailDraft(
              id,
              body.approval_hash,
              body.draft_id,
              await load(),
            ),
          },
        };
      return null;
    },
  };
}
