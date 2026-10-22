import {
  confirmDefaultDate,
  deskHeadline,
  deskItemTitle,
  outreachActionable,
  outreachReasonLabels,
  parseOutreachList,
  reviewPosition,
  type DeskItem,
  type DeskRecordLine,
  type DeskRuns,
  type DeskSnapshot,
  type OutreachItem,
} from "./desk-model.ts";

export interface DeskContext {
  active: () => boolean;
  csrf: () => string | null;
  expired: () => void;
  notify: (message: string | null) => void;
  openContact: (contactId: string, name: string) => void;
}
export interface DeskController {
  route: (view: string) => void;
  clear: () => void;
}
export const deskViews = ["desk", "review", "people", "runs"] as const;
export function viewFromHash(hash: string): (typeof deskViews)[number] {
  const name = hash.replace(/^#/, "");
  if (name === "outreach") return "desk";
  return (deskViews as readonly string[]).includes(name)
    ? (name as (typeof deskViews)[number])
    : "desk";
}
const sourceLabels: Record<string, string> = {
  gmail: "Email",
  email: "Email",
  calendar: "Calendar",
  whatsapp_personal: "WhatsApp personal",
  whatsapp_business: "WhatsApp business",
  linkedin: "LinkedIn",
};
const sourceName = (source: string): string => sourceLabels[source] ?? source;
export function parisMoment(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("en-GB", {
        timeZone: "Europe/Paris",
        weekday: "short",
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      }).format(date);
}
export function parisToday(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" }).format(
    now,
  );
}
export function dueLabel(day: string | null, today?: string): string {
  if (!day) return "No due date";
  if (today && day < today) return "Overdue · " + dueLabel(day);
  const date = new Date(day + "T12:00:00Z");
  return Number.isNaN(date.getTime())
    ? day
    : "Due " +
        new Intl.DateTimeFormat("en-GB", {
          timeZone: "UTC",
          weekday: "short",
          day: "numeric",
          month: "short",
        }).format(date);
}
export function itemMeta(item: DeskItem): string {
  return [
    sourceName(item.source),
    item.direction === "owed_by_me"
      ? "you wrote"
      : `${item.contact_name} wrote`,
    item.occurred_at ? parisMoment(item.occurred_at) : "date unavailable",
    item.record_id,
  ].join(" · ");
}
const statusLabels: Record<string, string> = {
  confirmed: "Confirmed",
  pending: "Pending",
};
const runLabels: Record<string, string> = {
  success: "Last run passed",
  error: "Last run failed",
  running: "Running",
  unknown: "No run data on this device",
};
const outreachStatusLabels: Record<OutreachItem["status"], string> = {
  pending: "Waiting for your yes",
  approved: "Approved",
  skipped: "Skipped",
  gmail_draft_created: "Gmail draft created",
  expired: "Expired",
};
const outreachStatusDetail: Partial<Record<OutreachItem["status"], string>> = {
  gmail_draft_created: "Open Gmail and press Send yourself.",
  expired: "Tend proposes a fresh draft if it is still needed.",
};
const safeLink = (value: string | null | undefined): string | null => {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
};

