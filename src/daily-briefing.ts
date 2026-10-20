import { randomUUID } from "node:crypto";
import { zonedLocalInstant } from "./live-policy.ts";
import type { PreparedTelegramRead } from "./telegram-normal.ts";

export type DailyBriefingState =
  "pending" | "sending" | "sent" | "uncertain" | "missed";
export type DailyBriefingFailure =
  | "preparation_failed"
  | "evidence_changed"
  | "validation_failed"
  | "delivery_uncertain"
  | null;
export interface DailyBriefingRow {
  owner_id: string;
  paris_date: string;
  delivery_id: string;
  revision: number;
  scheduled_at: string;
  updated_at: string;
  state: DailyBriefingState;
  attempts: number;
  prepared: PreparedTelegramRead | null;
  prepared_at: string | null;
  telegram_message_id: number | null;
  failure: DailyBriefingFailure;
}
/** Both mutations must be atomic and durable before resolving. */
export interface DailyBriefingLedger {
  get(owner: string, day: string): Promise<DailyBriefingRow | null>;
  latest(owner: string, sentOnly?: boolean): Promise<DailyBriefingRow | null>;
  insert(row: DailyBriefingRow): Promise<boolean>;
  replace(expectedRevision: number, row: DailyBriefingRow): Promise<boolean>;
}
export interface DailyBriefingSchedule {
  paris_date: string;
  scheduled_at: string;
  next_scheduled_at: string;
  due: boolean;
  missed: boolean;
  catch_up: boolean;
}
export interface DailyBriefingSelection {
  paris_date: string;
  delivery_id: string | null;
  state: DailyBriefingState | "not_due";
  scheduled_at: string;
  catch_up: boolean;
  accounting_partial?: boolean;
}
export interface DailyBriefingTransport {
  paris_date: string;
  delivery_id: string;
  chat_id: string;
  text: string;
}
interface Options {
  owner: { owner_id: string; user_id: string; chat_id: string };
  ledger: DailyBriefingLedger;
  clock?: () => Date;
  enabledAt?: string;
  prepare(now: Date, signal: AbortSignal): Promise<PreparedTelegramRead>;
  validateAndFormat(
    prepared: PreparedTelegramRead,
    now: Date,
    signal: AbortSignal,
  ): Promise<string | null>;
}
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
function validDay(day: string): boolean {
  return (
    DAY.test(day) &&
    Number.isFinite(Date.parse(day)) &&
    new Date(day).toISOString().slice(0, 10) === day
  );
}
function parisDate(now: Date): string {
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid daily clock");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: string): string =>
    parts.find((p) => p.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
export function dailyBriefingSchedule(now: Date): DailyBriefingSchedule {
  const day = parisDate(now);
  const scheduled = zonedLocalInstant(`${day}T09:00:00`, "Europe/Paris");
  const cutoff = zonedLocalInstant(`${day}T12:00:00`, "Europe/Paris");
  const nextDay = new Date(Date.parse(`${day}T00:00:00Z`) + 86400000)
    .toISOString()
    .slice(0, 10);
  return {
    paris_date: day,
    scheduled_at: scheduled.toISOString(),
    next_scheduled_at: (now < scheduled
      ? scheduled
      : zonedLocalInstant(`${nextDay}T09:00:00`, "Europe/Paris")
    ).toISOString(),
    due: now >= scheduled && now < cutoff,
    missed: now >= cutoff,
    catch_up: now.getTime() >= scheduled.getTime() + 60000 && now < cutoff,
  };
}
async function bounded<T>(
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("Daily preparation deadline exceeded"));
        }, 45000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
  }
}
export class DailyBriefingService {
  private readonly options: Options;
  private readonly clock: () => Date;
  private readonly enabledDay: string;
  constructor(options: Options) {
    const owner = options.owner;
    if (
      !/^[A-Za-z0-9_-]{1,128}$/.test(owner.owner_id) ||
      !/^[1-9]\d{0,15}$/.test(owner.user_id) ||
      owner.chat_id !== owner.user_id
    )
      throw new Error("Exact enrolled private daily owner required");
    this.options = options;
    this.clock = options.clock ?? (() => new Date());
    const enabled = options.enabledAt
      ? new Date(options.enabledAt)
      : this.clock();
    if (!Number.isFinite(enabled.getTime()) || enabled > this.clock())
      throw new Error("Valid non-future daily enablement time required");
    this.enabledDay = parisDate(enabled);
  }
  private async row(day: string): Promise<DailyBriefingRow | null> {
    if (!validDay(day)) throw new Error("Invalid daily date");
    const row = await this.options.ledger.get(this.options.owner.owner_id, day);
    if (
      row &&
      (row.owner_id !== this.options.owner.owner_id ||
        row.paris_date !== day ||
        !UUID.test(row.delivery_id) ||
        !Number.isSafeInteger(row.revision) ||
        row.revision < 0)
    )
      throw new Error("Daily ledger binding changed");
    return row;
  }
  private async replace(
    row: DailyBriefingRow,
    change: Partial<DailyBriefingRow>,
  ): Promise<boolean> {
    return this.options.ledger.replace(row.revision, {
      ...row,
      ...change,
      revision: row.revision + 1,
      updated_at: this.clock().toISOString(),
    });
  }
  private selection(
    schedule: DailyBriefingSchedule,
    row: DailyBriefingRow | null,
  ): DailyBriefingSelection {
    return {
      paris_date: schedule.paris_date,
      scheduled_at: schedule.scheduled_at,
      catch_up: schedule.catch_up,
      delivery_id: row?.delivery_id ?? null,
      state: row?.state ?? "not_due",
    };
  }
  private async reconcileMissed(
    schedule: DailyBriefingSchedule,
  ): Promise<boolean> {
    const latest = await this.options.ledger.latest(
      this.options.owner.owner_id,
    );
    if (
      latest &&
      (latest.owner_id !== this.options.owner.owner_id ||
        !validDay(latest.paris_date) ||
        latest.paris_date > schedule.paris_date)
    )
      throw new Error("Daily latest ledger binding changed");
    if (latest?.paris_date === schedule.paris_date) return true;
    if (latest?.state === "sending")
      await this.replace(latest, {
        state: "uncertain",
        prepared: null,
        failure: "delivery_uncertain",
      });
    else if (latest?.state === "pending")
      await this.replace(latest, { state: "missed", prepared: null });
    let day = latest
      ? new Date(Date.parse(latest.paris_date) + 86400000)
          .toISOString()
          .slice(0, 10)
      : this.enabledDay;
    for (let count = 0; day < schedule.paris_date && count < 31; count++) {
      const scheduled_at = zonedLocalInstant(
        `${day}T09:00:00`,
        "Europe/Paris",
      ).toISOString();
      await this.options.ledger.insert(
        this.initial(
          { ...schedule, paris_date: day, scheduled_at },
          this.clock(),
          "missed",
        ),
      );
      day = new Date(Date.parse(day) + 86400000).toISOString().slice(0, 10);
    }
    return day >= schedule.paris_date;
  }
  async prepare(): Promise<DailyBriefingSelection> {
    const now = this.clock(),
      schedule = dailyBriefingSchedule(now);
    if (!(await this.reconcileMissed(schedule)))
      return { ...this.selection(schedule, null), accounting_partial: true };
    let row = await this.row(schedule.paris_date);
    if (row?.state === "sending") {
      await this.replace(row, {
        state: "uncertain",
        failure: "delivery_uncertain",
        prepared: null,
      });
      row = await this.row(schedule.paris_date);
    }
    if (row && ["sent", "uncertain", "missed"].includes(row.state))
      return this.selection(schedule, row);
    if (!schedule.due && !schedule.missed) return this.selection(schedule, row);
    if (schedule.missed) {
      if (row) await this.replace(row, { state: "missed", prepared: null });
      else
        await this.options.ledger.insert(this.initial(schedule, now, "missed"));
      return this.selection(schedule, await this.row(schedule.paris_date));
    }
    if (
      row?.prepared &&
      row.prepared_at &&
      now.getTime() - Date.parse(row.prepared_at) < 300000
    )
      return this.selection(schedule, row);
    if (
      row &&
      (row.attempts >= 3 || now.getTime() - Date.parse(row.updated_at) < 60000)
    )
      return this.selection(schedule, row);
    if (!row) {
      row = this.initial(schedule, now, "pending");
      if (!(await this.options.ledger.insert(row)))
        return this.selection(schedule, await this.row(schedule.paris_date));
    } else {
      if (
        !(await this.replace(row, {
          attempts: row.attempts + 1,
          prepared: null,
          prepared_at: null,
          failure: null,
        }))
      )
        return this.selection(schedule, await this.row(schedule.paris_date));
      row = (await this.row(schedule.paris_date))!;
    }
    try {
      const prepared = await bounded((signal) =>
        this.options.prepare(now, signal),
      );
      if (
        !prepared ||
        prepared.reply?.outbound_sent !== false ||
        !Array.isArray(prepared.record_guards) ||
        Buffer.byteLength(JSON.stringify(prepared)) > 262144
      )
        throw new Error("Invalid daily prepared read");
      await this.replace(row, {
        prepared,
        prepared_at: this.clock().toISOString(),
        failure: null,
      });
    } catch {
      await this.replace(row, {
        prepared: null,
        prepared_at: null,
        failure: "preparation_failed",
      });
    }
    return this.selection(schedule, await this.row(schedule.paris_date));
  }
  private initial(
    schedule: DailyBriefingSchedule,
    now: Date,
    state: "pending" | "missed",
  ): DailyBriefingRow {
    return {
      owner_id: this.options.owner.owner_id,
      paris_date: schedule.paris_date,
      delivery_id: randomUUID(),
      revision: 0,
      scheduled_at: schedule.scheduled_at,
      updated_at: now.toISOString(),
      state,
      attempts: state === "pending" ? 1 : 0,
      prepared: null,
      prepared_at: null,
      telegram_message_id: null,
      failure: null,
    };
  }
  async claim(
    day: string,
    delivery: string,
  ): Promise<DailyBriefingTransport | null> {
    if (!validDay(day) || !UUID.test(delivery))
      throw new Error("Invalid daily delivery selection");
    const now = this.clock(),
      schedule = dailyBriefingSchedule(now);
    if (!schedule.due || day !== schedule.paris_date) return null;
    const row = await this.row(day);
    if (
      !row ||
      row.delivery_id !== delivery ||
      row.state !== "pending" ||
      !row.prepared ||
      !row.prepared_at ||
      now.getTime() - Date.parse(row.prepared_at) >= 300000
    )
      return null;
    let text: string | null;
    try {
      text = await bounded((signal) =>
        this.options.validateAndFormat(row.prepared!, now, signal),
      );
    } catch {
      await this.replace(row, {
        prepared: null,
        prepared_at: null,
        failure: "validation_failed",
      });
      return null;
    }
    if (text === null) {
      await this.replace(row, {
        prepared: null,
        prepared_at: null,
        failure: "evidence_changed",
      });
      return null;
    }
    const current = dailyBriefingSchedule(this.clock());
    if (!current.due || current.paris_date !== day) return null;
    if (typeof text !== "string" || !text.trim() || text.length > 3900)
      throw new Error("Daily formatted reply exceeds transport bounds");
    const header = `Tend daily briefing · ${day} · 09:00 Europe/Paris${current.catch_up ? " · catch-up" : ""}\n\n`;
    if (header.length + text.length > 4096)
      throw new Error("Daily transport text exceeds bound");
    if (
      !(await this.replace(row, {
        state: "sending",
        prepared: null,
        failure: null,
      }))
    )
      return null;
    return {
      paris_date: day,
      delivery_id: delivery,
      chat_id: this.options.owner.chat_id,
      text: header + text,
    };
  }
  async markUncertain(day: string, delivery: string): Promise<void> {
    if (!validDay(day) || !UUID.test(delivery))
      throw new Error("Invalid daily delivery selection");
    const row = await this.row(day);
    if (row?.delivery_id === delivery && row.state === "sending")
      await this.replace(row, {
        state: "uncertain",
        prepared: null,
        failure: "delivery_uncertain",
      });
  }
  async acknowledge(
    day: string,
    delivery: string,
    receipt: unknown,
  ): Promise<boolean> {
    if (!validDay(day) || !UUID.test(delivery))
      throw new Error("Invalid daily delivery selection");
    const object = (v: unknown): v is Record<string, unknown> =>
      typeof v === "object" && v !== null && !Array.isArray(v);
    if (!object(receipt))
      throw new Error("Actual matching private owner acknowledgement required");
    const wrapped = Object.hasOwn(receipt, "result");
    if (
      (wrapped && receipt.ok !== true) ||
      (!wrapped && Object.hasOwn(receipt, "ok"))
    )
      throw new Error("Actual matching private owner acknowledgement required");
    const messageReceipt = wrapped ? receipt.result : receipt;
    if (
      !object(messageReceipt) ||
      !Number.isSafeInteger(messageReceipt.message_id) ||
      Number(messageReceipt.message_id) <= 0 ||
      !object(messageReceipt.chat) ||
      messageReceipt.chat.type !== "private" ||
      !["number", "string"].includes(typeof messageReceipt.chat.id) ||
      String(messageReceipt.chat.id) !== this.options.owner.chat_id
    )
      throw new Error("Actual matching private owner acknowledgement required");
    const row = await this.row(day);
    if (!row || row.delivery_id !== delivery) return false;
    const message = Number(messageReceipt.message_id);
    if (row.state === "sent") return row.telegram_message_id === message;
    if (row.state !== "sending" && row.state !== "uncertain") return false;
    return this.replace(row, {
      state: "sent",
      prepared: null,
      telegram_message_id: message,
      failure: null,
    });
  }
  async status(): Promise<{
    schedule: DailyBriefingSchedule;
    delivery: Omit<DailyBriefingRow, "prepared"> | null;
    latest_delivery: Omit<DailyBriefingRow, "prepared"> | null;
    last_sent_delivery: Omit<DailyBriefingRow, "prepared"> | null;
  }> {
    const schedule = dailyBriefingSchedule(this.clock());
    const row = await this.row(schedule.paris_date);
    const latest = await this.options.ledger.latest(
      this.options.owner.owner_id,
    );
    if (
      latest &&
      (latest.owner_id !== this.options.owner.owner_id ||
        !validDay(latest.paris_date) ||
        latest.paris_date > schedule.paris_date)
    )
      throw new Error("Daily latest ledger binding changed");
    const safe = (
      entry: DailyBriefingRow | null,
    ): Omit<DailyBriefingRow, "prepared"> | null => {
      if (!entry) return null;
      const { prepared: _prepared, ...summary } = entry;
      void _prepared;
      return summary;
    };
    const lastSent = await this.options.ledger.latest(
      this.options.owner.owner_id,
      true,
    );
    if (
      lastSent &&
      (lastSent.owner_id !== this.options.owner.owner_id ||
        lastSent.state !== "sent" ||
        !validDay(lastSent.paris_date) ||
        lastSent.paris_date > schedule.paris_date)
    )
      throw new Error("Daily sent ledger binding changed");
    return {
      schedule,
      delivery: safe(row),
      latest_delivery: safe(latest),
      last_sent_delivery: safe(lastSent),
    };
  }
}
