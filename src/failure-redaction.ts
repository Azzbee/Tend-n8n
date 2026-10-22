import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { EXECUTION_URL, executionUrlOf } from "./desk-model.ts";

// Private-lane failures keep only design-time text: workflow and node names,
// a guard message that is a literal string in the workflow code, or an HTTP
// status. Any other error text is withheld because it may quote provider data.
export const WITHHELD = "unlisted error (text withheld)";
export type FailureEntry = {
  workflow: string;
  node: string;
  message: string;
  execution_id: string;
  execution_url: string;
};
const literalError = /new Error\((['"])([^'"\\\n]{1,200})\1\)/g;

export function guardMessages(sources: string[]): string[] {
  const found = new Set<string>();
  for (const source of sources)
    for (const m of source.matchAll(literalError)) found.add(m[2]!);
  return [...found].sort();
}

export function workflowCodeSources(workflow: unknown): string[] {
  const nodes =
    workflow && typeof workflow === "object" && "nodes" in workflow
      ? (workflow as { nodes: unknown }).nodes
      : [];
  if (!Array.isArray(nodes)) return [];
  return nodes.flatMap((n: { parameters?: { jsCode?: unknown } }) =>
    typeof n?.parameters?.jsCode === "string" ? [n.parameters.jsCode] : [],
  );
}

// Resolved from this file, not the cwd: a LaunchAgent may start the API elsewhere.
const exportsDir = fileURLToPath(new URL("../workflows", import.meta.url));
export function loadPrivateGuardMessages(dir = exportsDir): string[] {
  try {
    return guardMessages(
      readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => JSON.parse(readFileSync(`${dir}/${f}`, "utf8")) as unknown)
        .filter(
          (w) =>
            (w as { settings?: { errorWorkflow?: unknown } })?.settings
              ?.errorWorkflow === "TendPrivate22",
        )
        .flatMap((w) => workflowCodeSources(w)),
    );
  } catch {
    // Fail closed: with no allowlist only HTTP statuses and WITHHELD pass.
    return [];
  }
}

// Code for the n8n Error Trigger handler; mirrors acceptFailure below.
export function redactorCode(allowed: string[]): string {
  return `const allowed=new Set(${JSON.stringify(allowed)});const e=$input.first().json;const ex=e.execution||{};const er=ex.error||{};const wf=e.workflow&&typeof e.workflow.name==='string'?e.workflow.name:'unknown workflow';const node=ex.lastNodeExecuted||(er.node&&er.node.name)||'unknown node';const raw=typeof er.message==='string'?er.message:'';const http=/^[1-5]\\d\\d$/.test(String(er.httpCode??''))?String(er.httpCode):(raw.match(/status code ([1-5]\\d\\d)\\b/)||[])[1];const message=allowed.has(raw)?raw:http?'HTTP '+http:${JSON.stringify(WITHHELD)};return [{json:{workflow:String(wf).slice(0,120),node:String(node).slice(0,120),message,execution_id:String(ex.id??'').slice(0,40),execution_url:typeof ex.url==='string'&&${String(EXECUTION_URL)}.test(ex.url)?ex.url:''}}];`;
}

export function acceptFailure(value: unknown, allowed: string[]): FailureEntry {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid failure entry");
  const v = value as Record<string, unknown>;
  // Four keys is the shape a 21 or 22 published before execution_url posts.
  const keys = Object.keys(v).sort().join(",");
  if (
    keys !== "execution_id,message,node,workflow" &&
    keys !== "execution_id,execution_url,message,node,workflow"
  )
    throw new Error("invalid failure entry");
  const { workflow, node, message, execution_id, execution_url = "" } = v;
  if (
    typeof workflow !== "string" ||
    typeof node !== "string" ||
    typeof message !== "string" ||
    typeof execution_id !== "string" ||
    !workflow ||
    workflow.length > 120 ||
    !node ||
    node.length > 120 ||
    !/^[A-Za-z0-9-]{0,40}$/.test(execution_id) ||
    (execution_url !== "" && executionUrlOf(execution_url) === "")
  )
    throw new Error("invalid failure entry");
  if (
    message !== WITHHELD &&
    !/^HTTP [1-5]\d\d$/.test(message) &&
    !allowed.includes(message)
  )
    throw new Error("failure message is not redacted");
  return {
    workflow,
    node,
    message,
    execution_id,
    execution_url: String(execution_url),
  };
}

export function createFailureLog(allowed: string[], keep = 50) {
  const entries: (FailureEntry & { at: string })[] = [];
  return {
    add(value: unknown, at: Date): FailureEntry {
      const entry = acceptFailure(value, allowed);
      entries.push({ ...entry, at: at.toISOString() });
      if (entries.length > keep) entries.splice(0, entries.length - keep);
      return entry;
    },
    list: () => entries.map((e) => ({ ...e })),
  };
}
