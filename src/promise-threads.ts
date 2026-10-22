import type { Commitment } from "./engine.ts";
import type { VerifiedContactGroup } from "./live-policy.ts";
import type { EmbeddingClient } from "./semantic-search.ts";

// Promise threads: the same ask from the same person, seen on several channels, counted once.
// Membership is stored (auto or owner); this module decides links and collapses threads for every surface.

export interface ThreadRow {
  thread_id: string;
  commitment_id: string;
  linked_by: "auto" | "owner";
  similarity: number | null;
  created_at: string;
}
export interface ThreadOverride {
  commitment_id: string;
  other_commitment_id: string;
}
export type ThreadedCommitment = Commitment & { thread_id?: string };
export interface PromiseThread {
  thread_id: string | null;
  primary: Commitment;
  members: Commitment[];
}
/** Cosine for two action texts from the embedding model, or null when unavailable. */
export type ActionCosine = (a: string, b: string) => number | null;

// Measured on granite-embedding:278m (22 Oct): "send the contract" vs "send the demo" scores 0.835 and
// "pay" vs "send the invoice" 0.886, so cosine alone cannot separate short asks. Tokens decide; cosine only
// adds links at 0.9 or more when the two asks also share a content word.
export const THREAD_TOKEN_THRESHOLD = 0.7;
export const THREAD_COSINE_THRESHOLD = 0.9;
export const THREAD_DUE_DAYS = 2;
export const THREAD_WINDOW_DAYS = 21;
export const THREAD_PASS_LIMIT = 200;

