import { createHash } from "node:crypto";
import { statfs } from "node:fs/promises";
import { Pool, type PoolConfig } from "pg";
import type { Contact, NormalizedRecord, SourceState } from "./engine.ts";
import type { LiveStore } from "./live-store.ts";
import {
  allAvailableHistory,
  type LivePolicy,
  type VerifiedContactGroup,
} from "./live-policy.ts";
import { eligibleRecords } from "./record-eligibility.ts";
import {
  localNormalModel,
  type NormalModel,
  type NormalSemanticSearch,
} from "./telegram-normal.ts";
import { retrieveRelevantEvidence } from "./semantic-relevance.ts";
import type { PrivateSemanticSearch } from "./private-web-types.ts";
import {
  LocalModelCoordinator,
  OllamaEmbeddingClient,
  SemanticSearchService,
} from "./semantic-search.ts";

export const PRIVATE_EMBEDDING_DIGEST =
  "1a37926bf842899cbf90583e3932f3820548716d9d07661ba622199ffe95c552";
export { guardSemanticRecords } from "./semantic-relevance.ts";
/** Display names only support relevance after an exact stored actor binding. */
export function semanticActorNames(
  owner: string,
  records: NormalizedRecord[],
  contacts: (Contact & { emails: string[] })[],
): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  for (const record of records) {
    if (record.owner_id !== owner) continue;
    const ids = new Set([record.contact_id, ...(record.contact_ids ?? [])]);
    const matches = contacts.filter(
      (contact) =>
        contact.owner_id === owner &&
        contact.contact_id !== "OWNER" &&
        ids.has(contact.contact_id) &&
        contact.emails.includes(record.actor_identity),
    );
    if (matches.length === 1 && matches[0]!.name.trim())
      names.set(record.record_key, matches[0]!.name.slice(0, 120));
  }
  return names;
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
// One minute's share of semantic indexing: a resumed backlog is embedded a
// few records per cycle instead of all at once, so local Ollama stays light.
export const INDEX_RECORDS_PER_CYCLE = 20;
export async function indexCycle(
  step: () => Promise<{ pending: number }>,
  signal: AbortSignal,
  max = INDEX_RECORDS_PER_CYCLE,
): Promise<number> {
  let done = 0;
  while (!signal.aborted && done < max) {
    done++;
    if ((await step()).pending === 0) break;
  }
  return done;
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
        eligibleRecords([record], now, policy, states, owner, true, "history")
          .length === 1,
      expiresAt: (record, now) =>
        new Date(
          (
            record.source === "gmail" || record.source === "calendar"
              ? allAvailableHistory(policy)
              : Boolean(policy.social && allAvailableHistory(policy.social))
          )
            ? now.getTime() + 30 * 86400000
            : record.source === "calendar"
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
  const retrieve = async (
    query: string,
    records: NormalizedRecord[],
    signal: AbortSignal,
    ids?: string[],
    group?: VerifiedContactGroup,
    contacts?: (Contact & { emails: string[] })[],
  ) =>
    retrieveRelevantEvidence({
      actorNames: semanticActorNames(
        owner,
        records,
        contacts ?? (await store.contacts(owner)),
      ),
      owner,
      query,
      records,
      signal,
      infer: normalModel,
      search: (searchSignal) =>
        service.search({
          owner,
          query,
          limit: 12,
          signal: searchSignal,
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
        }),
    });
  const normalSemanticSearch: NormalSemanticSearch = ({
    query,
    records,
    signal,
  }) => retrieve(query, records, signal);
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
    const canonical = eligibleRecords(
      await store.interactions(owner),
      new Date(),
      policy,
      await store.sourceStatus(owner),
      owner,
      true,
      "history",
    ).filter(
      (record) =>
        (!ids ||
          ids.includes(record.contact_id) ||
          record.contact_ids?.some((id) => ids.includes(id))) &&
        (!group ||
          group.members.some(
            (member) =>
              member.source === record.source &&
              member.account_id === record.account_id &&
              (member.contact_id === record.contact_id ||
                record.contact_ids?.includes(member.contact_id)),
          )),
    );
    const result = await retrieve(
      query,
      canonical,
      AbortSignal.timeout(45000),
      ids,
      group,
      contacts,
    );
    const records = result.records;
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
      policy,
    );
    if (JSON.stringify(checked) !== JSON.stringify(prepared.reply))
      throw new Error("Search evidence changed");
    await resolvePrivateSearchSelection(
      selector,
      policy,
      await store.contacts(owner),
      await store.sourceStatus(owner),
    );
    return { ...result, records };
  };
  const run = async (): Promise<void> => {
    try {
      const initial = await service.initialiseSnapshot(owner);
      if (initial.pending === 0) await service.refreshSnapshot(owner);
      await indexCycle(
        () => service.indexBatch(owner, stop.signal),
        stop.signal,
      );
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
