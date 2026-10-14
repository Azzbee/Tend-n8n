/** Private operator input only. This tracked example has fictional identities. */
export interface LivePolicy {
  principal_id: string;
  account_email: string;
  verified_owner_emails: string[];
  calendar_ids: string[];
  timezone: "Europe/Paris";
  mail_window_days: 30;
  calendar_window_days: 7;
  limits: {
    max_records_per_run: number;
    max_run_ms: number;
    max_attempts: number;
    max_body_bytes: number;
    max_page_size: number;
  };
}
export const exampleLivePolicy: LivePolicy = {
  principal_id: "fictional-owner",
  account_email: "owner@example.invalid",
  verified_owner_emails: ["owner@example.invalid"],
  calendar_ids: ["primary", "fictional-timetable@example.invalid"],
  timezone: "Europe/Paris",
  mail_window_days: 30,
  calendar_window_days: 7,
  limits: {
    max_records_per_run: 100,
    max_run_ms: 60_000,
    max_attempts: 3,
    max_body_bytes: 262_144,
    max_page_size: 100,
  },
};

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("invalid policy object");
  return value as Record<string, unknown>;
}
function nonempty(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value !== value.trim() ||
    Array.from(value).some(
      (c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
    )
  )
    throw new Error("invalid policy string");
  return value;
}
function list(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length)
    throw new Error("empty policy allowlist");
  const result = value.map(nonempty);
  if (new Set(result).size !== result.length)
    throw new Error("duplicate allowlist entry");
  return result;
}
/** Does not load files, infer accounts, or broaden the approved windows. */
export function parseLivePolicy(input: unknown): LivePolicy {
  const value = object(input);
  const keys = [
    "principal_id",
    "account_email",
    "verified_owner_emails",
    "calendar_ids",
    "timezone",
    "mail_window_days",
    "calendar_window_days",
    "limits",
  ];
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw new Error("unknown policy field");
  if (
    value.timezone !== "Europe/Paris" ||
    value.mail_window_days !== 30 ||
    value.calendar_window_days !== 7
  )
    throw new Error("unapproved policy scope");
  const limits = object(value.limits);
  const ceilings = {
    max_records_per_run: 1000,
    max_run_ms: 300_000,
    max_attempts: 5,
    max_body_bytes: 1_048_576,
    max_page_size: 500,
  };
  if (Object.keys(limits).some((key) => !(key in ceilings)))
    throw new Error("unknown policy limit");
  const parsedLimits = { ...exampleLivePolicy.limits };
  for (const key of Object.keys(ceilings) as (keyof typeof ceilings)[]) {
    const n = limits[key];
    if (
      typeof n !== "number" ||
      !Number.isInteger(n) ||
      n < 1 ||
      n > ceilings[key]
    )
      throw new Error(`invalid policy limit ${key}`);
    parsedLimits[key] = n;
  }
  const account = nonempty(value.account_email);
  const aliases = list(value.verified_owner_emails);
  // Policy contains verified exact mailbox spellings, never name-based aliases.
  const email =
    /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z0-9-]+$/;
  if (
    !email.test(account) ||
    account !== account.toLowerCase() ||
    aliases.some((a) => !email.test(a)) ||
    !aliases.includes(account)
  )
    throw new Error("invalid verified account/aliases");
  return {
    principal_id: nonempty(value.principal_id),
    account_email: account,
    verified_owner_emails: aliases,
    calendar_ids: list(value.calendar_ids),
    timezone: "Europe/Paris",
    mail_window_days: 30,
    calendar_window_days: 7,
    limits: parsedLimits,
  };
}
export function validateLivePolicy(policy: LivePolicy): void {
  parseLivePolicy(policy);
}

export function assertGoogleRead(
  policy: LivePolicy,
  account_email: string,
  operation: string,
  calendar_id?: string,
): void {
  validateLivePolicy(policy);
  if (account_email !== policy.account_email)
    throw new Error("Google account binding mismatch");
  if (
    ["gmail.profile.get", "gmail.messages.list", "gmail.messages.get"].includes(
      operation,
    )
  )
    return;
  if (operation === "calendar.calendarList.list") return;
  if (
    [
      "calendar.calendarList.get",
      "calendar.events.list",
      "calendar.events.get",
    ].includes(operation)
  ) {
    if (!calendar_id || !policy.calendar_ids.includes(calendar_id))
      throw new Error("calendar not approved");
    return;
  }
  throw new Error("Google operation denied; reads only");
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}
function localParts(date: Date, timezone: string): LocalParts {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string): number =>
    Number(parts.find((p) => p.type === type)?.value);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}
