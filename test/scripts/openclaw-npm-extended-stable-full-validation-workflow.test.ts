import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import { parse } from "yaml";

const fullValidationPath = ".github/workflows/full-release-validation.yml";
const releaseChecksPath = ".github/workflows/openclaw-release-checks.yml";

type Step = { env?: Record<string, string>; name?: string; run?: string };
type Workflow = { jobs?: Record<string, { steps?: Step[] }> };

function workflowStep(path: string, jobName: string, stepName: string): Step {
  const workflow = parse(readFileSync(path, "utf8")) as Workflow;
  return expectDefined(
    workflow.jobs?.[jobName]?.steps?.find((step) => step.name === stepName),
    `${jobName} / ${stepName}`,
  );
}

const targetRef = '-f target_ref="$TARGET_SHA"';
const expectedSha = '-f expected_sha="$TARGET_SHA"';
it.each([
  ["normal_ci", "CI", "ci", targetRef, false],
  [
    "plugin_prerelease",
    "plugin prerelease",
    "plugin-prerelease",
    `${targetRef} ${expectedSha}`,
    true,
  ],
  ["release_checks", "release checks", "openclaw-release-checks", expectedSha, true],
  ["performance", "OpenClaw Performance", "openclaw-performance", targetRef, false],
] as const)("dispatches %s with the frozen target context", (job, name, child, target, phased) => {
  for (const phase of phased ? ["independent", "candidate"] : [""]) {
    const dispatch = workflowStep(
      fullValidationPath,
      phase ? `${job}_${phase}` : job,
      `Dispatch ${name}${phase ? ` ${phase} phase` : ""}`,
    );
    for (const text of [`${child}.yml`, '--ref "$CHILD_WORKFLOW_REF"', target]) {
      expect(dispatch.run).toContain(text);
    }
    if (phased) {
      expect(dispatch.run).toContain('-f phase="$PHASE"');
    }
    if (job === "plugin_prerelease") {
      expect(dispatch.env?.TARGET_CONTEXT_REF).toBe("${{ inputs.target_context_ref }}");
      expect(dispatch.run).toContain('args+=(-f target_context_ref="$TARGET_CONTEXT_REF")');
    }
  }
});

it("accepts only the exact extended-stable/YYYY.M.33 workflow-ref shape", () => {
  const guard = expectDefined(
    workflowStep(
      releaseChecksPath,
      "resolve_target",
      "Require trusted workflow ref for release checks",
    ).run,
    "release-checks trusted-ref guard",
  );
  for (const suffix of "2026.6.33 2026.12.33 2026.0.33 2026.01.33 2026.13.33 2026.6.32 2026.6.34 2026.6.33/extra not-a-release".split(
    " ",
  )) {
    const ref = `refs/heads/extended-stable/${suffix}`;
    const result = spawnSync("bash", ["-euo", "pipefail", "-c", guard], {
      encoding: "utf8",
      env: { ...process.env, RELEASE_REF: "extended-stable/2026.6.33", WORKFLOW_REF: ref },
    });
    if (suffix === "2026.6.33" || suffix === "2026.12.33") {
      expect(result.status, String(result.stderr)).toBe(0);
    } else {
      expect(result.status, ref).not.toBe(0);
      expect(result.stderr).toContain("extended-stable/YYYY.M.33");
    }
  }
});
