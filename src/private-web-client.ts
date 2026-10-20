import { mountPixelArt } from "./pixel-art.ts";
import type {
  NormalizedRecord,
  Reply,
  SourceState,
  Commitment,
} from "./engine.ts";
import type {
  PrivateSessionResponse,
  PrivateContactsResponse,
  PrivateHistoryResponse,
  PrivateSearchResponse,
  PrivateViewResponse,
} from "./private-web-types.ts";

type Contact = PrivateContactsResponse["contacts"][number];
interface HistoryFilters {
  source: string;
  direction: string;
  from: string;
  to: string;
  cursor: string | null;
}
interface Evidence {
  source: string;
  text: string;
  reference: string;
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function safeEvidenceUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}
export function parisTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("en-GB", {
        timeZone: "Europe/Paris",
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(date);
}
export function parisDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("en-GB", {
        timeZone: "Europe/Paris",
        day: "2-digit",
        month: "short",
        year: "numeric",
      }).format(date);
}
export function replyPresentation(reply: Reply): {
  message: string;
  draft: string | null;
  evidence: Evidence[];
  recipient: string | null;
  style: string | null;
} {
  const evidence: Evidence[] = [];
  if (Array.isArray(reply.evidence))
    for (const value of reply.evidence)
      if (
        object(value) &&
        typeof value.source === "string" &&
        typeof value.text === "string" &&
        typeof value.reference === "string"
      )
        evidence.push({
          source: value.source,
          text: value.text,
          reference: value.reference,
        });
  const aiDraft =
    object(reply.ai) && object(reply.ai.draft) ? reply.ai.draft : null;
  return {
    recipient:
      aiDraft &&
      object(aiDraft.recipient) &&
      typeof aiDraft.recipient.name === "string"
        ? aiDraft.recipient.name
        : null,
    style: aiDraft
      ? aiDraft.style_basis === "recipient_examples"
        ? "Style based on your messages to this contact. Check every fact before use."
        : "Neutral writing style. Check every fact before use."
      : null,
    message:
      typeof reply.normal_message === "string"
        ? reply.normal_message
        : "Prepared from current imported evidence.",
    draft: typeof reply.preview === "string" ? reply.preview : null,
    evidence,
  };
}
export function historyQuery(
  selector: string,
  filters: HistoryFilters,
): URLSearchParams {
  const query = new URLSearchParams({ selector });
  for (const key of ["source", "direction", "from", "to", "cursor"] as const)
    if (filters[key]) query.set(key, filters[key]);
  return query;
}
export function matchingPassage(
  record: Pick<NormalizedRecord, "record_key" | "body_text">,
  matches: PrivateSearchResponse["matches"],
): { text: string; similarity: number } | null {
  const match = matches?.find((item) => item.record_key === record.record_key);
  if (
    !match ||
    !Number.isInteger(match.start) ||
    !Number.isInteger(match.end) ||
    match.start < 0 ||
    match.end <= match.start ||
    match.end > record.body_text.length ||
    !Number.isFinite(match.similarity) ||
    record.body_text.slice(match.start, match.end) !== match.text
  )
    return null;
  return { text: match.text, similarity: match.similarity };
}
export function indexCoverageLines(value: unknown): string[] {
  if (!object(value))
    return [
      "Index coverage is unavailable. Results may cover only part of your imported context.",
    ];
  const count = (key: string): number | null =>
    typeof value[key] === "number" &&
    Number.isFinite(value[key]) &&
    value[key] >= 0
      ? Math.floor(value[key])
      : null;
  const complete = count("complete"),
    total = count("total"),
    pending = count("pending"),
    partial = count("partial"),
    withdrawn = count("withdrawn"),
    failed = count("failed");
  const lines = [
    value.state === "complete"
      ? "Initial imported snapshot indexed."
      : value.state === "paused"
        ? "Index paused. Some imported context is not searchable yet."
        : value.state === "indexing"
          ? "Indexing imported context. Results are partial."
          : "Index has not finished its first snapshot.",
  ];
  if (complete !== null && total !== null)
    lines.push(`${complete} of ${total} imported records fully indexed.`);
  if (pending !== null) lines.push(`${pending} records still waiting.`);
  if (partial !== null && partial > 0)
    lines.push(`${partial} records only partly indexed.`);
  if (withdrawn !== null && withdrawn > 0)
    lines.push(`${withdrawn} records withdrawn from the index.`);
  if (failed !== null && failed > 0)
    lines.push(`${failed} records could not be indexed and need review.`);
  lines.push("Coverage is limited to eligible imported context.");
  return lines;
}
export function contactActivityLines(
  activity:
    { count: number; last_at: string | null; sources: string[] } | undefined,
): string[] {
  if (!activity) return [];
  const lines = [
    `${activity.count} eligible imported ${activity.count === 1 ? "item" : "items"}`,
  ];
  if (activity.last_at) lines.push(`Latest ${parisTime(activity.last_at)}`);
  if (activity.sources.length)
    lines.push(activity.sources.map(sourceName).join(" · "));
  return lines;
}
export async function lockPrivateSession(
  csrf: string,
  withdraw: () => void,
): Promise<void> {
  withdraw();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    await fetch("/private/api/logout", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": "application/json", "X-Tend-CSRF": csrf },
      body: "{}",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}
const labels: Record<string, string> = {
  gmail: "Email",
  calendar: "Calendar",
  whatsapp_personal: "WhatsApp personal",
  whatsapp_business: "WhatsApp business",
  linkedin: "LinkedIn",
};
function sourceName(source: string): string {
  return labels[source] ?? source;
}

export function mountPrivateWorkspace(): void {
  const get = <T extends HTMLElement>(id: string): T => {
    const element = document.getElementById(id);
    if (element === null)
      throw new Error(`Missing private workspace element: ${id}`);
    return element as T;
  };
  const locked = get("locked"),
    workspace = get("workspace"),
    notice = get("notice"),
    timeline = get("timeline"),
    contactsNode = get("contacts"),
    preparedNode = get("prepared");
  const input = (id: string): string =>
    get<HTMLInputElement | HTMLSelectElement>(id).value;
  const setText = (id: string, text: string): void => {
    get(id).textContent = text;
  };
  const visible = (id: string, show: boolean): void => {
    get(id).hidden = !show;
  };
  const node = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    text?: string,
    className?: string,
  ): HTMLElementTagNameMap[K] => {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  };
  const status = (message: string | null): void => {
    notice.textContent = message;
    notice.hidden = message === null;
  };
  let session: PrivateSessionResponse | null = null;
  let selected: Contact | null = null;
  let contactCursor: string | null = null;
  let historyCursor: string | null = null;
  let contacts: Contact[] = [];
  let records: NormalizedRecord[] = [];
  let view: PrivateViewResponse | null = null;
  let viewExpiry: ReturnType<typeof setTimeout> | undefined;
  let revision = 0;
  let contactsRevision = 0;
  let expires: ReturnType<typeof setTimeout> | undefined;
  let polling: ReturnType<typeof setInterval> | undefined;
  let validating = false;
  let checkingSession = false;
  let channel: BroadcastChannel | undefined;
  let mode: "history" | "search" = "history";
  const activeRequests = new Set<AbortController>();
  function removeView(message?: string): void {
    if (viewExpiry !== undefined) clearTimeout(viewExpiry);
    view = null;
    preparedNode.hidden = true;
    get("prepared-message").replaceChildren();
    get("prepared-evidence").replaceChildren();
    get("draft-text").textContent = "";
    visible("copy-draft", false);
    if (message) status(message);
  }
  function lock(message: string, notifyOtherTabs = true): void {
    const wasUnlocked = session !== null;
    revision++;
    contactsRevision++;
    session = null;
    selected = null;
    contacts = [];
    records = [];
    contactCursor = null;
    historyCursor = null;
    for (const request of activeRequests) request.abort();
    activeRequests.clear();
    if (expires !== undefined) clearTimeout(expires);
    if (polling !== undefined) clearInterval(polling);
    document.removeEventListener("visibilitychange", checkOnReturn);
    window.removeEventListener("focus", checkOnReturn);
    window.removeEventListener("pageshow", checkOnReturn);
    workspace.hidden = true;
    locked.hidden = false;
    visible("lock", false);
    for (const id of [
      "contacts",
      "timeline",
      "meetings",
      "commitments",
      "coverage",
    ])
      get(id).replaceChildren();
    removeView();
    get<HTMLInputElement>("search-query").value = "";
    get<HTMLInputElement>("contact-query").value = "";
    for (const id of [
      "filter-source",
      "filter-direction",
      "filter-from",
      "filter-to",
    ])
      get<HTMLInputElement | HTMLSelectElement>(id).value = "";
    for (const id of ["contact-identities", "contact-count", "history-count"])
      setText(id, "");
    setText("history-title", "A thread of context.");
    setText("session-status", message);
    // A new locked document obtains a fresh, one-use unlock nonce.
    const form = locked.querySelector("form");
    if (form) {
      form.hidden = true;
      const reload = node("a", "Open a fresh unlock screen");
      reload.href = "/private";
      form.after(reload);
    }
    status(null);
    if (channel) {
      try {
        if (notifyOtherTabs && wasUnlocked) channel.postMessage("lock");
      } catch {
        // The server session check also withdraws other tabs.
      } finally {
        channel.close();
        channel = undefined;
      }
    }
  }
  async function api<T>(
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const controller = new AbortController();
    activeRequests.add(controller);
    const timeout = setTimeout(
      () => controller.abort(),
      path === "session" ? 5_000 : 55_000,
    );
    try {
      const headers: Record<string, string> = { Accept: "application/json" };
      if (body) {
        if (!session) throw new Error("Unlock this device first.");
        headers["Content-Type"] = "application/json";
        headers["X-Tend-CSRF"] = session.csrf;
      }
      const response = await fetch(`/private/api/${path}`, {
        method: body ? "POST" : "GET",
        credentials: "same-origin",
        cache: "no-store",
        headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
      if (response.status === 401) {
        if (session) lock("Session expired · locked");
        throw new Error("Unlock this device to continue.");
      }
      const value: unknown = await response.json();
      if (!response.ok)
        throw new Error(
          object(value) && typeof value.error === "string"
            ? value.error
            : "The private service could not complete this request.",
        );
      return value as T;
    } finally {
      clearTimeout(timeout);
      activeRequests.delete(controller);
    }
  }
  async function checkSession(): Promise<void> {
    if (!session || checkingSession) return;
    if (Date.now() >= Date.parse(session.expires_at)) {
      lock("Session expired · locked");
      return;
    }
    checkingSession = true;
    const currentSession = session;
    try {
      const current = await api<PrivateSessionResponse>("session");
      if (session !== currentSession) return;
      if (
        current.csrf !== currentSession.csrf ||
        current.expires_at !== currentSession.expires_at
      ) {
        lock("Private session changed · locked", false);
        return;
      }
      if (Date.now() >= Date.parse(currentSession.expires_at)) {
        lock("Session expired · locked");
        return;
      }
      await revalidate();
    } catch {
      if (session === currentSession)
        lock("Session check unavailable · locked", false);
    } finally {
      checkingSession = false;
    }
  }
  function checkOnReturn(): void {
    if (!session) return;
    if (Date.now() >= Date.parse(session.expires_at))
      lock("Session expired · locked");
    else if (!document.hidden) void checkSession();
  }
  function report(error: unknown): void {
    if (session)
      status(
        error instanceof Error
          ? error.message
          : "The private service is unavailable. Your source data has not changed.",
      );
  }
  function reference(value: string): HTMLElement {
    const url = safeEvidenceUrl(value);
    if (url) {
      const link = node("a", value, "record-reference");
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      return link;
    }
    return node("span", value, "record-reference");
  }
  function empty(title: string, detail: string): HTMLElement {
    const element = node("div", undefined, "empty");
    element.append(node("strong", title), node("p", detail));
    return element;
  }
  function renderRecords(
    values: NormalizedRecord[],
    search = false,
    matches?: PrivateSearchResponse["matches"],
  ): void {
    timeline.replaceChildren();
    if (!values.length) {
      timeline.append(
        empty(
          search ? "No matching context." : "No imported history here.",
          search
            ? "Try another thought or choose Keyword search. Search only covers imported, eligible records."
            : "Try other filters. A known identity can have no eligible imported messages.",
        ),
      );
      return;
    }
    for (const record of values) {
      const article = node("article", undefined, "record");
      const meta = node("div", undefined, "record-meta");
      meta.append(
        node(
          "span",
          `${sourceName(record.source)} · ${record.direction}`,
          "source-badge",
        ),
        node(
          "time",
          record.all_day
            ? `${parisDate(record.occurred_at)} · all day`
            : parisTime(record.occurred_at),
        ),
      );
      article.append(meta);
      const match = search ? matchingPassage(record, matches) : null;
      if (match) {
        article.append(
          node(
            "p",
            `Related wording · ${Math.round(match.similarity * 100)}% similarity`,
            "small",
          ),
          node("p", match.text, "record-body"),
        );
        const full = node("details");
        full.append(
          node("summary", "Full imported message"),
          node("p", record.body_text, "record-body"),
        );
        article.append(full);
      } else article.append(node("p", record.body_text, "record-body"));
      if (record.end_at)
        article.append(
          node(
            "p",
            `${record.all_day ? "All-day event · exclusive end: " : "Ends: "}${record.all_day ? parisDate(record.end_at) : parisTime(record.end_at)}`,
            "small",
          ),
        );
      if (record.ingestion_mode === "snapshot")
        article.append(
          node(
            "p",
            "Labelled snapshot. This is not a connected historical feed.",
            "record-context",
          ),
        );
      if (record.attribution && record.attribution !== "direct")
        article.append(
          node(
            "p",
            `${record.attribution === "group" ? "Group context" : "Unverified attribution"}. This text does not establish a personal promise.`,
            "record-context",
          ),
        );
      article.append(reference(record.evidence_reference));
      if (search) {
        const open = node("button", "Open contact history", "quiet");
        open.addEventListener("click", () => {
          const found = contacts.find(
            (contact) => contact.contact_id === record.contact_id,
          );
          void selectContact(
            found ?? {
              owner_id: record.owner_id,
              contact_id: record.contact_id,
              name: record.contact_id,
              emails: [],
            },
          );
        });
        article.append(open);
      }
      timeline.append(article);
    }
  }
  function renderCoverage(sources: SourceState[]): void {
    const container = get("coverage");
    container.replaceChildren();
    if (!sources.length) {
      container.append(
        node(
          "p",
          "No source coverage is available for this selection.",
          "small",
        ),
      );
      return;
    }
    for (const source of sources) {
      const item = node("div", undefined, "coverage-item");
      item.append(
        node("strong", `${sourceName(source.source)} · ${source.mode}`),
        node("span", source.status),
        node(
          "span",
          `${parisTime(source.coverage_start)} → ${parisTime(source.coverage_end)}`,
        ),
        node(
          "span",
          source.mode === "snapshot"
            ? "One labelled snapshot"
            : source.pagination_complete === true && !source.evidence_incomplete
              ? "Imported pages complete within the stated coverage"
              : "Partial import · more history may exist",
        ),
        node(
          "span",
          source.last_success
            ? `Last read ${parisTime(source.last_success)}`
            : "No successful read recorded",
        ),
      );
      container.append(item);
    }
  }
  function renderSidePanel(value: PrivateHistoryResponse): void {
    renderCoverage(value.sources);
    const meetings = get("meetings");
    meetings.replaceChildren();
    const events = value.records.filter(
      (record) => record.source === "calendar" && !record.cancelled,
    );
    if (!events.length)
      meetings.append(
        node(
          "p",
          "No meetings in this loaded page. Check Calendar history and coverage.",
          "small",
        ),
      );
    for (const event of events) {
      const item = node("div", undefined, "side-item");
      item.append(
        node(
          "strong",
          event.all_day
            ? `${parisDate(event.occurred_at)} · all day`
            : parisTime(event.occurred_at),
        ),
        node("p", event.body_text.slice(0, 500)),
        reference(event.evidence_reference),
      );
      meetings.append(item);
    }
    const commitments = get("commitments");
    commitments.replaceChildren();
    const appendCommitments = (title: string, values: Commitment[]): void => {
      commitments.append(node("h3", `${title} · ${values.length}`));
      for (const item of values) {
        const element = node("div", undefined, "side-item");
        element.append(
          node("p", item.action),
          node(
            "span",
            `${item.direction === "owed_by_me" ? "Owed by you" : "Owed to you"} · ${item.status}${item.due_date ? ` · ${item.due_date}` : " · no confirmed date"}`,
            "small",
          ),
        );
        commitments.append(element);
      }
    };
    appendCommitments(
      "Confirmed",
      value.commitments.filter(
        (item) => item.status === "confirmed" && item.evidence_valid,
      ),
    );
    appendCommitments(
      "Pending review",
      value.commitments.filter((item) => item.status === "pending"),
    );
  }
  function filters(): HistoryFilters {
    return {
      source: input("filter-source"),
      direction: input("filter-direction"),
      from: input("filter-from"),
      to: input("filter-to"),
      cursor: historyCursor,
    };
  }
  async function loadHistory(append = false): Promise<void> {
    if (!selected || !session) return;
    const current = ++revision;
    const selectedId = selected.contact_id;
    if (!append) {
      historyCursor = null;
      records = [];
      timeline.replaceChildren(
        empty(
          "Loading context…",
          "Reading the selected contact’s imported history.",
        ),
      );
    }
    get<HTMLButtonElement>("more-history").disabled = true;
    try {
      const value = await api<PrivateHistoryResponse>(
        `history?${historyQuery(selectedId, filters())}`,
      );
      if (
        current !== revision ||
        !session ||
        selected?.contact_id !== selectedId
      )
        return;
      records = append ? [...records, ...value.records] : value.records;
      historyCursor = value.next_cursor;
      renderRecords(records);
      renderSidePanel(value);
      setText(
        "history-count",
        `${records.length} loaded · ${value.total} available for these filters`,
      );
      visible("more-history", historyCursor !== null);
      setText(
        "freshness",
        `History checked ${parisTime(new Date().toISOString())}. Source coverage is shown beside the conversation.`,
      );
    } catch (error) {
      if (current === revision && session) {
        if (!append)
          timeline.replaceChildren(
            empty(
              "Context unavailable.",
              "The imported history could not be loaded. Select this contact again to retry.",
            ),
          );
        report(error);
      }
    } finally {
      if (current === revision)
        get<HTMLButtonElement>("more-history").disabled = false;
    }
  }
  async function selectContact(contact: Contact): Promise<void> {
    selected = contact;
    mode = "history";
    removeView();
    status(null);
    visible("filters", true);
    visible("back-history", false);
    setText("history-title", contact.name);
    setText("contact-kicker", "CONTACT HISTORY");
    setText(
      "contact-identities",
      contact.emails.length
        ? contact.emails.join(" · ")
        : `Stored identity: ${contact.contact_id}`,
    );
    get<HTMLButtonElement>("briefing").disabled = false;
    get<HTMLButtonElement>("draft").disabled = false;
    renderContacts();
    await loadHistory();
  }
  function renderContacts(): void {
    contactsNode.replaceChildren();
    setText("contact-count", String(contacts.length));
    if (!contacts.length)
      contactsNode.append(
        empty("No people found.", "Try a stored email or another name."),
      );
    for (const contact of contacts) {
      const button = node("button", undefined, "contact");
      button.setAttribute(
        "aria-pressed",
        String(selected?.contact_id === contact.contact_id),
      );
      button.append(
        node("span", contact.name, "contact-name"),
        node(
          "span",
          contact.emails.join(", ") || "No stored email",
          "contact-email",
        ),
        node(
          "span",
          contact.verified_group === true
            ? `Verified identity group${contact.provenance ? ` · ${contact.provenance}` : ""}`
            : `Identity · ${contact.contact_id}`,
          "contact-id",
        ),
      );
      for (const line of contactActivityLines(contact.activity))
        button.append(node("span", line, "contact-activity"));
      button.addEventListener("click", () => {
        void selectContact(contact);
      });
      contactsNode.append(button);
    }
  }
  async function loadContacts(append = false): Promise<void> {
    const current = ++contactsRevision;
    if (!append) {
      contactCursor = null;
      contacts = [];
      contactsNode.replaceChildren(
        empty("Finding people…", "Reading stored contact identities."),
      );
    }
    const query = new URLSearchParams({ q: input("contact-query") });
    if (contactCursor) query.set("cursor", contactCursor);
    try {
      const value = await api<PrivateContactsResponse>(`contacts?${query}`);
      if (current !== contactsRevision || !session) return;
      contacts = append ? [...contacts, ...value.contacts] : value.contacts;
      contactCursor = value.next_cursor;
      renderContacts();
      visible("more-contacts", contactCursor !== null);
    } catch (error) {
      if (current === contactsRevision && session) {
        if (!append)
          contactsNode.replaceChildren(
            empty("People unavailable.", "Try the contact search again."),
          );
        report(error);
      }
    }
  }
  function renderView(value: PrivateViewResponse): void {
    if (!value.reply || value.valid === false) {
      removeView(
        "This output was withdrawn because its evidence, recipient or access changed. Prepare it again from current context.",
      );
      return;
    }
    view = value;
    if (viewExpiry !== undefined) clearTimeout(viewExpiry);
    viewExpiry = setTimeout(
      () => {
        if (view?.view_id === value.view_id)
          removeView(
            "This prepared output expired. Prepare it again before copying.",
          );
      },
      Math.max(0, Date.parse(value.expires_at) - Date.now()),
    );
    get<HTMLButtonElement>("copy-draft").disabled = false;
    const content = replyPresentation(value.reply);
    preparedNode.hidden = false;
    setText(
      "prepared-label",
      content.draft ? "HELD DRAFT · REVIEW BEFORE USE" : "CONTACT BRIEFING",
    );
    setText(
      "prepared-status",
      `Freshness checked ${parisTime(value.checked_at)}`,
    );
    setText(
      "prepared-message",
      [
        content.recipient ? `For: ${content.recipient}` : null,
        content.message,
        content.style,
      ]
        .filter(Boolean)
        .join("\n\n"),
    );
    setText("draft-text", content.draft ?? "");
    visible("draft-text", content.draft !== null);
    visible("copy-draft", content.draft !== null);
    const evidence = get("prepared-evidence");
    evidence.replaceChildren();
    for (const item of content.evidence) {
      const block = node("div", undefined, "prepared-evidence");
      block.append(
        node("span", sourceName(item.source), "source-badge"),
        node("p", item.text),
        reference(item.reference),
      );
      evidence.append(block);
    }
  }
  async function prepare(kind: "briefing" | "draft"): Promise<void> {
    if (!selected || !session) return;
    const current = revision;
    const selector = selected.contact_id;
    removeView();
    status(
      kind === "draft"
        ? "Writing a personalised draft locally. It stays pending for your review…"
        : "Preparing a briefing from current imported evidence…",
    );
    for (const id of ["briefing", "draft"])
      get<HTMLButtonElement>(id).disabled = true;
    try {
      const value = await api<PrivateViewResponse>(kind, { selector });
      if (current !== revision || selected?.contact_id !== selector || !session)
        return;
      status(null);
      renderView(value);
    } catch (error) {
      report(error);
    } finally {
      if (session && selected?.contact_id === selector)
        for (const id of ["briefing", "draft"])
          get<HTMLButtonElement>(id).disabled = false;
    }
  }
  async function revalidate(copy = false): Promise<void> {
    if (!view || !session || validating) return;
    if (Date.now() >= Date.parse(view.expires_at)) {
      removeView(
        "This prepared output expired. Prepare it again before copying.",
      );
      return;
    }
    validating = true;
    get<HTMLButtonElement>("copy-draft").disabled = true;
    const id = view.view_id;
    try {
      const value = await api<PrivateViewResponse>("revalidate", {
        view_id: id,
      });
      if (view?.view_id !== id || !session) return;
      renderView(value);
      if (copy && value.valid !== false && value.reply) {
        const draft = replyPresentation(value.reply).draft;
        if (draft) {
          try {
            await navigator.clipboard.writeText(draft);
          } catch {
            if (view?.view_id === id && session)
              status(
                "Copy is unavailable in this browser. Select the draft text and copy it manually. Nothing was sent.",
              );
            return;
          }
          if (view?.view_id === id && session)
            status("Fresh draft copied. Nothing was sent to your contact.");
        }
      }
    } catch (error) {
      if (view?.view_id === id) {
        removeView();
        report(error);
      }
    } finally {
      validating = false;
      if (view && session)
        get<HTMLButtonElement>("copy-draft").disabled = false;
    }
  }
  const unlockForm = locked.querySelector("form");
  unlockForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    const nonce = unlockForm.querySelector<HTMLInputElement>(
      'input[name="nonce"]',
    )?.value;
    if (!nonce) return;
    const button = unlockForm.querySelector("button");
    if (button) button.disabled = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    void fetch("/private/unlock", {
      method: "POST",
      mode: "cors",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ nonce }),
      signal: controller.signal,
    })
      .then((response) => {
        if (!response.ok)
          throw new Error("Unlock expired. Reload the page and try again.");
        window.location.reload();
      })
      .catch((error: unknown) => {
        setText(
          "session-status",
          error instanceof Error
            ? error.message
            : "Unlock unavailable. Reload this page.",
        );
        if (button) button.disabled = false;
      })
      .finally(() => clearTimeout(timeout));
  });
  get("contact-form").addEventListener("submit", (event) => {
    event.preventDefault();
    void loadContacts();
  });
  get("more-contacts").addEventListener("click", () => {
    void loadContacts(true);
  });
  get("filters").addEventListener("submit", (event) => {
    event.preventDefault();
    if (mode === "history") void loadHistory();
  });
  get("more-history").addEventListener("click", () => {
    void loadHistory(true);
  });
  get("back-history").addEventListener("click", () => {
    if (selected) void selectContact(selected);
  });
  get("briefing").addEventListener("click", () => {
    void prepare("briefing");
  });
  get("draft").addEventListener("click", () => {
    void prepare("draft");
  });
  get("copy-draft").addEventListener("click", () => {
    void revalidate(true);
  });
  get("lock").addEventListener("click", () => {
    const csrf = session?.csrf;
    if (csrf)
      void lockPrivateSession(csrf, () => lock("Locked on this device")).catch(
        () => undefined,
      );
    else lock("Locked on this device");
  });
  get("search-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const query = input("search-query").trim();
    if (!query) return;
    const current = ++revision;
    mode = "search";
    removeView();
    visible("filters", false);
    visible("more-history", false);
    visible("back-history", selected !== null);
    for (const id of ["meetings", "commitments", "coverage"])
      get(id).replaceChildren(
        node(
          "p",
          "Global search. Open a result to inspect its contact context.",
          "small",
        ),
      );
    for (const id of ["briefing", "draft"])
      get<HTMLButtonElement>(id).disabled = true;
    setText("history-title", "Find the thread.");
    setText("contact-kicker", "IMPORTED CONTEXT SEARCH");
    setText("contact-identities", query);
    status("Searching imported context…");
    timeline.replaceChildren(
      empty("Finding the thread…", "Searching eligible imported context."),
    );
    void api<PrivateSearchResponse>("search", {
      query,
      mode: input("search-mode"),
    })
      .then((value) => {
        if (current !== revision || !session) return;
        renderRecords(value.records, true, value.matches);
        setText(
          "history-count",
          `${value.records.length} ${value.mode === "semantic" ? "semantic" : "keyword"} matches · similarity does not verify identity`,
        );
        status(value.warning ?? null);
        if (value.coverage !== undefined) {
          const coverage = get("coverage");
          coverage.replaceChildren(
            node("p", "Search coverage", "small"),
            node("p", indexCoverageLines(value.coverage).join("\n"), "small"),
          );
        }
      })
      .catch((error: unknown) => {
        if (current === revision && session) {
          timeline.replaceChildren(
            empty(
              "Search unavailable.",
              "Choose Keyword search if the semantic index is unavailable, then try again.",
            ),
          );
          report(error);
        }
      });
  });
  mountPixelArt(
    get<HTMLCanvasElement>("pixel-art"),
    get<HTMLButtonElement>("pixel-motion"),
  );
  async function loadProgress(): Promise<void> {
    try {
      const result = await api<{ history: unknown[]; daily: unknown }>(
        "progress",
      );
      if (!session) return;
      const plain = (v: unknown): v is Record<string, unknown> =>
        typeof v === "object" && v !== null && !Array.isArray(v);
      const daily = result.daily;
      if (plain(daily) && plain(daily.schedule)) {
        const latest = plain(daily.last_sent_delivery)
          ? daily.last_sent_delivery
          : null;
        const delivery = plain(daily.delivery) ? daily.delivery : null;
        setText(
          "daily-progress",
          `Daily briefing: 09:00 Paris. Next: ${parisTime(String(daily.schedule.next_scheduled_at))}. ${latest ? `Last delivered: ${String(latest.paris_date)}.` : "No delivery recorded yet."} ${delivery ? `Today: ${String(delivery.state)}${delivery.failure ? ` (${String(delivery.failure)})` : ""}.` : ""}`,
        );
      } else setText("daily-progress", "Daily briefing is not enabled yet.");
      const area = get("history-progress");
      area.replaceChildren();
      if (!result.history.length)
        area.append(
          node(
            "p",
            "History backfill has not started. Current imports remain bounded by their shown coverage.",
            "small",
          ),
        );
      for (const item of result.history.filter(plain))
        area.append(
          node(
            "p",
            `${sourceName(String(item.source))} · ${String(item.account_id)}: ${String(item.status)} · ${String(item.page_count)} pages · ${String(item.record_count)} records${item.oldest_at ? ` · oldest ${parisTime(String(item.oldest_at))}` : ""}${item.newest_at ? ` · newest ${parisTime(String(item.newest_at))}` : ""} · frozen at ${parisTime(String(item.watermark))} · ${item.cursor ? "more pages remain" : item.status === "complete" ? "pagination finished" : "not yet complete"}${item.last_error ? ` · paused: ${String(item.last_error)}` : ""}`,
            "small",
          ),
        );
    } catch {
      if (session)
        setText(
          "daily-progress",
          "Import and delivery status is unavailable. No delivery is assumed.",
        );
    }
  }
  void api<PrivateSessionResponse>("session")
    .then((value) => {
      session = value;
      void loadProgress();
      locked.hidden = true;
      workspace.hidden = false;
      visible("lock", true);
      setText(
        "session-status",
        `Private session until ${parisTime(value.expires_at)}`,
      );
      expires = setTimeout(
        () => lock("Session expired · locked"),
        Math.max(0, Date.parse(value.expires_at) - Date.now()),
      );
      if (typeof BroadcastChannel === "function") {
        try {
          channel = new BroadcastChannel("tend-private");
          channel.onmessage = (event: MessageEvent<unknown>) => {
            if (event.data === "lock") lock("Locked on another tab", false);
          };
        } catch {
          // Session polling remains available if tab messaging is unsupported.
        }
      }
      polling = setInterval(checkOnReturn, 15_000);
      document.addEventListener("visibilitychange", checkOnReturn);
      window.addEventListener("focus", checkOnReturn);
      window.addEventListener("pageshow", checkOnReturn);
      void loadContacts();
    })
    .catch(() => {
      setText("session-status", "Local access · locked");
    });
}
if (typeof document !== "undefined" && document.getElementById("workspace"))
  mountPrivateWorkspace();