function wallMillis(p: LocalParts): number {
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}
/** Provider event times are strict; rolling windows choose the earlier fold or advance by a gap. */
export function zonedLocalInstant(
  value: string,
  timezone: string,
  allowAmbiguous = false,
): Date {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(value))
    throw new Error("invalid local date/time");
  const reference = new Date(`${value}Z`);
  if (
    !Number.isFinite(reference.getTime()) ||
    reference.toISOString().slice(0, 19) !== value
  )
    throw new Error("invalid local date/time");
  const target = reference.getTime(),
    candidates = new Set<number>();
  const gapCandidates: { instant: number; wall: number }[] = [];
  const beforeGap: number[] = [];
  for (const shift of [-86_400_000, 0, 86_400_000]) {
    const probe = new Date(target + shift);
    const offset = wallMillis(localParts(probe, timezone)) - probe.getTime();
    const instant = target - offset;
    const wall = wallMillis(localParts(new Date(instant), timezone));
    if (wall === target) candidates.add(instant);
    else if (wall > target) gapCandidates.push({ instant, wall });
    else beforeGap.push(instant);
  }
  const found = [...candidates].sort((a, b) => a - b);
  if (!found.length && allowAmbiguous && gapCandidates.length) {
    // Clamp to the transition so advancing past the gap cannot shorten the window.
    gapCandidates.sort((a, b) => a.wall - b.wall || a.instant - b.instant);
    let high = gapCandidates[0]!.instant;
    const lower = beforeGap.filter((x) => x < high);
    if (!lower.length) throw new Error("invalid timezone gap bounds");
    let low = Math.max(...lower);
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (wallMillis(localParts(new Date(middle), timezone)) >= target)
        high = middle;
      else low = middle + 1;
    }
    return new Date(high);
  }
  if (!found.length || (found.length !== 1 && !allowAmbiguous))
    throw new Error("ambiguous/nonexistent local date/time");
  return new Date(found[0]!);
}
export interface LiveWindow {
  start: string;
  end: string;
}
function validNow(now: Date): void {
  if (!Number.isFinite(now.getTime()))
    throw new Error("invalid injected clock");
}
export function gmailWindow(policy: LivePolicy, now: Date): LiveWindow {
  validateLivePolicy(policy);
  validNow(now);
  return {
    start: new Date(now.getTime() - 30 * 86_400_000).toISOString(),
    end: now.toISOString(),
  };
}
export function calendarWindow(policy: LivePolicy, now: Date): LiveWindow {
  validateLivePolicy(policy);
  validNow(now);
  let local = localParts(now, policy.timezone);
  const firstOccurrence = zonedLocalInstant(
    new Date(wallMillis(local)).toISOString().slice(0, 19),
    policy.timezone,
    true,
  ).getTime();
  const secondOccurrence =
    Math.floor(now.getTime() / 1000) * 1000 > firstOccurrence;
  if (secondOccurrence) {
    // Anchor the repeated hour at its end instead of moving future coverage backwards.
    let low = now.getTime(),
      high =
        now.getTime() +
        (Math.floor(now.getTime() / 1000) * 1000 - firstOccurrence);
    while (low < high) {
      const middle = Math.floor((low + high) / 2),
        parts = localParts(new Date(middle), policy.timezone);
      const earliest = zonedLocalInstant(
        new Date(wallMillis(parts)).toISOString().slice(0, 19),
        policy.timezone,
        true,
      ).getTime();
      if (earliest === Math.floor(middle / 1000) * 1000) high = middle;
      else low = middle + 1;
    }
    local = localParts(new Date(high), policy.timezone);
  }
  const shifted = new Date(wallMillis(local) + 7 * 86_400_000);
  const end = zonedLocalInstant(
    shifted.toISOString().slice(0, 19),
    policy.timezone,
    true,
  );
  if (
    !secondOccurrence &&
    wallMillis(localParts(end, policy.timezone)) === shifted.getTime()
  )
    end.setUTCMilliseconds(now.getUTCMilliseconds());
  return { start: now.toISOString(), end: end.toISOString() };
}
