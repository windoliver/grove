import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTrajectorySpecs } from "./spec-loader.js";

async function writeSpec(name: string, text: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "trajectory-spec-"));
  const path = join(dir, name);
  await writeFile(path, text, "utf8");
  return path;
}

describe("loadTrajectorySpecs", () => {
  test("loads and merges rules and deferred goals", async () => {
    const specPath = await writeSpec(
      "common.yaml",
      [
        "name: common",
        "rules:",
        "  - id: no-denials",
        "    kind: must_not_exist",
        "    match:",
        "      event: PERMISSION_DENIED",
        "goals:",
        "  - id: user-goal",
        "    criteria: User goal was met.",
        "    evidence: [assistant_message]",
      ].join("\n"),
    );

    const spec = await loadTrajectorySpecs([specPath]);
    expect(spec.name).toBe("common");
    expect(spec.rules[0]?.id).toBe("no-denials");
    expect(spec.goals[0]?.id).toBe("user-goal");
    expect(spec.sourcePaths).toEqual([specPath]);
  });

  test("rejects duplicate rule ids across files", async () => {
    const one = await writeSpec(
      "one.yaml",
      "name: one\nrules:\n  - id: same\n    kind: must_exist\n",
    );
    const two = await writeSpec(
      "two.yaml",
      "name: two\nrules:\n  - id: same\n    kind: must_not_exist\n",
    );

    await expect(loadTrajectorySpecs([one, two])).rejects.toThrow(/duplicate rule id: same/);
  });
});
