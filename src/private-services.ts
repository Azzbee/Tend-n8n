import { createHash } from "node:crypto";
import { statfs } from "node:fs/promises";
import { Pool, type PoolConfig } from "pg";
import type { Contact, NormalizedRecord, SourceState } from "./engine.ts";
import type { LiveStore } from "./live-store.ts";
import type { LivePolicy } from "./live-policy.ts";
import { eligibleRecords } from "./record-eligibility.ts";
import {
  localNormalModel,
  type NormalModel,
  type NormalSemanticSearch,
} from "./telegram-normal.ts";
import type { PrivateSemanticSearch } from "./private-web-types.ts";
import {
  LocalModelCoordinator,
  OllamaEmbeddingClient,
  SemanticSearchService,
} from "./semantic-search.ts";

export const PRIVATE_EMBEDDING_DIGEST =
  "1a37926bf842899cbf90583e3932f3820548716d9d07661ba622199ffe95c552";
export function guardSemanticRecords(
  canonical: NormalizedRecord[],
  matches: NormalizedRecord[],
): NormalizedRecord[] {
  const current = new Map(
      canonical.map((record) => [record.record_key, record]),
    ),
    seen = new Set<string>();
  return matches
    .flatMap((match) => {
      const record = current.get(match.record_key);
      if (
        !record ||
        record.owner_id !== match.owner_id ||
        record.content_hash !== match.content_hash ||
        seen.has(record.record_key)
      )
        return [];
      seen.add(record.record_key);
      return [record];
    })
    .slice(0, 30);
}
export async function resolvePrivateSearchSelection(
  selector: string | undefined,
  policy: LivePolicy,
  contacts: (Contact & { emails: string[] })[],
  states: SourceState[],
): Promise<string[] | undefined> {
  if (!selector) return undefined;
  if (selector.length > 128) throw new Error("Invalid contact selection");
  const group = policy.verified_contact_groups?.find(
    (group) => group.id === selector,
  );
  if (group) {
    if (
      Date.parse(group.verified_at) > Date.now() ||
      !group.members.every(
        (member) =>
          contacts.some(
            (contact) =>
              contact.owner_id === policy.principal_id &&
              contact.contact_id === member.contact_id &&
              contact.emails.includes(member.identity),
          ) &&
          states.some(
            (state) =>
              state.owner_id === policy.principal_id &&
              state.source === member.source &&
              state.account_id === member.account_id &&
              state.mode === "live" &&
              state.status !== "revoked",
          ),
      )
    )
      throw new Error("Verified identity changed");
    return group.members.map((member) => member.contact_id);
  }
  const exact = contacts.find(
    (contact) =>
      contact.owner_id === policy.principal_id &&
      contact.contact_id === selector &&
      contact.contact_id !== "OWNER",
  );
  if (!exact) throw new Error("Unknown contact selection");
  return [exact.contact_id];
}
export function createPrivateServices(options: {
  policy: LivePolicy;
  store: LiveStore;
  postgres: PoolConfig;
}): {
  normalModel: NormalModel;
  normalSemanticSearch: NormalSemanticSearch;
  privateSemanticSearch: PrivateSemanticSearch;
  start: () => void;
  close: () => Promise<void>;
} {
  const { policy, store } = options,
    owner = policy.principal_id,
    pool = new Pool({ ...options.postgres, max: 2, statement_timeout: 15000 }),
    coordinator = new LocalModelCoordinator(),
    stop = new AbortController();
  const embedding = new OllamaEmbeddingClient({
    digest: PRIVATE_EMBEDDING_DIGEST,
  });
  const service = new SemanticSearchService({
    owner,
    digest: PRIVATE_EMBEDDING_DIGEST,
    pool,
    embedding,
    coordinator,
    scope: {
      fingerprint: createHash("sha256")
        .update(JSON.stringify(policy))
        .digest("hex"),
      eligible: (record, states, now) =>
        eligibleRecords([record], now, policy, states, owner, true).length ===
        1,
      expiresAt: (record) =>
        new Date(
          record.source === "calendar"
            ? (record.end_at ?? record.occurred_at)
            : Date.parse(record.occurred_at) + 30 * 86400000,
        ),
    },
    resources: async () => {
      const disk = await statfs(process.cwd());
      return { freeBytes: disk.bavail * disk.bsize };
    },
  });
  let loop: Promise<void> | undefined,
    timer: ReturnType<typeof setTimeout> | undefined,
    started = false;
  const normalModel: NormalModel = (request, signal) =>
    coordinator.run(
      "foreground",
      async () => {
        await embedding.unload(signal);
        return localNormalModel(request, signal);
      },
      signal,
    );
  const normalSemanticSearch: NormalSemanticSearch = async ({
    query,
    records,
    signal,
  }) => {
    const result = await service.search({ owner, query, signal });
    return {
      records: guardSemanticRecords(
        records,
        result.hits.map((hit) => hit.record),
      ),
      coverage: result.coverage,
      matches: result.hits.map((hit) => ({
        record_key: hit.record.record_key,
        ...hit.passage,
        similarity: hit.similarity,
      })),
    };
  };
  const privateSemanticSearch: PrivateSemanticSearch = async ({
    query,
    selector,
  }) => {
    const [contacts, states] = await Promise.all([
        store.contacts(owner),
        store.sourceStatus(owner),
      ]),
      ids = await resolvePrivateSearchSelection(
        selector,
        policy,
        contacts,
        states,
      );
    const group = policy.verified_contact_groups?.find(
      (group) => group.id === selector,
    );
    const result = await service.search({
      owner,
      query,
      ...(ids ? { contactIds: ids } : {}),
      ...(group
        ? {
            accounts: group.members.map((member) => ({
              source: member.source,
              account_id: member.account_id,
              contact_id: member.contact_id,
            })),
          }
        : {}),
    });
    const records = guardSemanticRecords(
      eligibleRecords(
        await store.interactions(owner),
        new Date(),
        policy,
        await store.sourceStatus(owner),
        owner,
        true,
      ),
      result.hits.map((hit) => hit.record),
    );
    const prepared = {
      reply: { outbound_sent: false as const, semantic_results: records },
      record_guards: records.map((record) => ({
        record_key: record.record_key,
        content_hash: record.content_hash,
      })),
    };
    const checked = await store.validatePreparedRead(
      {
        owner_id: owner,
        user_id: "live-owner",
        chat_id: "live-private",
        chat_type: "private",
        text: "Read semantic search",
      },
      prepared,
    );
    if (JSON.stringify(checked) !== JSON.stringify(prepared.reply))
      throw new Error("Search evidence changed");
    await resolvePrivateSearchSelection(
      selector,
      policy,
      await store.contacts(owner),
      await store.sourceStatus(owner),
    );
    return {
      records,
      matches: result.hits
        .filter((hit) =>
          records.some(
            (record) =>
              record.record_key === hit.record.record_key &&
              record.content_hash === hit.record.content_hash &&
              record.body_text.slice(hit.passage.start, hit.passage.end) ===
                hit.passage.text,
          ),
        )
        .map((hit) => ({
          record_key: hit.record.record_key,
          ...hit.passage,
          similarity: hit.similarity,
        })),
      mode: "semantic",
      coverage: result.coverage,
      warning:
        "Similarity finds relevant text; it does not establish identity. Coverage may be partial.",
    };
  };
  const run = async (): Promise<void> => {
    try {
      const initial = await service.initialiseSnapshot(owner);
      if (initial.pending === 0) await service.refreshSnapshot(owner);
      while (!stop.signal.aborted) {
        const progress = await service.indexBatch(owner, stop.signal);
        if (progress.pending === 0) break;
      }
    } catch {
      if (!stop.signal.aborted)
        console.error(
          "Private semantic indexing paused. Coverage remains partial.",
        );
    } finally {
      if (!stop.signal.aborted) {
        timer = setTimeout(() => {
          loop = run();
        }, 60000);
        timer.unref();
      }
    }
  };
  return {
    normalModel,
    normalSemanticSearch,
    privateSemanticSearch,
    start: () => {
      if (started) return;
      started = true;
      loop = run();
    },
    close: async () => {
      stop.abort();
      if (timer) clearTimeout(timer);
      await loop;
      await pool.end();
    },
  };
}
