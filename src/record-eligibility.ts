import type { NormalizedRecord, SourceState } from "./engine.ts";
import {
  calendarWindow,
  calendarHistoryWindow,
  messageHistoryStart,
  type LivePolicy,
} from "./live-policy.ts";
export function eligibleRecords(
  records: NormalizedRecord[],
  now: Date,
  policy: LivePolicy,
  states: SourceState[],
  owner: string,
  enforcePolicy: boolean,
  purpose: "history" | "current" = "current",
): NormalizedRecord[] {
  const window =
    purpose === "history"
      ? calendarHistoryWindow(policy, now)
      : calendarWindow(policy, now);
  const mailStart = Date.parse(messageHistoryStart(policy, "gmail", now));
  const socialStart = Date.parse(messageHistoryStart(policy, "linkedin", now));
  return records.filter(
    (r) =>
      r.owner_id === owner &&
      !r.cancelled &&
      (!enforcePolicy ||
        (r.source === "gmail"
          ? r.account_id.toLowerCase() === policy.account_email.toLowerCase()
          : r.source === "calendar"
            ? policy.calendar_ids.includes(r.account_id) ||
              Boolean(
                policy.manual_calendar_snapshots?.some(
                  (snapshot) =>
                    snapshot.calendar_id === r.account_id &&
                    snapshot.event_id === r.source_record_id,
                ),
              )
            : Boolean(
                policy.social?.accounts.some(
                  (account) =>
                    account.source === r.source &&
                    account.account_id === r.account_id &&
                    account.owner_verified,
                ),
              ))) &&
      states.some(
        (s) =>
          s.owner_id === r.owner_id &&
          s.source === r.source &&
          s.account_id === r.account_id &&
          s.status !== "revoked",
      ) &&
      ["live", "snapshot"].includes(r.ingestion_mode) &&
      (r.source === "calendar"
        ? Date.parse(r.end_at ?? r.occurred_at) > Date.parse(window.start) &&
          Date.parse(r.occurred_at) < Date.parse(window.end)
        : Date.parse(r.occurred_at) >=
            (r.source === "gmail" ? mailStart : socialStart) &&
          Date.parse(r.occurred_at) <= now.getTime()),
  );
}