export function mountDesk(ctx: DeskContext): DeskController {
  const get = (id: string): HTMLElement => {
    const found = document.getElementById(id);
    if (!found) throw new Error(`Missing desk element: ${id}`);
    return found;
  };
  const el = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    text?: string,
    className?: string,
  ): HTMLElementTagNameMap[K] => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const button = (
    text: string,
    className: string,
    onClick: () => void,
  ): HTMLButtonElement => {
    const node = el("button", text, className);
    node.type = "button";
    node.addEventListener("click", onClick);
    return node;
  };
  const containers = [
    "desk-pipeline",
    "desk-owe",
    "desk-owed",
    "desk-yes",
    "desk-not",
    "desk-held",
    "desk-meeting",
    "desk-outreach",
    "desk-coverage",
    "review-card",
    "review-progress",
    "runs-classroom",
    "runs-private",
    "runs-failures",
  ];
  let snapshot: DeskSnapshot | null = null;
  let outreach: OutreachItem[] | "disabled" | "unavailable" = [];
  let reviewIndex = 0;
  let current = "desk";
  let generation = 0;
  let busy = false;
  // Loads are aborted when superseded, before an action and on lock, so at most one Desk request is open.
  const loads = new Set<AbortController>();
  const posts = new Set<AbortController>();
  const abort = (set: Set<AbortController>): void => {
    for (const controller of set) controller.abort();
    set.clear();
  };

  async function request(path: string, body?: unknown): Promise<unknown> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (body !== undefined) {
      const csrf = ctx.csrf();
      if (!csrf) throw new Error("Unlock this device first.");
      headers["Content-Type"] = "application/json";
      headers["X-Tend-CSRF"] = csrf;
    }
    const controller = new AbortController();
    const owner = body === undefined ? loads : posts;
    owner.add(controller);
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(`/private/api/${path}`, {
        method: body === undefined ? "GET" : "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      if (response.status === 401) {
        ctx.expired();
        throw new Error("Unlock this device to continue.");
      }
      const value: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const error = new Error(
          value &&
            typeof value === "object" &&
            "error" in value &&
            typeof value.error === "string"
            ? value.error
            : "The private service could not complete this request.",
        ) as Error & { status?: number };
        error.status = response.status;
        throw error;
      }
      return value;
    } finally {
      clearTimeout(timeout);
      owner.delete(controller);
    }
  }
  const message = (error: unknown): string =>
    error instanceof Error
      ? error.message
      : "The private service is unavailable.";

  function empty(target: HTMLElement, text: string): void {
    target.replaceChildren(el("p", text, "small"));
  }
  function quote(text: string, className = "quote"): HTMLElement {
    return el("blockquote", `“${text}”`, className);
  }
  function card(item: DeskItem): HTMLElement {
    const pending = item.status === "pending";
    const node = el("article", undefined, pending ? "card pending" : "card");
    const top = el("div", undefined, "card-top");
    top.append(
      el(
        "span",
        pending
          ? "PENDING · READ BY LOCAL AI"
          : (statusLabels[item.status] ?? item.status),
        pending ? "kicker waiting" : "badge",
      ),
      el(
        "span",
        dueLabel(item.due_date ?? item.suggested_due, parisToday()),
        "due",
      ),
    );
    node.append(
      top,
      el("h3", deskItemTitle(item)),
      el("p", `${item.contact_name} · ${item.contact_id}`, "small"),
      quote(item.quote),
      el("p", itemMeta(item), "meta"),
    );
    if (!item.evidence_valid)
      node.append(
        el(
          "p",
          "The source message changed. Check it in People before acting.",
          "warn",
        ),
      );
    node.append(actions(item));
    return node;
  }
  function actions(item: DeskItem, large = false): HTMLElement {
    const row = el("div", undefined, large ? "actions stacked" : "actions");
    if (item.status === "pending") {
      const id = `due-${large ? "review-" : ""}${item.commitment_id}`;
      const label = el("label", "Due date", "date-field");
      label.htmlFor = id;
      const input = el("input");
      input.type = "date";
      input.id = id;
      input.value = confirmDefaultDate(item);
      input.required = true;
      const confirm = button(
        "Confirm",
        "primary",
        () =>
          void act(
            "desk/confirm",
            { id: item.commitment_id, due_date: input.value },
            "Confirmed. Only your private ledger changed. Nothing was sent.",
          ),
      );
      confirm.disabled = !input.value || !item.evidence_valid;
      input.addEventListener("input", () => {
        confirm.disabled = !input.value || !item.evidence_valid;
      });
      label.append(input);
      row.append(
        label,
        confirm,
        button(
          "Not a promise",
          "quiet",
          () =>
            void act(
              "desk/dismiss",
              { id: item.commitment_id },
              "Marked as not a promise. The message stays in history.",
            ),
        ),
      );
    } else {
      if (item.direction === "owed_by_me" && item.status === "confirmed")
        row.append(
          button(
            "Mark done",
            "quiet",
            () =>
              void act(
                "desk/done",
                { id: item.commitment_id },
                "Marked done. Nothing was sent.",
              ),
          ),
        );
      row.append(
        button(`Open ${item.contact_name}`, "link", () =>
          ctx.openContact(item.contact_id, item.contact_name),
        ),
      );
    }
    return row;
  }
  function line(record: DeskRecordLine, showText = true): HTMLElement {
    const node = el("div", undefined, "record-line");
    if (showText) node.append(el("p", `“${record.text}”`, "line-text"));
    node.append(
      el(
        "p",
        [
          record.reason,
          sourceName(record.source),
          parisMoment(record.occurred_at),
          record.record_id,
        ].join(" · "),
        "meta",
      ),
    );
    return node;
  }
  function renderDesk(desk: DeskSnapshot): void {
    get("desk-date").textContent =
      "YOUR DESK · " +
      new Intl.DateTimeFormat("en-GB", {
        timeZone: "Europe/Paris",
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
      })
        .format(new Date(desk.generated_at))
        .toUpperCase();
    get("desk-headline").textContent = deskHeadline(desk);
    const pipeline = get("desk-pipeline");
    pipeline.replaceChildren(
      ...desk.pipeline.map((stage) => {
        const item = el("li", undefined, `stage state-${stage.state}`);
        item.append(
          el("span", stage.label, "stage-label"),
          el("span", stage.detail, "stage-detail"),
        );
        if (stage.id === "errors") {
          const link = el("a", "How it runs");
          link.href = "#runs";
          item.append(link);
        }
        return item;
      }),
    );
    get("owe-title").textContent = `YOU OWE · ${desk.you_owe.length}`;
    get("owed-title").textContent = `OWED TO YOU · ${desk.owed_to_you.length}`;
    get("yes-title").textContent =
      `WAITING FOR YOUR YES · ${desk.pending.length}`;
    for (const [id, items, none] of [
      ["desk-owe", desk.you_owe, "Nothing you owe right now."],
      ["desk-owed", desk.owed_to_you, "Nothing owed to you right now."],
      ["desk-yes", desk.pending, "Your review is clear."],
    ] as const) {
      const target = get(id);
      if (items.length) target.replaceChildren(...items.map(card));
      else empty(target, none);
    }
    get("not-title").textContent = `NOT PROMISES · ${desk.not_promises_total}`;
    const not = get("desk-not");
    if (desk.not_promises.length) {
      not.replaceChildren(...desk.not_promises.map((r) => line(r)));
      if (desk.not_promises_total > desk.not_promises.length)
        not.append(
          el(
            "p",
            `${desk.not_promises_total - desk.not_promises.length} older messages are in People.`,
            "small",
          ),
        );
    } else empty(not, "No recent messages without a promise.");
    get("held-title").textContent = `HELD BACK · ${desk.held_back_total}`;
    const held = get("desk-held");
    if (desk.held_back.length)
      held.replaceChildren(
        el(
          "p",
          "These messages try to give Tend instructions. They are shown as data and never treated as promises.",
          "small",
        ),
        ...desk.held_back.map((r) => {
          const node = line(r, false);
          node.prepend(quote(r.text, "quote held"));
          return node;
        }),
      );
    else empty(held, "No instruction-like messages.");
    renderMeeting(desk);
    const coverage = get("desk-coverage");
    if (desk.coverage.length) {
      const list = el("dl", undefined, "coverage-list");
      for (const row of desk.coverage)
        list.append(
          el("dt", sourceName(row.source)),
          el("dd", String(row.count)),
        );
      coverage.replaceChildren(list);
    } else empty(coverage, "No imported records yet.");
  }
  function renderMeeting(desk: DeskSnapshot): void {
    const target = get("desk-meeting");
    const meeting = desk.next_meeting;
    if (!meeting) {
      target.replaceChildren(
        el("div", "BEFORE YOU MEET", "eyebrow"),
        el("p", "No upcoming meeting in your imported calendar."),
      );
      return;
    }
    const open = el("ul", undefined, "open-list");
    for (const item of meeting.open)
      open.append(
        el(
          "li",
          `${item.direction === "owed_by_me" ? "You" : item.contact_name}: ${item.action}, ${dueLabel(item.due_date ?? item.suggested_due, parisToday()).replace(/\b(Due|Overdue)\b/g, (w) => w.toLowerCase())}${item.status === "pending" ? " (waiting for your yes)" : ""}`,
        ),
      );
    const prepare = button(`Prepare for ${meeting.contact_name}`, "dark", () =>
      ctx.openContact(meeting.contact_id, meeting.contact_name),
    );
    target.replaceChildren(
      el(
        "div",
        `BEFORE YOU MEET · ${parisMoment(meeting.starts_at).toUpperCase()} PARIS`,
        "eyebrow",
      ),
      el("h2", meeting.title),
      el("p", `Calendar · ${meeting.record_id}`, "small"),
      el("h3", "Open between you"),
      meeting.open.length
        ? open
        : el("p", "Nothing open between you.", "small"),
    );
    if (meeting.last_message)
      target.append(
        el(
          "h3",
          `Last message · ${sourceName(meeting.last_message.source)} · ${parisMoment(meeting.last_message.occurred_at)}`,
        ),
        quote(meeting.last_message.text, "quote light"),
      );
    target.append(
      prepare,
      el(
        "p",
        "Briefings and drafts stay on this laptop until you copy them.",
        "small",
      ),
    );
  }
  function renderOutreach(): void {
    const target = get("desk-outreach");
    if (outreach === "disabled") {
      empty(target, "Outreach is not enabled.");
      return;
    }
    if (outreach === "unavailable") {
      empty(target, "The outreach queue is unavailable right now.");
      return;
    }
    if (!outreach.length) {
      empty(target, "No drafts waiting.");
      return;
    }
    const now = new Date();
    target.replaceChildren(
      ...outreach.map((item) => {
        const node = el("article", undefined, "card outreach-card");
        const top = el("div", undefined, "card-top");
        top.append(
          el(
            "span",
            outreachStatusLabels[item.status],
            item.status === "pending" ? "kicker waiting" : "badge",
          ),
          el("span", sourceName(item.channel), "due"),
        );
        const draftId = `outreach-text-${item.id}`;
        const draft = el("p", item.draft_text, "draft");
        draft.id = draftId;
        node.append(
          top,
          el("h3", item.contact_name),
          el("p", outreachReasonLabels[item.reason], "small"),
          draft,
        );
        if (item.recipient)
          node.append(el("p", `To ${item.recipient}`, "meta"));
        for (const evidence of item.evidence)
          node.append(
            quote(evidence.text),
            el(
              "p",
              `${sourceName(evidence.source)} · ${evidence.reference}`,
              "meta",
            ),
          );
        const detail =
          item.status === "pending"
            ? `Approval window ends ${parisMoment(item.expires_at)}`
            : item.status === "approved" && item.channel !== "email"
              ? "Copy the text and send it yourself."
              : item.status === "approved"
                ? "Waiting for the Gmail step to create the draft. You press Send yourself."
                : outreachStatusDetail[item.status];
        if (detail) node.append(el("p", detail, "meta"));
        const row = el("div", undefined, "actions");
        if (outreachActionable(item, now)) {
          row.append(
            button(
              "Approve this message",
              "primary",
              () =>
                void act(
                  "outreach/approve",
                  { id: item.id, text_code: item.text_code },
                  item.channel === "email"
                    ? "Approved. Tend creates a Gmail draft; you press Send yourself."
                    : "Approved. Copy the text and send it yourself.",
                ),
            ),
            button("Edit", "quiet", () => startEdit(item, row)),
            button(
              "Skip",
              "quiet",
              () =>
                void act(
                  "outreach/skip",
                  { id: item.id },
                  "Skipped. Nothing was sent. Tend will not propose this again for 3 days.",
                ),
            ),
          );
        } else if (
          item.status === "approved" &&
          Date.parse(item.expires_at) > now.getTime()
        ) {
          if (item.channel !== "email") {
            row.append(
              button("Copy text", "quiet", () => void copy(item.draft_text)),
            );
            const link = safeLink(item.deep_link);
            if (link) {
              const open = el("a", `Open ${sourceName(item.channel)}`, "link");
              open.href = link;
              open.target = "_blank";
              open.rel = "noopener noreferrer";
              row.append(open);
            }
          }
          // The outreach service accepts edit and skip on approved items, which withdraws the approval.
          row.append(
            button("Edit", "quiet", () => startEdit(item, row)),
            withdrawButton(item),
          );
        }
        node.append(row);
        if (item.status === "approved")
          node.append(
            el(
              "p",
              "Withdrawing is final for this draft and Tend waits 3 days before proposing it again. Edit sends it back for your yes instead.",
              "meta",
            ),
          );
        return node;
      }),
    );
  }
  function withdrawButton(item: OutreachItem): HTMLButtonElement {
    let armed = false;
    const node = button("Withdraw approval", "quiet", () => {
      if (!armed) {
        armed = true;
        node.textContent = "Confirm withdraw";
        return;
      }
      void act(
        "outreach/skip",
        { id: item.id },
        "Approval withdrawn. Nothing was sent. Tend will not propose this again for 3 days.",
      );
    });
    return node;
  }
  function startEdit(item: OutreachItem, row: HTMLElement): void {
    const id = `outreach-edit-${item.id}`;
    const label = el("label", "Edit the message", "date-field");
    label.htmlFor = id;
    const area = el("textarea");
    area.id = id;
    area.maxLength = 2000;
    area.rows = 5;
    area.value = item.draft_text;
    label.append(area);
    const save = el("div", undefined, "actions");
    save.append(
      button(
        "Save edit",
        "primary",
        () =>
          void act(
            "outreach/edit",
            { id: item.id, text: area.value },
            "Edit saved. Approve it when it reads right.",
          ),
      ),
      button("Cancel", "quiet", () => renderOutreach()),
    );
    row.replaceWith(label, save);
    area.focus();
  }
  async function copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      ctx.notify(
        "Copied. Paste it into the conversation and send it yourself.",
      );
    } catch {
      ctx.notify(
        "Copy is unavailable here. Select the text and copy it manually.",
      );
    }
  }
  function renderReview(): void {
    const target = get("review-card");
    const items = snapshot?.pending ?? [];
    const position = reviewPosition(items.length, reviewIndex);
    reviewIndex = position.index;
    get("review-progress").textContent = position.label;
    const item = items[position.index];
    if (!item) {
      get("review-kicker").textContent = "REVIEW CLEAR";
      get("review-title").textContent = "Nothing waits for your yes.";
      const back = el("a", "Back to desk", "primary-link");
      back.href = "#desk";
      target.replaceChildren(
        el(
          "p",
          "New promises appear here after the local AI reads new messages.",
          "small",
        ),
        back,
      );
      return;
    }
    get("review-kicker").textContent = "WAITING FOR YOUR YES";
    get("review-title").textContent = "Is this a promise?";
    const node = el("article", undefined, "card pending review-item");
    const facts = el("dl", undefined, "facts");
    facts.append(
      el("dt", "Who owes"),
      el(
        "dd",
        item.direction === "owed_by_me"
          ? `You, to ${item.contact_name}`
          : `${item.contact_name}, to you`,
      ),
      el("dt", "What"),
      el("dd", item.action),
      el("dt", "Suggested"),
      el("dd", dueLabel(item.suggested_due)),
    );
    node.append(
      el("p", itemMeta(item), "meta"),
      el(
        "p",
        item.direction === "owed_by_me"
          ? "You wrote"
          : `${item.contact_name} wrote`,
      ),
      quote(item.quote, "quote large"),
      facts,
    );
    if (!item.evidence_valid)
      node.append(
        el(
          "p",
          "The source message changed. Check it in People before acting.",
          "warn",
        ),
      );
    const nav = el("div", undefined, "review-nav");
    const step = (by: number, label: string): void => {
      reviewIndex += by;
      renderReview();
      const again = [...get("review-card").querySelectorAll("button")].find(
        (b) => b.textContent === label && !b.disabled,
      );
      (again ?? get("review-title")).focus();
    };
    const prev = button("Previous", "quiet", () => step(-1, "Previous"));
    const next = button("Next", "quiet", () => step(1, "Next"));
    prev.disabled = !position.prev;
    next.disabled = !position.next;
    nav.append(prev, next);
    target.replaceChildren(
      node,
      actions(item, true),
      el(
        "p",
        "Only your private ledger changes. Nothing is sent.",
        "small center",
      ),
      nav,
    );
  }
  function renderRuns(runs: DeskRuns): void {
    for (const lane of ["classroom", "private"] as const) {
      const target = get(`runs-${lane}`);
      target.replaceChildren(
        ...runs.workflows
          .filter((w) => w.lane === lane)
          .map((w) => {
            const item = el("li", undefined, `run run-${w.last_status}`);
            item.append(
              el("span", w.id, "run-id"),
              el("span", w.name, "run-name"),
              el(
                "span",
                runLabels[w.last_status] +
                  (w.last_run_at ? ` · ${parisMoment(w.last_run_at)}` : ""),
                "run-status",
              ),
            );
            return item;
          }),
      );
    }
    const failures = get("runs-failures");
    if (!runs.failure_log_connected)
      empty(failures, "The failure log is not connected on this device.");
    else if (!runs.failures.length) empty(failures, "No failures logged.");
    else
      failures.replaceChildren(
        ...runs.failures
          .slice()
          .reverse()
          .map((f) => {
            const entry = el("dl", undefined, "failure");
            entry.append(
              el("dt", "workflow"),
              el("dd", f.workflow),
              el("dt", "node"),
              el("dd", f.node),
              el("dt", "message"),
              el("dd", f.message),
              el("dt", "execution"),
              el("dd", f.execution_id),
            );
            return entry;
          }),
      );
  }
  function heading(view: string): HTMLElement {
    return get(
      view === "runs"
        ? "runs-title"
        : view === "review"
          ? "review-title"
          : "desk-headline",
    );
  }
  async function act(
    path: string,
    body: Record<string, unknown>,
    done: string,
  ): Promise<void> {
    if (busy || !ctx.active()) return;
    busy = true;
    generation++;
    abort(loads);
    for (const id of ["desk-view", "review-view"])
      for (const b of get(id).querySelectorAll("button")) b.disabled = true;
    try {
      await request(path, body);
      if (ctx.active()) ctx.notify(done);
    } catch (error) {
      if (ctx.active()) ctx.notify(message(error));
    } finally {
      busy = false;
    }
    // A lock during the request must not pull private text back into the page.
    if (!ctx.active()) return;
    await load(current);
    if (ctx.active()) heading(current).focus();
  }
  async function load(view: string): Promise<void> {
    const mine = ++generation;
    abort(loads);
    const stale = (): boolean => mine !== generation || !ctx.active();
    if (stale()) return;
    try {
      if (view === "runs") {
        const runs = (await request("runs")) as DeskRuns;
        if (!stale()) renderRuns(runs);
        return;
      }
      const desk = (await request("desk")) as DeskSnapshot;
      if (stale()) return;
      snapshot = desk;
      if (view === "review") {
        renderReview();
        return;
      }
      renderDesk(desk);
      let queue: typeof outreach;
      try {
        queue = parseOutreachList(await request("outreach"));
      } catch (error) {
        queue =
          (error as { status?: number }).status === 404
            ? "disabled"
            : "unavailable";
      }
      if (stale()) return;
      outreach = queue;
      renderOutreach();
    } catch (error) {
      if (stale()) return;
      ctx.notify(message(error));
      // Re-render the last good snapshot so buttons disabled by an action come back.
      if (snapshot && view === "review") renderReview();
      else if (snapshot && view === "desk") {
        renderDesk(snapshot);
        renderOutreach();
      }
    }
  }
  return {
    route(view: string): void {
      const focusChange = view !== current;
      current = view;
      if (view === "people") return;
      void load(view).then(() => {
        if (!focusChange || !ctx.active()) return;
        heading(view).focus();
        if (window.location.hash === "#outreach")
          get("outreach").scrollIntoView();
      });
    },
    clear(): void {
      generation++;
      abort(loads);
      abort(posts);
      busy = false;
      current = "desk";
      snapshot = null;
      outreach = [];
      reviewIndex = 0;
      for (const id of containers) get(id).replaceChildren();
      get("desk-headline").textContent = "Your promises, quoted.";
      get("desk-date").textContent = "YOUR DESK";
      for (const [id, text] of [
        ["owe-title", "YOU OWE"],
        ["owed-title", "OWED TO YOU"],
        ["yes-title", "WAITING FOR YOUR YES"],
        ["not-title", "NOT PROMISES"],
        ["held-title", "HELD BACK"],
        ["review-kicker", "WAITING FOR YOUR YES"],
        ["review-title", "Is this a promise?"],
      ] as const)
        get(id).textContent = text;
    },
  };
}
