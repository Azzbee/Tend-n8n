import { DailyBriefingService } from "./daily-briefing.ts";
import type { TendStore, Reply } from "./engine.ts";
import type { LiveStore } from "./live-store.ts";
import type { LivePolicy } from "./live-policy.ts";
import { prepareNormalReply, type NormalModel } from "./telegram-normal.ts";

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function short(value: unknown, max: number): string {
  return typeof value === "string"
    ? Array.from(value)
        .filter(
          (char) => char.charCodeAt(0) >= 32 || char === "\n" || char === "\t",
        )
        .filter((char) => char.charCodeAt(0) !== 127)
        .slice(0, max)
        .join("")
    : "";
}
export function formatDailyDigest(reply: Reply): string {
  if (
    reply.outbound_sent !== false ||
    !Array.isArray(reply.priorities) ||
    !Array.isArray(reply.coverage)
  )
    throw new Error("Current priority digest required");
  const lines = [
    "Priority review. Suggestions are for your review; nothing is sent to contacts.",
  ];
  const priorities = reply.priorities.filter(object).slice(0, 5);
  if (!priorities.length)
    lines.push(
      "No eligible imported priorities. This does not establish that no work exists.",
    );
  for (const item of priorities)
    lines.push(
      `${short(item.kind, 30)}: ${short(item.reason, 130)} ${short(item.date, 40)}\n${short(item.text, 320)}\n[${short(item.source, 30)}] ${short(item.reference, 240)}`,
    );
  const pending = Array.isArray(reply.priority_pending)
    ? reply.priority_pending.filter(object).slice(0, 5)
    : [];
  if (pending.length) {
    lines.push("Unconfirmed proposals. These are not deadlines.");
    for (const item of pending)
      lines.push(
        `${short(item.text, 200)} [${short(item.source, 30)}] ${short(item.reference, 180)}`,
      );
  }
  const unavailable = reply.priority_unavailable_count;
  if (typeof unavailable === "number" && unavailable > 0)
    lines.push(
      `${unavailable} promises or proposals have unavailable current evidence.`,
    );
  lines.push(
    "Imported coverage may be partial. Provider errors and snapshots need review.",
  );
  for (const source of reply.coverage.filter(object).slice(0, 8))
    lines.push(
      `${short(source.source, 30)}: ${short(source.status, 30)} (${short(source.mode, 20)}); ${short(source.coverage_start, 30)} to ${short(source.coverage_end, 30)}`,
    );
  const text = lines.join("\n\n");
  return text.length <= 3900
    ? text
    : text.slice(0, 3780) +
        "\n\nDigest shortened. Open the private workspace for complete imported details and source coverage.";
}
function canonical(value: unknown): string {
  const stable = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(stable)
      : object(v)
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, stable(v[k])]),
          )
        : v;
  return JSON.stringify(stable(value));
}
function selection(
  input: unknown,
  acknowledge = false,
): { paris_date: string; delivery_id: string; receipt?: unknown } {
  const keys = acknowledge
    ? ["paris_date", "delivery_id", "receipt"]
    : ["paris_date", "delivery_id"];
  if (
    !object(input) ||
    Object.keys(input).length !== keys.length ||
    Object.keys(input).some((k) => !keys.includes(k)) ||
    typeof input.paris_date !== "string" ||
    typeof input.delivery_id !== "string"
  )
    throw new Error("Exact daily delivery selection required");
  return {
    paris_date: input.paris_date,
    delivery_id: input.delivery_id,
    ...(acknowledge ? { receipt: input.receipt } : {}),
  };
}
/** Caller must enforce existing internal API authentication before invoking mutations. */
export function createDailyAPI(options: {
  store: TendStore | LiveStore;
  policy: LivePolicy;
  owner: { owner_id: string; user_id: string; chat_id: string };
  clock?: () => Date;
  normalModel?: NormalModel;
  enabledAt?: string;
}) {
  const { store, policy, owner } = options;
  if (owner.owner_id !== policy.principal_id)
    throw new Error("Daily policy owner mismatch");
  const principal = {
    owner_id: policy.principal_id,
    user_id: "live-owner",
    chat_id: "live-private",
    chat_type: "private",
    text: "Daily owner priority briefing",
  };
  const service = new DailyBriefingService({
    owner,
    ledger: {
      get: async (id, day) => store.dailyBriefingGet(id, day),
      latest: async (id, sentOnly) => store.dailyBriefingLatest(id, sentOnly),
      insert: async (row) => store.dailyBriefingInsert(row),
      replace: async (revision, row) =>
        store.dailyBriefingReplace(revision, row),
    },
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.enabledAt ? { enabledAt: options.enabledAt } : {}),
    prepare: async (now, signal) =>
      prepareNormalReply({
        auth: principal,
        store,
        policy,
        clock: () => now,
        signal,
        exactDailyIntent: "digest",
        ...(options.normalModel ? { model: options.normalModel } : {}),
      }),
    validateAndFormat: async (prepared) => {
      const reply = await store.validatePreparedRead(
        principal,
        prepared,
        policy,
      );
      if (canonical(reply) !== canonical(prepared.reply)) return null;
      return formatDailyDigest(reply);
    },
  });
  return {
    status: () => service.status(),
    prepare: () => service.prepare(),
    claim: async (input: unknown) => {
      const selected = selection(input);
      return {
        transport: await service.claim(
          selected.paris_date,
          selected.delivery_id,
        ),
        outbound_sent: false,
      };
    },
    acknowledge: async (input: unknown) => {
      const selected = selection(input, true);
      return {
        acknowledged: await service.acknowledge(
          selected.paris_date,
          selected.delivery_id,
          selected.receipt,
        ),
        outbound_sent: false,
      };
    },
    uncertain: async (input: unknown) => {
      const selected = selection(input);
      await service.markUncertain(selected.paris_date, selected.delivery_id);
      return { held: true, outbound_sent: false };
    },
  };
}
