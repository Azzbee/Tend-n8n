import { readFileSync } from "node:fs";
import { parseLivePolicy, type VerifiedContactGroup } from "./live-policy.ts";
import { PostgresStore } from "./postgres-store.ts";
import { OllamaEmbeddingClient } from "./semantic-search.ts";
import { actionCosine } from "./promise-threads.ts";

// Operator backfill for promise threads: links open obligations that no thread holds yet, outside any
// request. Each batch is its own owner-lock transaction with the 2 s link budget; a rerun links nothing new.
// Usage (operator, outside the sandbox, same environment as the live server):
//   node --experimental-strip-types src/promise-thread-backfill.ts status
//   node --experimental-strip-types src/promise-thread-backfill.ts apply [--embeddings <granite digest>]
// It prints counts only.

export interface BackfillCounts {
  mode: "status" | "apply";
  unlinked_open: number;
  linked: number;
  skipped: number;
  timed_out: number;
}
export async function backfillPromiseThreads(
  store: Pick<PostgresStore, "unlinkedOpenIds" | "linkBatch" | "commitments">,
  owner: string,
  groups: readonly VerifiedContactGroup[],
  options: {
    apply: boolean;
    batchSize?: number;
    pauseMs?: number;
    embeddings?: OllamaEmbeddingClient;
  },
): Promise<BackfillCounts> {
  const ids = await store.unlinkedOpenIds(owner);
  const counts: BackfillCounts = {
    mode: options.apply ? "apply" : "status",
    unlinked_open: ids.length,
    linked: 0,
    skipped: 0,
    timed_out: 0,
  };
  if (!options.apply) return counts;
  const size = Math.min(Math.max(options.batchSize ?? 200, 1), 200);
  // Vectors are computed here, before any transaction; the lock only ever sees numbers.
  const cosine = options.embeddings
    ? await actionCosine(
        options.embeddings,
        (await store.commitments(owner))
          .filter((c) => c.status === "pending" || c.status === "confirmed")
          .map((c) => c.action),
      )
    : undefined;
  const linked = new Set<string>();
  for (let i = 0; i < ids.length; i += size) {
    const batch = ids.slice(i, i + size).filter((id) => !linked.has(id));
    if (i > 0) await new Promise((r) => setTimeout(r, options.pauseMs ?? 250));
    if (!batch.length) continue;
    const result = await store.linkBatch(owner, groups, cosine, batch);
    // A timed-out batch adds nothing; the next run retries it. Any other error stops the run.
    if (result.outcome === "timed_out") {
      counts.timed_out += batch.length;
      continue;
    }
    for (const row of result.rows) linked.add(row.commitment_id);
    counts.skipped += batch.filter((id) => !linked.has(id)).length;
  }
  // Partners from earlier batches were already in a thread, so linked counts every newly threaded id.
  counts.linked = linked.size;
  return counts;
}

async function main(): Promise<void> {
  const [mode, flag, digest] = process.argv.slice(2);
  if (mode !== "status" && mode !== "apply")
    throw new Error("Usage: promise-thread-backfill.ts status|apply");
  const path = process.env.TEND_LIVE_POLICY_FILE;
  if (!path) throw new Error("Private live policy file required");
  const policy = parseLivePolicy(
    JSON.parse(readFileSync(path, "utf8")) as unknown,
  );
  const socket = process.env.TEND_LIVE_PG_SOCKET;
  const pgPort = Number(process.env.TEND_LIVE_PG_PORT ?? 18772);
  if (!socket?.startsWith("/") || !Number.isInteger(pgPort))
    throw new Error("Private PostgreSQL socket and valid port required");
  const store = await PostgresStore.open({
    host: socket,
    port: pgPort,
    database: "tend_coursework",
    ...(process.env.USER ? { user: process.env.USER } : {}),
    connectionTimeoutMillis: 5000,
    principal: {
      owner_id: policy.principal_id,
      user_id: "live-owner",
      chat_id: "live-private",
    },
  });
  try {
    const counts = await backfillPromiseThreads(
      store,
      policy.principal_id,
      policy.verified_contact_groups ?? [],
      {
        apply: mode === "apply",
        ...(flag === "--embeddings" && digest
          ? { embeddings: new OllamaEmbeddingClient({ digest }) }
          : {}),
      },
    );
    console.log(JSON.stringify(counts));
  } finally {
    await store.close();
  }
}
if (import.meta.url === `file://${process.argv[1]}`)
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "backfill failed");
    process.exit(1);
  });
