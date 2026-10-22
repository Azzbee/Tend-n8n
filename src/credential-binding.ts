// Private exports carry CONFIGURE_* credential placeholders. Some workflows
// (11 and 12) embed sub-workflow 13 as a JSON string, so binding must reach
// nodes inside executeWorkflow workflowJson as well as top-level nodes.
type Credentials = Record<string, { id: string; name: string }>;
type BindableNode = {
  name: string;
  credentials?: Credentials;
  parameters?: Record<string, unknown>;
};
export type Binding = Record<string, { id: string; name: string }>;

function eachNode(
  workflow: { nodes: BindableNode[] },
  visit: (node: BindableNode, path: string) => void,
  prefix = "",
): void {
  for (const node of workflow.nodes) {
    const path = prefix + node.name;
    visit(node, path);
    const inline = node.parameters?.workflowJson;
    if (typeof inline === "string") {
      const child = JSON.parse(inline) as { nodes: BindableNode[] };
      eachNode(child, visit, path + " > ");
      node.parameters!.workflowJson = JSON.stringify(child);
    }
  }
}

export function placeholderCredentials(workflow: {
  nodes: BindableNode[];
}): string[] {
  const copy = JSON.parse(JSON.stringify(workflow)) as {
    nodes: BindableNode[];
  };
  const found: string[] = [];
  eachNode(copy, (node, path) => {
    for (const [type, c] of Object.entries(node.credentials ?? {}))
      if (c.id.startsWith("CONFIGURE_")) found.push(`${path} (${type})`);
  });
  return found;
}

// Binds placeholder IDs (keys of `binding`) at every level, then refuses to
// return a workflow that still has any placeholder left.
export function bindCredentials<W extends { nodes: BindableNode[] }>(
  workflow: W,
  binding: Binding,
): W {
  const bound = JSON.parse(JSON.stringify(workflow)) as W;
  eachNode(bound, (node) => {
    for (const [type, c] of Object.entries(node.credentials ?? {})) {
      const real = binding[c.id];
      if (real) node.credentials![type] = { ...real };
    }
  });
  const left = placeholderCredentials(bound);
  if (left.length)
    throw new Error(`Unbound credential placeholders: ${left.join("; ")}`);
  return bound;
}
