import type { AuthCommand, TendStore } from "./engine.ts";
import type { LiveStore } from "./live-store.ts";
import {
  buildDeskRuns,
  buildDeskSnapshot,
  outreachSending,
  parseOutreachList,
  type DeskFailure,
  type DeskOutreachBackend,
  type DeskWorkflowRun,
} from "./desk-model.ts";

export interface DeskOptions {
  failureLog?: () => Promise<DeskFailure[]>;
  workflowRuns?: () => Promise<DeskWorkflowRun[]>;
  outreach?: DeskOutreachBackend;
}
export const deskRoutes = [
  "/private/api/desk",
  "/private/api/desk/confirm",
  "/private/api/desk/dismiss",
  "/private/api/desk/done",
  "/private/api/desk/separate",
  "/private/api/runs",
];
export const outreachRoutes = [
  "/private/api/outreach",
  "/private/api/outreach/approve",
  "/private/api/outreach/edit",
  "/private/api/outreach/skip",
];
export class DeskRequestError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
const commitmentId = /^[A-Za-z0-9_-]{1,80}$/;
const day = /^\d{4}-\d{2}-\d{2}$/;
// Engine errors that name a state rule, never private text; anything else stays generic.
const safeEngineError =
  /^(invalid transition(: evidence review required)?|unknown commitment|explicit valid date required|invalid command arguments)$/;
// Fixed rule phrases from the outreach service; anything that could echo draft text stays generic.
const safeOutreachError =
  /^(unknown outreach item|cannot (approve|edit|skip) an? (pending|approved|skipped|gmail_draft_created|expired) item|recipient is not a verified identity of this contact|empty draft|draft too long|dash not allowed|instruction-like draft|fill in the bracketed placeholder first|draft is no longer replaceable|draft changed since you saw it)$/;
function safeMessage(message: string): string {
  if (safeEngineError.test(message) || safeOutreachError.test(message))
    return `Not changed: ${message}.`;
  if (message.startsWith("uncited detail"))
    return "Not changed: the draft names a detail that is not in its cited evidence.";
  return "Not changed. Reload the desk and try again.";
}
function fields(
  data: Record<string, unknown>,
  allowed: string[],
): Record<string, unknown> {
  const keys = Object.keys(data);
  if (keys.length !== allowed.length || keys.some((k) => !allowed.includes(k)))
    throw new DeskRequestError(400, "Unexpected request fields");
  return data;
}
function id(data: Record<string, unknown>): string {
  if (typeof data.id !== "string" || !commitmentId.test(data.id))
    throw new DeskRequestError(400, "Invalid item ID");
  return data.id;
}
async function guard<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    throw new DeskRequestError(409, safeMessage(message));
  }
}

export async function handleDeskRoute(input: {
  path: string;
  method: string;
  data: Record<string, unknown> | null;
  store: TendStore | LiveStore;
  auth: Omit<AuthCommand, "text">;
  now: Date;
  options: DeskOptions;
}): Promise<{ status: number; body: unknown }> {
  const { path, method, data, store, auth, options } = input;
  const owner = auth.owner_id;
  const failures = async (): Promise<DeskFailure[] | null> =>
    options.failureLog ? await options.failureLog().catch(() => null) : null;
  if (method === "GET" && path === "/private/api/desk") {
    // Read only: threads are linked when a candidate is added and by the operator backfill, never on a page load.
    const [commitments, records, contacts, sources, log] = await Promise.all([
      store.commitments(owner),
      store.interactions(owner),
      store.contacts(owner),
      store.sourceStatus(owner),
      failures(),
    ]);
    return {
      status: 200,
      body: buildDeskSnapshot({
        commitments,
        records,
        contacts,
        sources,
        now: input.now,
        failures: log,
      }),
    };
  }
  if (method === "GET" && path === "/private/api/runs") {
    const runs = options.workflowRuns
      ? await options.workflowRuns().catch(() => null)
      : null;
    return { status: 200, body: buildDeskRuns(runs, await failures()) };
  }
  if (method === "GET" && path === "/private/api/outreach") {
    if (!options.outreach)
      throw new DeskRequestError(404, "Outreach is not enabled");
    const listed = await options.outreach.list();
    const sending = outreachSending(listed);
    return {
      status: 200,
      body: {
        items: parseOutreachList(listed),
        ...(sending === null ? {} : { sending_enabled: sending }),
      },
    };
  }
  if (method !== "POST" || !data)
    throw new DeskRequestError(405, "Method not allowed");
  const command = (text: string): Promise<unknown> =>
    guard(async () => await store.command({ ...auth, text }));
  if (path === "/private/api/desk/confirm") {
    fields(data, ["id", "due_date"]);
    if (
      typeof data.due_date !== "string" ||
      !day.test(data.due_date) ||
      Number.isNaN(Date.parse(data.due_date + "T00:00:00Z"))
    )
      throw new DeskRequestError(400, "Choose a valid due date");
    return {
      status: 200,
      body: {
        commitment: await command(`/confirm ${id(data)} ${data.due_date}`),
      },
    };
  }
  if (
    path === "/private/api/desk/dismiss" ||
    path === "/private/api/desk/done" ||
    path === "/private/api/desk/separate"
  ) {
    fields(data, ["id"]);
    const verb = path.endsWith("dismiss")
      ? "/dismiss"
      : path.endsWith("separate")
        ? "/separate"
        : "/done";
    return {
      status: 200,
      body: { commitment: await command(`${verb} ${id(data)}`) },
    };
  }
  const outreach = options.outreach;
  if (!outreach) throw new DeskRequestError(404, "Outreach is not enabled");
  if (path === "/private/api/outreach/edit") {
    fields(data, ["id", "text"]);
    if (
      typeof data.text !== "string" ||
      !data.text.trim() ||
      data.text.length > 2000
    )
      throw new DeskRequestError(
        400,
        "Draft text must be 1 to 2000 characters",
      );
    const text = data.text;
    return {
      status: 200,
      body: { item: await guard(() => outreach.edit(id(data), text)) },
    };
  }
  if (
    path === "/private/api/outreach/approve" ||
    path === "/private/api/outreach/skip"
  ) {
    const approving = path.endsWith("approve");
    fields(data, approving ? ["id", "text_code"] : ["id"]);
    const itemId = id(data);
    const seen = data.text_code;
    if (approving && (typeof seen !== "string" || !/^[0-9a-f]{8}$/.test(seen)))
      throw new DeskRequestError(400, "Unexpected request fields");
    return {
      status: 200,
      body: {
        item: await guard(() =>
          approving
            ? outreach.approve(itemId, seen as string)
            : outreach.skip(itemId),
        ),
      },
    };
  }
  throw new DeskRequestError(404, "Unknown private route");
}