const stopwords = new Set(
  "a an the to by for of on in at with and or i i'll ill will we we'll you your yours my me our us it this that be is are am just also over up please".split(
    " ",
  ),
);
const tokenCache = new Map<string, string[]>();
export function actionTokens(text: string): string[] {
  const cached = tokenCache.get(text);
  if (cached) return cached;
  if (tokenCache.size >= 2000) tokenCache.clear();
  const tokens = [
    ...new Set(
      text
        .toLowerCase()
        .replace(/\d{4}-\d{2}-\d{2}/g, " ")
        .split(/[^\p{L}\p{N}']+/u)
        // Stopwords are dropped before and after stemming, so "the" never survives as "th".
        .filter((t) => !stopwords.has(t))
        .map((t) =>
          t
            .replace(/'s$/, "")
            .replace(/(ing|ed)$/, "")
            .replace(/s$/, "")
            .replace(/e$/, ""),
        )
        .filter((t) => t.length > 1 && !stopwords.has(t) && !/^\d+$/.test(t)),
    ),
  ];
  tokenCache.set(text, tokens);
  return tokens;
}
/** Dice coefficient over normalized content tokens. */
export function tokenSimilarity(a: string, b: string): number {
  const x = actionTokens(a),
    y = new Set(actionTokens(b));
  if (!x.length || !y.size) return 0;
  return (2 * x.filter((t) => y.has(t)).length) / (x.length + y.size);
}
export function askSimilarity(
  a: string,
  b: string,
  cosine?: ActionCosine,
): number | null {
  const tokens = tokenSimilarity(a, b);
  if (tokens >= THREAD_TOKEN_THRESHOLD) return round(tokens);
  const embedded = cosine?.(a, b) ?? null;
  return embedded !== null && embedded >= THREAD_COSINE_THRESHOLD && tokens > 0
    ? round(embedded)
    : null;
}
const round = (n: number): number => Math.round(n * 1000) / 1000;

const open = (c: Commitment): boolean =>
  (c.status === "pending" || c.status === "confirmed") &&
  c.evidence_valid !== false;
const due = (c: Commitment): string | null => c.due_date ?? c.suggested_due;
function dueCompatible(a: Commitment, b: Commitment): boolean {
  const x = due(a),
    y = due(b);
  if (!x || !y) return true;
  return (
    Math.abs(Date.parse(`${x}T00:00:00Z`) - Date.parse(`${y}T00:00:00Z`)) <=
    THREAD_DUE_DAYS * 86_400_000
  );
}
/** Same person: same contact, or both in one verified group with an accepted proof. Names never count. */
export function personKey(
  contactId: string,
  groups: readonly VerifiedContactGroup[] = [],
  now = new Date(),
): string {
  const group = groups.find(
    (g) =>
      ["owner_confirmed", "provider_verified"].includes(g.proof_kind) &&
      Date.parse(g.verified_at) <= now.getTime() &&
      g.members.some((m) => m.contact_id === contactId),
  );
  return group ? `group:${group.id}` : `contact:${contactId}`;
}
const pair = (a: string, b: string): string =>
  a < b ? `${a}|${b}` : `${b}|${a}`;

/**
 * Returns the rows to add so that every open commitment joins at most one thread of the same ask.
 * Existing rows are kept (owner links and earlier auto links); owner splits are never re-linked.
 */
export function linkThreads(input: {
  commitments: readonly Commitment[];
  occurredAt: ReadonlyMap<string, string>;
  rows: readonly ThreadRow[];
  overrides: readonly ThreadOverride[];
  groups?: readonly VerifiedContactGroup[];
  cosine?: ActionCosine;
  now: Date;
  /** Link only these commitments (for example the one just added); others can still be their partners. */
  only?: readonly string[];
  /** At most this many loose commitments are tried per pass, so a backfill is spread over several passes. */
  limit?: number;
}): ThreadRow[] {
  const at = (c: Commitment): number =>
    Date.parse(input.occurredAt.get(c.record_key) ?? "") || 0;
  const separate = new Set(
    input.overrides.map((o) => pair(o.commitment_id, o.other_commitment_id)),
  );
  const byId = new Map(input.commitments.map((c) => [c.commitment_id, c]));
  const threads = new Map<string, Commitment[]>();
  const placed = new Set<string>();
  const inUse = new Set(input.rows.map((r) => r.thread_id));
  for (const row of input.rows) {
    const c = byId.get(row.commitment_id);
    placed.add(row.commitment_id);
    if (c)
      threads.set(row.thread_id, [...(threads.get(row.thread_id) ?? []), c]);
  }
  const person = (c: Commitment): string =>
    personKey(c.contact_id, input.groups, input.now);
  const fits = (c: Commitment, other: Commitment): number | null => {
    if (
      person(c) !== person(other) ||
      c.direction !== other.direction ||
      !open(other) ||
      separate.has(pair(c.commitment_id, other.commitment_id)) ||
      !dueCompatible(c, other) ||
      Math.abs(at(c) - at(other)) > THREAD_WINDOW_DAYS * 86_400_000
    )
      return null;
    return askSimilarity(c.action, other.action, input.cosine);
  };
  const added: ThreadRow[] = [];
  const created = input.now.toISOString();
  const loose = input.commitments
    .filter((c) => open(c) && !placed.has(c.commitment_id))
    .sort(
      (a, b) => at(a) - at(b) || a.commitment_id.localeCompare(b.commitment_id),
    );
  const only = input.only ? new Set(input.only) : null;
  let budget = input.limit ?? THREAD_PASS_LIMIT;
  for (const c of loose) {
    if (placed.has(c.commitment_id)) continue;
    if (only && !only.has(c.commitment_id)) continue;
    if (budget-- <= 0) break;
    let best = null as { id: string; score: number } | null;
    for (const [id, members] of threads) {
      const live = members.filter(open);
      if (!live.length) continue;
      const scores = live.map((m) => fits(c, m));
      if (scores.some((s) => s === null)) continue;
      const score = Math.min(...(scores as number[]));
      if (!best || score > best.score) best = { id, score };
    }
    if (!best) {
      let partner = null as { other: Commitment; score: number } | null;
      for (const other of loose) {
        if (other === c || placed.has(other.commitment_id)) continue;
        const score = fits(c, other);
        if (score !== null && (!partner || score > partner.score))
          partner = { other, score };
      }
      if (!partner) continue;
      // The thread id comes from the earlier sighting, so it never changes as later ones join.
      const earlier =
        at(partner.other) < at(c) ||
        (at(partner.other) === at(c) &&
          partner.other.commitment_id < c.commitment_id)
          ? partner.other
          : c;
      // Never reuse a thread id still in use: a new pair must not rejoin a thread the owner split.
      let id = `T${earlier.commitment_id}`;
      for (let n = 2; inUse.has(id); n++) id = `T${earlier.commitment_id}-${n}`;
      inUse.add(id);
      const later = earlier === c ? partner.other : c;
      added.push(
        {
          thread_id: id,
          commitment_id: earlier.commitment_id,
          linked_by: "auto",
          similarity: null,
          created_at: created,
        },
        {
          thread_id: id,
          commitment_id: later.commitment_id,
          linked_by: "auto",
          similarity: partner.score,
          created_at: created,
        },
      );
      threads.set(id, [c, partner.other]);
      placed.add(c.commitment_id).add(partner.other.commitment_id);
    } else {
      added.push({
        thread_id: best.id,
        commitment_id: c.commitment_id,
        linked_by: "auto",
        similarity: best.score,
        created_at: created,
      });
      threads.get(best.id)!.push(c);
      placed.add(c.commitment_id);
    }
  }
  return added;
}

/** Overrides and removals when the owner says one member is not the same ask. */
export function separateFromThread(
  rows: readonly ThreadRow[],
  commitmentId: string,
): { remove: string[]; overrides: ThreadOverride[] } {
  const row = rows.find((r) => r.commitment_id === commitmentId);
  if (!row) throw new Error("not in a thread");
  const others = rows.filter(
    (r) => r.thread_id === row.thread_id && r.commitment_id !== commitmentId,
  );
  return {
    remove: [
      commitmentId,
      ...(others.length === 1 ? [others[0]!.commitment_id] : []),
    ],
    overrides: others.map((o) => ({
      commitment_id: commitmentId,
      other_commitment_id: o.commitment_id,
    })),
  };
}

/** The stored shape: thread membership lives in its own table, never in the commitment row. */
export function withoutThread(c: ThreadedCommitment): Commitment {
  const stored: ThreadedCommitment = { ...c };
  delete stored.thread_id;
  return stored;
}
export function annotateThreads(
  commitments: readonly Commitment[],
  rows: readonly ThreadRow[],
): ThreadedCommitment[] {
  const thread = new Map(rows.map((r) => [r.commitment_id, r.thread_id]));
  return commitments.map((c) => {
    const id = thread.get(c.commitment_id);
    return id ? { ...c, thread_id: id } : { ...c };
  });
}

/** Members of the same thread as `id` (itself included), for commands that act on the whole promise. */
export function threadMembers(
  commitments: readonly ThreadedCommitment[],
  id: string,
): ThreadedCommitment[] {
  const target = commitments.find((c) => c.commitment_id === id);
  if (!target?.thread_id) return target ? [target] : [];
  return commitments.filter((c) => c.thread_id === target.thread_id);
}

/**
 * One promise per thread. The primary is the earliest-sourced member (stable keys for outreach);
 * status is confirmed when any open member is, due is the earliest confirmed due, and the thread
 * stays valid while one source is valid.
 */
export function collapseThreads(
  commitments: readonly ThreadedCommitment[],
  occurredAt?: ReadonlyMap<string, string>,
): PromiseThread[] {
  const at = (c: Commitment): string =>
    occurredAt?.get(c.record_key) ?? c.commitment_id;
  const groups = new Map<string, ThreadedCommitment[]>();
  const out: PromiseThread[] = [];
  for (const c of commitments)
    if (c.thread_id)
      groups.set(c.thread_id, [...(groups.get(c.thread_id) ?? []), c]);
    else out.push({ thread_id: null, primary: c, members: [c] });
  for (const [thread_id, members] of groups) {
    members.sort(
      (a, b) =>
        at(a).localeCompare(at(b)) ||
        a.commitment_id.localeCompare(b.commitment_id),
    );
    const live = members.filter(
      (m) => m.status === "pending" || m.status === "confirmed",
    );
    if (live.length < 2) {
      // A thread with one open member is just that promise; closed members keep their own status.
      for (const m of members)
        out.push({ thread_id: null, primary: m, members: [m] });
      continue;
    }
    const confirmed = live.filter((m) => m.status === "confirmed");
    const dues = confirmed
      .map((m) => m.due_date)
      .filter((d): d is string => !!d)
      .sort();
    const first = live[0]!;
    out.push({
      thread_id,
      members: live,
      primary: {
        ...first,
        status: confirmed.length ? "confirmed" : "pending",
        due_date: confirmed.length ? (dues[0] ?? null) : null,
        suggested_due:
          live
            .map((m) => m.suggested_due)
            .filter((d): d is string => !!d)
            .sort()[0] ?? null,
        evidence_valid: live.some((m) => m.evidence_valid !== false),
      },
    });
  }
  return out;
}

/** One commitment per promise, for counts and lists that predate threads. */
export function onePerThread(
  commitments: readonly ThreadedCommitment[],
  occurredAt?: ReadonlyMap<string, string>,
): ThreadedCommitment[] {
  return collapseThreads(commitments, occurredAt).map((t) =>
    t.thread_id ? { ...t.primary, thread_id: t.thread_id } : t.primary,
  );
}

const EMBED_BUDGET_MS = 3000;
const EMBED_LIMIT = 40;
const vectors = new Map<string, number[]>();
/** Embeds action texts before any store lock; undefined when the model is unavailable or slow, so tokens decide. */
export async function actionCosine(
  client: EmbeddingClient | undefined,
  actions: readonly string[],
): Promise<ActionCosine | undefined> {
  if (!client) return undefined;
  const texts = [...new Set(actions)].slice(0, EMBED_LIMIT);
  const signal = AbortSignal.timeout(EMBED_BUDGET_MS);
  try {
    for (const text of texts)
      if (!vectors.has(text)) {
        if (vectors.size >= 500) vectors.clear();
        vectors.set(text, await client.embed(text, signal));
      }
  } catch {
    return undefined;
  }
  return (a, b) => {
    const x = vectors.get(a),
      y = vectors.get(b);
    if (!x || !y || x.length !== y.length) return null;
    let dot = 0,
      nx = 0,
      ny = 0;
    for (let i = 0; i < x.length; i++) {
      dot += x[i]! * y[i]!;
      nx += x[i]! * x[i]!;
      ny += y[i]! * y[i]!;
    }
    return nx && ny ? dot / Math.sqrt(nx * ny) : null;
  };
}
