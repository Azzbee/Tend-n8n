import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// The plan's docker-logs step must keep IDs, node names and counts only.
describe("failure-analysis plan log filter", () => {
  it("drops message text, names and addresses from n8n error lines", () => {
    const plan = readFileSync("docs/plans/n8n-failure-analysis.md", "utf8");
    const step = /`docker logs [^`]*`/.exec(plan)![0].slice(1, -1);
    const filter = step.slice(step.indexOf("| grep -iE"));
    const sample = [
      'Error in workflowId=TendGoogle11 node="Fetch Gmail page": Request failed for mira@example.invalid "Hi Mira, the demo is ready" https://leak.example/x',
      "2026-10-21 info: workflow TendGoogle12 ran fine",
    ].join("\n");
    const out = execFileSync("bash", ["-c", `cat ${filter}`], {
      input: sample,
      encoding: "utf8",
    });
    expect(out).toContain("TendGoogle11");
    expect(out).toContain('node="Fetch Gmail page"');
    for (const leak of ["mira@", "Hi Mira", "leak.example", "demo is ready"])
      expect(out).not.toContain(leak);
  });
});
