import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LaunchGoalSessionInput, LaunchGoalSessionResult } from "../utils/launch-session.js";
import { runRecipe } from "./recipe.js";

type LaunchFn = (input: LaunchGoalSessionInput) => Promise<LaunchGoalSessionResult>;

const RECIPE = `kind: recipe
recipe_version: 1
name: demo-loop
version: 1.0.0
instructions: |
  Work on \${parameters.target}.
parameters:
  target:
    type: string
    required: true
extensions:
  - type: mcp
    name: fs
    uri: stdio:grove-fs-mcp
agent_topology:
  structure: graph
  roles:
    - name: coder
      platform: claude-code
`;

describe("recipe run (live wiring)", () => {
  test("materializes recipe into launch input with provenance + stdio extension", async () => {
    const root = await mkdtemp(join(tmpdir(), "grove-reciperun-"));
    execFileSync("git", ["init", "-q"], { cwd: root });
    await mkdir(join(root, ".grove"), { recursive: true });
    const recipePath = join(root, "demo.yaml");
    await writeFile(recipePath, RECIPE);
    const lines: string[] = [];
    // capture the launch input; do not spawn anything
    let captured: LaunchGoalSessionInput | undefined;
    const fakeLaunch: LaunchFn = async (input) => {
      captured = input;
      input.onAgentsStarted?.({
        sessionId: "sess-test",
        agents: [{ role: "coder", session: { id: "a1", status: "running" } }],
      });
      return { sessionId: "sess-test", stopStatus: "achieved", stopReason: "done" };
    };
    try {
      await runRecipe(
        {
          command: "run",
          path: recipePath,
          params: { target: "./src" },
          dryRun: false,
          json: true,
          repos: [],
        },
        { cwd: root, writer: (l) => lines.push(l), launch: fakeLaunch },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
    // goal came from rendered instructions
    expect(captured?.goal).toContain("Work on ./src");
    // topology threaded through
    expect(captured?.topology.roles.map((r) => r.name)).toContain("coder");
    // stdio extension wired
    expect(captured?.extraMcpServers?.map((s) => s.name)).toContain("fs");
    // provenance carries the recipe identity + a blake3 digest
    expect(captured?.recipeProvenance?.recipeName).toBe("demo-loop");
    expect(captured?.recipeProvenance?.recipeDigest).toMatch(/^blake3:/);
    // output mentions the session
    expect(lines.join("\n")).toContain("sess-test");
  });

  test("errors when no goal and no instructions", async () => {
    const root = await mkdtemp(join(tmpdir(), "grove-reciperun-"));
    execFileSync("git", ["init", "-q"], { cwd: root });
    await mkdir(join(root, ".grove"), { recursive: true });
    const recipePath = join(root, "no-instr.yaml");
    await writeFile(
      recipePath,
      `kind: recipe\nrecipe_version: 1\nname: x\nversion: 1.0.0\nagent_topology:\n  structure: graph\n  roles:\n    - name: coder\n`,
    );
    const fakeLaunch: LaunchFn = async () => ({
      sessionId: "x",
      stopStatus: "achieved",
      stopReason: "",
    });
    try {
      await expect(
        runRecipe(
          { command: "run", path: recipePath, params: {}, dryRun: false, json: false, repos: [] },
          {
            cwd: root,
            writer: () => {
              /* discard output */
            },
            launch: fakeLaunch,
          },
        ),
      ).rejects.toThrow(/goal/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
