# Native Skill Injection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-task native skill injection — inject a topology-declared subset of skills from a local catalog (bundled `skills/` + optional `.grove/skills/` override) into each agent workspace's `.claude/skills/` and `.codex/skills/` at bootstrap time.

**Architecture:** One new pure module `src/core/skill-injector.ts` that resolves skill names against a two-layer catalog and recursive-copies into provider-native paths. Invoked from the shared `bootstrapWorkspace` helper (for `SessionOrchestrator`) and, inline, from `SpawnManager` (which does not use the shared helper today). Topology `AgentRole` gains a `skills?: string[]` field. `grove skill install` refactors to read from the same on-disk catalog, eliminating the in-memory `renderSkillTemplate` rendering path.

**Tech Stack:** TypeScript · Bun (runtime + test runner) · `node:fs/promises` · `zod` (existing topology wire validation) · Biome (lint) · TypeScript strict mode.

---

## Spec Reference

`docs/superpowers/specs/2026-04-20-native-skill-injection-design.md`

## File Structure

| File | Responsibility | Status |
|---|---|---|
| `skills/grove/SKILL.md` | Bundled default skill content. Static Markdown + frontmatter. | **Create** |
| `src/core/skill-injector.ts` | Pure module: resolve skill names → copy dirs to native paths. | **Create** |
| `src/core/skill-injector.test.ts` | Unit tests against tmp dirs. | **Create** |
| `src/core/topology.ts` | Add `skills?: readonly string[]` to `AgentRole`, wire schema, `wireToTopology`. | **Modify** |
| `src/core/topology.test.ts` | Assert wire field parses; strict rejection still works. | **Modify** |
| `src/core/workspace-bootstrap.ts` | Extend `BootstrapOptions`; invoke `injectSkills`; include injected files in `chmod` pass. | **Modify** |
| `src/core/workspace-bootstrap.test.ts` | Assert injection runs when `skills` present; absent when not. | **Modify** |
| `src/core/session-orchestrator.ts` | Pass `skills`/`bundledSkillsRoot`/`workspaceOverrideRoot` into bootstrap. | **Modify** |
| `src/tui/spawn-manager.ts` | Inline call to `injectSkills` alongside existing inline config writes. | **Modify** |
| `src/cli/commands/skill.ts` | Load `SKILL.md` from on-disk catalog instead of calling `renderSkillTemplate`. | **Modify** |
| `src/cli/commands/skill.test.ts` | Drop template tests; assert install reads from catalog. | **Modify** |
| `src/cli/commands/skill-template.ts` | Rendering function no longer needed. | **Delete** |
| `src/core/acpx-runtime.integration.test.ts` | Add assertion: skills land in `cwd` of spawned session. | **Modify** |

Each modified file retains its current responsibility. No restructuring beyond the added field and the new injector module.

---

## Conventions

- **Runtime / tests:** Bun. Test commands below use `bun test <path>`.
- **Typecheck:** `bun run typecheck`.
- **Lint/format:** `bun run check`.
- **Commit messages:** follow repo style (see recent `git log`): `feat: ...` / `fix: ...` / `refactor: ...` / `test: ...` — short imperative subject, no body unless needed.
- **Never skip hooks.** Never `--no-verify`.

---

## Task 1: Seed the bundled catalog

**Files:**
- Create: `skills/grove/SKILL.md`

- [ ] **Step 1: Create the catalog directory and skill file**

Write `skills/grove/SKILL.md` with the content below. This is derived from the current `renderSkillTemplate` output with the dynamic `${serverUrl}` / `${mcpUrl}` interpolations removed — agents discover the grove MCP server through `.mcp.json` at runtime.

```markdown
---
name: grove
description: Multi-agent collaboration via Grove boardroom.
---

## Grove Boardroom

You are participating in a Grove collaboration session.

### MCP Server

Connect via the `grove` MCP server declared in this workspace's `.mcp.json` (stdio).

### Tools
- grove_submit_work — publish work with artifacts
- grove_submit_review — review with scores
- grove_claim — claim a task
- grove_discuss — post discussion
- grove_adopt — adopt a contribution
- grove_frontier — see rankings
- grove_goal — read current goal
- grove_send_message — message agents
- grove_checkout — get artifacts

### Workflow
1. Read the goal (grove_goal)
2. Claim work (grove_claim)
3. Do your work in YOUR code folder
4. Publish results (grove_submit_work)
5. Read reviews, iterate
```

- [ ] **Step 2: Verify the file shape**

Run: `ls skills/grove/`
Expected: `SKILL.md`

Run: `head -5 skills/grove/SKILL.md`
Expected: frontmatter with `name: grove`.

- [ ] **Step 3: Commit**

```bash
git add skills/grove/SKILL.md
git commit -m "feat(skills): add bundled grove skill catalog entry"
```

---

## Task 2: Add `skills` to the topology wire schema (red)

**Files:**
- Modify: `src/core/topology.ts`
- Modify: `src/core/topology.test.ts`

The existing wire schema is defined with `zod` and is strict (`.strict()` or equivalent) — unknown keys are rejected. We need to add an optional `skills` array of strings and make sure it flows through `wireToTopology`.

- [ ] **Step 1: Write the failing test**

Append to `src/core/topology.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { AgentTopologySchema, wireToTopology } from "./topology.js";

describe("topology skills field", () => {
  test("parses skills list on a role", () => {
    const parsed = AgentTopologySchema.parse({
      structure: "flat",
      roles: [
        { name: "coder", skills: ["grove", "review"] },
      ],
    });
    const topology = wireToTopology(parsed);
    expect(topology.roles[0]?.skills).toEqual(["grove", "review"]);
  });

  test("omits skills when not provided", () => {
    const parsed = AgentTopologySchema.parse({
      structure: "flat",
      roles: [{ name: "coder" }],
    });
    const topology = wireToTopology(parsed);
    expect(topology.roles[0]?.skills).toBeUndefined();
  });

  test("rejects non-string entries in skills", () => {
    expect(() =>
      AgentTopologySchema.parse({
        structure: "flat",
        roles: [{ name: "coder", skills: [123] }],
      }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/topology.test.ts -t "topology skills field"`
Expected: FAIL — `AgentTopologySchema` strict schema rejects the unknown `skills` key.

- [ ] **Step 3: Commit the failing test**

```bash
git add src/core/topology.test.ts
git commit -m "test(topology): failing test for skills field on role"
```

---

## Task 3: Implement `skills` on `AgentRole` + wire schema (green)

**Files:**
- Modify: `src/core/topology.ts`

- [ ] **Step 1: Add `skills` to `AgentRole`**

In `src/core/topology.ts`, locate the `AgentRole` interface (around line 322) and add the new field after `goal`:

```ts
export interface AgentRole {
  readonly name: string;
  readonly description?: string | undefined;
  readonly maxInstances?: number | undefined;
  readonly mode?: "explicit" | "broadcast" | undefined;
  readonly edges?: readonly RoleEdge[] | undefined;
  readonly command?: string | undefined;
  readonly platform?: AgentPlatformType | undefined;
  readonly model?: string | undefined;
  readonly color?: string | undefined;
  readonly prompt?: string | undefined;
  readonly goal?: string | undefined;
  /** Names of skills to inject into this role's workspace at bootstrap. */
  readonly skills?: readonly string[] | undefined;
}
```

- [ ] **Step 2: Extend the wire schema**

Locate the role object in `AgentTopologySchema` (the zod schema — search for `roles:` within the file). Add the optional `skills` field:

```ts
// inside the role object schema
skills: z.array(z.string().min(1)).optional(),
```

Keep the strict mode behavior of the surrounding schema untouched.

- [ ] **Step 3: Pass `skills` through `wireToTopology`**

In `wireToTopology` (around line 365), add a pass-through line next to the existing `goal` line:

```ts
...(role.goal !== undefined && { goal: role.goal }),
...(role.skills !== undefined && { skills: role.skills }),
```

- [ ] **Step 4: Run the tests**

Run: `bun test src/core/topology.test.ts`
Expected: PASS.

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/topology.ts
git commit -m "feat(topology): add skills field to AgentRole"
```

---

## Task 4: `skill-injector.ts` — failing tests (red)

**Files:**
- Create: `src/core/skill-injector.test.ts`

Write the full test suite against the to-be-created module. Tests exercise real file I/O against a temp directory (matching the style of `workspace-bootstrap.test.ts`).

- [ ] **Step 1: Write the failing test file**

Create `src/core/skill-injector.test.ts`:

```ts
/**
 * Tests for skill-injector.
 *
 * Exercises real file I/O against a temporary directory.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { injectSkills, SkillResolutionError } from "./skill-injector.js";

let root: string;
let bundledRoot: string;
let overrideRoot: string;
let workspace: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "grove-skill-injector-"));
  bundledRoot = join(root, "bundled");
  overrideRoot = join(root, "override");
  workspace = join(root, "workspace");
  mkdirSync(bundledRoot, { recursive: true });
  mkdirSync(overrideRoot, { recursive: true });
  mkdirSync(workspace, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeBundledSkill(name: string, files: Record<string, string>): void {
  const dir = join(bundledRoot, name);
  mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content, "utf-8");
  }
}

function writeOverrideSkill(name: string, files: Record<string, string>): void {
  const dir = join(overrideRoot, name);
  mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content, "utf-8");
  }
}

describe("injectSkills", () => {
  test("copies a single bundled skill to both native paths", async () => {
    writeBundledSkill("grove", { "SKILL.md": "bundled-content" });

    const report = await injectSkills({
      workspacePath: workspace,
      skills: ["grove"],
      bundledSkillsRoot: bundledRoot,
    });

    expect(report.injected).toHaveLength(1);
    expect(report.injected[0]?.source).toBe("bundled");

    const claudePath = join(workspace, ".claude/skills/grove/SKILL.md");
    const codexPath = join(workspace, ".codex/skills/grove/SKILL.md");
    expect(readFileSync(claudePath, "utf-8")).toBe("bundled-content");
    expect(readFileSync(codexPath, "utf-8")).toBe("bundled-content");
  });

  test("sets injected files read-only (0o444)", async () => {
    writeBundledSkill("grove", { "SKILL.md": "x" });

    await injectSkills({
      workspacePath: workspace,
      skills: ["grove"],
      bundledSkillsRoot: bundledRoot,
    });

    const mode = statSync(join(workspace, ".claude/skills/grove/SKILL.md")).mode & 0o777;
    expect(mode).toBe(0o444);
  });

  test("workspace override wins over bundled", async () => {
    writeBundledSkill("grove", { "SKILL.md": "bundled" });
    writeOverrideSkill("grove", { "SKILL.md": "override" });

    const report = await injectSkills({
      workspacePath: workspace,
      skills: ["grove"],
      bundledSkillsRoot: bundledRoot,
      workspaceOverrideRoot: overrideRoot,
    });

    expect(report.injected[0]?.source).toBe("override");
    expect(readFileSync(join(workspace, ".claude/skills/grove/SKILL.md"), "utf-8")).toBe(
      "override",
    );
  });

  test("unknown skill throws SkillResolutionError and writes nothing", async () => {
    writeBundledSkill("grove", { "SKILL.md": "x" });

    await expect(
      injectSkills({
        workspacePath: workspace,
        skills: ["grove", "missing"],
        bundledSkillsRoot: bundledRoot,
      }),
    ).rejects.toBeInstanceOf(SkillResolutionError);

    expect(existsSync(join(workspace, ".claude/skills/grove"))).toBe(false);
    expect(existsSync(join(workspace, ".codex/skills/grove"))).toBe(false);
  });

  test("skill dir without SKILL.md throws", async () => {
    mkdirSync(join(bundledRoot, "broken"), { recursive: true });
    writeFileSync(join(bundledRoot, "broken", "README.md"), "no skill.md here");

    await expect(
      injectSkills({
        workspacePath: workspace,
        skills: ["broken"],
        bundledSkillsRoot: bundledRoot,
      }),
    ).rejects.toBeInstanceOf(SkillResolutionError);
  });

  test("dir-shaped skill with siblings copies every file", async () => {
    writeBundledSkill("multi", {
      "SKILL.md": "root",
      "helper.md": "helper",
      "nested/note.md": "deep",
    });

    await injectSkills({
      workspacePath: workspace,
      skills: ["multi"],
      bundledSkillsRoot: bundledRoot,
    });

    const base = join(workspace, ".claude/skills/multi");
    expect(readFileSync(join(base, "SKILL.md"), "utf-8")).toBe("root");
    expect(readFileSync(join(base, "helper.md"), "utf-8")).toBe("helper");
    expect(readFileSync(join(base, "nested/note.md"), "utf-8")).toBe("deep");

    const codexBase = join(workspace, ".codex/skills/multi");
    expect(readFileSync(join(codexBase, "nested/note.md"), "utf-8")).toBe("deep");
  });

  test("empty skills list is a no-op", async () => {
    const report = await injectSkills({
      workspacePath: workspace,
      skills: [],
      bundledSkillsRoot: bundledRoot,
    });

    expect(report.injected).toHaveLength(0);
    expect(existsSync(join(workspace, ".claude"))).toBe(false);
    expect(existsSync(join(workspace, ".codex"))).toBe(false);
  });

  test("missing override root falls back to bundled without error", async () => {
    writeBundledSkill("grove", { "SKILL.md": "b" });

    const report = await injectSkills({
      workspacePath: workspace,
      skills: ["grove"],
      bundledSkillsRoot: bundledRoot,
      workspaceOverrideRoot: join(root, "does-not-exist"),
    });

    expect(report.injected[0]?.source).toBe("bundled");
  });

  test("overwrites existing target dir (reattach / workspace reuse)", async () => {
    writeBundledSkill("grove", { "SKILL.md": "new" });
    mkdirSync(join(workspace, ".claude/skills/grove"), { recursive: true });
    writeFileSync(join(workspace, ".claude/skills/grove/SKILL.md"), "stale", "utf-8");

    await injectSkills({
      workspacePath: workspace,
      skills: ["grove"],
      bundledSkillsRoot: bundledRoot,
    });

    expect(readFileSync(join(workspace, ".claude/skills/grove/SKILL.md"), "utf-8")).toBe("new");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/core/skill-injector.test.ts`
Expected: FAIL — `Cannot find module './skill-injector.js'`.

- [ ] **Step 3: Commit the failing test**

```bash
git add src/core/skill-injector.test.ts
git commit -m "test(core): failing tests for skill-injector module"
```

---

## Task 5: `skill-injector.ts` — implementation (green)

**Files:**
- Create: `src/core/skill-injector.ts`

- [ ] **Step 1: Implement the module**

Create `src/core/skill-injector.ts`:

```ts
/**
 * skill-injector — resolve named skills against a two-layer catalog
 * (workspace override first, bundled default second) and recursive-copy
 * each resolved directory into the workspace's Claude and Codex native
 * skill paths.
 *
 * Pure module: no Nexus, no network, no runtime templating.
 */

import { chmod, cp, mkdir, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

export interface SkillInjectionOptions {
  /** Absolute path to the agent workspace directory. */
  workspacePath: string;
  /** Skill names to inject (from topology role). */
  skills: readonly string[];
  /** Absolute path to the bundled catalog (grove repo's top-level `skills/`). */
  bundledSkillsRoot: string;
  /** Optional absolute path to workspace-specific overrides. */
  workspaceOverrideRoot?: string | undefined;
}

export interface InjectedSkill {
  readonly name: string;
  readonly source: "override" | "bundled";
  readonly sourcePath: string;
  readonly targets: readonly string[];
}

export interface InjectionReport {
  readonly injected: readonly InjectedSkill[];
}

export class SkillResolutionError extends Error {
  readonly skillName: string;
  readonly searchedPaths: readonly string[];
  constructor(skillName: string, searchedPaths: readonly string[]) {
    super(
      `Skill '${skillName}' not found. Searched: ${searchedPaths.join(", ")}`,
    );
    this.name = "SkillResolutionError";
    this.skillName = skillName;
    this.searchedPaths = searchedPaths;
  }
}

const CLAUDE_SUBPATH = ".claude/skills";
const CODEX_SUBPATH = ".codex/skills";

async function isDir(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isDirectory();
  } catch {
    return false;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isFile();
  } catch {
    return false;
  }
}

interface Resolved {
  name: string;
  source: "override" | "bundled";
  sourcePath: string;
}

async function resolveSkill(
  name: string,
  bundledRoot: string,
  overrideRoot: string | undefined,
): Promise<Resolved> {
  const searched: string[] = [];

  if (overrideRoot) {
    const overridePath = join(overrideRoot, name);
    searched.push(overridePath);
    if ((await isDir(overridePath)) && (await isFile(join(overridePath, "SKILL.md")))) {
      return { name, source: "override", sourcePath: overridePath };
    }
  }

  const bundledPath = join(bundledRoot, name);
  searched.push(bundledPath);
  if ((await isDir(bundledPath)) && (await isFile(join(bundledPath, "SKILL.md")))) {
    return { name, source: "bundled", sourcePath: bundledPath };
  }

  throw new SkillResolutionError(name, searched);
}

async function copyDir(source: string, target: string): Promise<void> {
  await mkdir(target, { recursive: true });
  await cp(source, target, { recursive: true, force: true });
}

async function chmodTree(root: string, mode: number): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      await chmodTree(full, mode);
    } else {
      await chmod(full, mode).catch(() => undefined);
    }
  }
}

export async function injectSkills(
  opts: SkillInjectionOptions,
): Promise<InjectionReport> {
  if (opts.skills.length === 0) {
    return { injected: [] };
  }

  const overrideExists = opts.workspaceOverrideRoot
    ? await isDir(opts.workspaceOverrideRoot)
    : false;
  const effectiveOverride = overrideExists ? opts.workspaceOverrideRoot : undefined;

  const resolved: Resolved[] = [];
  for (const name of opts.skills) {
    resolved.push(await resolveSkill(name, opts.bundledSkillsRoot, effectiveOverride));
  }

  const injected: InjectedSkill[] = [];
  for (const r of resolved) {
    const claudeTarget = join(opts.workspacePath, CLAUDE_SUBPATH, r.name);
    const codexTarget = join(opts.workspacePath, CODEX_SUBPATH, r.name);

    await copyDir(r.sourcePath, claudeTarget);
    await copyDir(r.sourcePath, codexTarget);
    await chmodTree(claudeTarget, 0o444);
    await chmodTree(codexTarget, 0o444);

    injected.push({
      name: r.name,
      source: r.source,
      sourcePath: r.sourcePath,
      targets: [claudeTarget, codexTarget],
    });
  }

  return { injected };
}
```

- [ ] **Step 2: Run the tests**

Run: `bun test src/core/skill-injector.test.ts`
Expected: PASS (all 9 tests).

Run: `bun run typecheck`
Expected: PASS.

Run: `bun run check`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/core/skill-injector.ts
git commit -m "feat(core): add skill-injector for per-task native skill writes"
```

---

## Task 6: Wire injector into `bootstrapWorkspace` — failing tests (red)

**Files:**
- Modify: `src/core/workspace-bootstrap.test.ts`

- [ ] **Step 1: Extend the bootstrap test suite**

Append these tests to `src/core/workspace-bootstrap.test.ts` (after the existing `test("creates .grove context directory"...)`):

```ts
test("injects skills when role declares them", async () => {
  const bundledRoot = mkdtempSync(join(tmpdir(), "grove-bundled-"));
  const skillDir = join(bundledRoot, "grove");
  // mkdir + writeFile synchronously to prepare the catalog
  const { mkdirSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "catalog-grove", "utf-8");

  await bootstrapWorkspace({
    workspacePath: workspaceDir,
    roleId: "coder",
    goal: "Build",
    skills: ["grove"],
    bundledSkillsRoot: bundledRoot,
  });

  const claudePath = join(workspaceDir, ".claude/skills/grove/SKILL.md");
  const codexPath = join(workspaceDir, ".codex/skills/grove/SKILL.md");
  expect(existsSync(claudePath)).toBe(true);
  expect(existsSync(codexPath)).toBe(true);
  expect(readFileSync(claudePath, "utf-8")).toBe("catalog-grove");

  rmSync(bundledRoot, { recursive: true, force: true });
});

test("does not create .claude/.codex dirs when role has no skills", async () => {
  await bootstrapWorkspace({
    workspacePath: workspaceDir,
    roleId: "coder",
    goal: "Build",
  });

  expect(existsSync(join(workspaceDir, ".claude"))).toBe(false);
  expect(existsSync(join(workspaceDir, ".codex"))).toBe(false);
});

test("propagates skill resolution errors as bootstrap failures", async () => {
  const bundledRoot = mkdtempSync(join(tmpdir(), "grove-bundled-"));

  await expect(
    bootstrapWorkspace({
      workspacePath: workspaceDir,
      roleId: "coder",
      goal: "Build",
      skills: ["missing"],
      bundledSkillsRoot: bundledRoot,
    }),
  ).rejects.toThrow(/missing/);

  rmSync(bundledRoot, { recursive: true, force: true });
});

test("throws when skills non-empty but bundledSkillsRoot missing", async () => {
  await expect(
    bootstrapWorkspace({
      workspacePath: workspaceDir,
      roleId: "coder",
      goal: "Build",
      skills: ["grove"],
    }),
  ).rejects.toThrow(/bundledSkillsRoot/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/core/workspace-bootstrap.test.ts`
Expected: FAIL — unknown option `skills` / `bundledSkillsRoot` passes through but does nothing; assertions about `.claude/skills/grove/SKILL.md` fail because the file is never written.

- [ ] **Step 3: Commit the failing tests**

```bash
git add src/core/workspace-bootstrap.test.ts
git commit -m "test(bootstrap): failing tests for skill injection integration"
```

---

## Task 7: Wire injector into `bootstrapWorkspace` — implementation (green)

**Files:**
- Modify: `src/core/workspace-bootstrap.ts`

- [ ] **Step 1: Extend `BootstrapOptions`**

In `src/core/workspace-bootstrap.ts`, add the three new fields to `BootstrapOptions`:

```ts
export interface BootstrapOptions {
  workspacePath: string;
  roleId: string;
  goal?: string;
  rolePrompt?: string | undefined;
  roleDescription?: string | undefined;
  groveDir?: string | undefined;
  mcpServePath?: string | undefined;
  nexusUrl?: string | undefined;
  nexusApiKey?: string | undefined;
  /** Skill names to inject. If empty or omitted, no injection happens. */
  skills?: readonly string[] | undefined;
  /** Absolute path to the bundled catalog; required when `skills` is non-empty. */
  bundledSkillsRoot?: string | undefined;
  /** Optional absolute path to the workspace-specific override catalog. */
  workspaceOverrideRoot?: string | undefined;
}
```

- [ ] **Step 2: Import the injector**

Add to imports at the top of the file:

```ts
import { injectSkills } from "./skill-injector.js";
```

- [ ] **Step 3: Invoke the injector**

Inside `bootstrapWorkspace`, after the existing `mkdir` for `.grove` (around line 127) and **before** the final `chmod` loop, add:

```ts
// Inject skills (optional). Runs before chmod so the chmod pass covers
// injected files as well as existing config files.
if (opts.skills && opts.skills.length > 0) {
  if (!opts.bundledSkillsRoot) {
    throw new Error(
      "bootstrapWorkspace: `skills` non-empty requires `bundledSkillsRoot` — refusing to inject with no catalog.",
    );
  }
  await injectSkills({
    workspacePath: workspacePath,
    skills: opts.skills,
    bundledSkillsRoot: opts.bundledSkillsRoot,
    workspaceOverrideRoot: opts.workspaceOverrideRoot,
  });
}
```

Note: `injectSkills` already applies `0o444` to its own output, so the existing bootstrap `chmod` loop (which only touches `.mcp.json`, `.acpxrc.json`, `CLAUDE.md`, `CODEX.md`) does not need to change.

- [ ] **Step 4: Run the tests**

Run: `bun test src/core/workspace-bootstrap.test.ts`
Expected: PASS.

Run: `bun run typecheck`
Expected: PASS.

Run: `bun run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/workspace-bootstrap.ts
git commit -m "feat(bootstrap): invoke skill-injector when role declares skills"
```

---

## Task 8: Plumb skills from `SessionOrchestrator`

**Files:**
- Modify: `src/core/session-orchestrator.ts`

`SessionOrchestrator.bootstrapWorkspace` call at line 465 needs the three new options. The bundled catalog lives at the grove repo root; the session orchestrator already has `this.config.projectRoot`.

- [ ] **Step 1: Locate the grove install root**

The orchestrator does not currently know where the grove install lives — it receives `projectRoot` (the user's project), not the grove binary location. Mirror how `resolveMcpServePath(this.config.projectRoot)` works today: add a sibling helper next to it or reuse its logic.

Search for `resolveMcpServePath` to find the existing helper:

Run: `bun run -- grep -rn resolveMcpServePath src/core/`

Open the file that defines it and add `resolveBundledSkillsRoot` with the same resolution strategy (look up from the grove install, not the user's projectRoot). A minimal implementation:

```ts
export function resolveBundledSkillsRoot(): string {
  // grove install root = two levels up from this compiled file (dist/core/...).
  // In dev it resolves from src/core/... — the `skills/` dir sits at the repo root.
  const here = new URL(import.meta.url).pathname;
  // walk up until we find a sibling `skills/` or package.json matching name grove
  // Simplest: compute relative to import.meta.url.
  // For bun ESM: dist/core/session-orchestrator.js → ../../skills
  return join(here, "..", "..", "..", "skills");
}
```

Inspect the existing `resolveMcpServePath` to match style; if it uses a different discovery mechanism (e.g., package root lookup), use the same one.

- [ ] **Step 2: Pass skills + catalog paths to bootstrap**

Modify the `bootstrapWorkspace` call in `session-orchestrator.ts` (around line 465):

```ts
await bootstrapWorkspace({
  workspacePath: provisioned.path,
  roleId: role.name,
  goal: this.config.goal,
  rolePrompt: role.prompt,
  roleDescription: role.description,
  groveDir: join(this.config.projectRoot, ".grove"),
  mcpServePath: resolveMcpServePath(this.config.projectRoot),
  nexusUrl: process.env.GROVE_NEXUS_URL,
  nexusApiKey: process.env.NEXUS_API_KEY,
  skills: role.skills,
  bundledSkillsRoot: resolveBundledSkillsRoot(),
  workspaceOverrideRoot: join(this.config.projectRoot, ".grove", "skills"),
});
```

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 4: Run full orchestrator tests**

Run: `bun test src/core/session-orchestrator.test.ts`
Expected: PASS. (Existing tests do not declare `skills` on roles, so orchestrator behavior is unchanged for them.)

- [ ] **Step 5: Commit**

```bash
git add src/core/session-orchestrator.ts <resolver-file-if-new>
git commit -m "feat(orchestrator): pass role.skills + catalog paths to bootstrap"
```

---

## Task 9: Plumb skills from `SpawnManager` (TUI path)

**Files:**
- Modify: `src/tui/spawn-manager.ts`

`SpawnManager` does not call the shared `bootstrapWorkspace`; it has its own inline `writeMcpConfig` / `writeAgentInstructions` block around lines 290–313. Add a direct `injectSkills` call in the same block.

- [ ] **Step 1: Import the injector and resolver**

At the top of `src/tui/spawn-manager.ts`, add:

```ts
import { injectSkills } from "../core/skill-injector.js";
import { resolveBundledSkillsRoot } from "../core/session-orchestrator.js"; // or wherever it ended up
```

- [ ] **Step 2: Invoke the injector**

Inside the `if (provisioned !== undefined)` block (around line 293), after `writeAgentInstructions` / `writeAgentContext` and **before** the existing `chmod` loop (line 301), add:

```ts
const roleSkills = context?.skills;
if (roleSkills && roleSkills.length > 0) {
  await injectSkills({
    workspacePath: workspacePath,
    skills: roleSkills,
    bundledSkillsRoot: resolveBundledSkillsRoot(),
    workspaceOverrideRoot: join(this.projectRoot ?? process.cwd(), ".grove", "skills"),
  });
}
```

Follow the existing field-access pattern for `context` (search for `context?.rolePrompt` in the same file to confirm `context` shape). If `context` does not yet carry `skills`, extend its interface — mirror the `rolePrompt` / `roleDescription` fields.

- [ ] **Step 3: Surface `skills` through the TUI spawn context plumbing**

Search for the type that populates `context`:

Run: `bun run -- grep -n "rolePrompt:" src/tui/spawn-manager.ts`

Locate the caller(s) that build the context object and thread `skills: role.skills` through alongside `rolePrompt` / `roleDescription`. These will be in the TUI code that maps an `AgentRole` to the spawn-manager call.

- [ ] **Step 4: Typecheck and lint**

Run: `bun run typecheck`
Expected: PASS.

Run: `bun run check`
Expected: PASS.

- [ ] **Step 5: Run TUI tests**

Run: `bun test src/tui/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/tui/spawn-manager.ts
git commit -m "feat(tui): inject skills when role declares them in spawn context"
```

---

## Task 10: Refactor `grove skill install` to read from the on-disk catalog (red → green)

**Files:**
- Modify: `src/cli/commands/skill.ts`
- Modify: `src/cli/commands/skill.test.ts`
- Delete: `src/cli/commands/skill-template.ts`

- [ ] **Step 1: Rewrite `src/cli/commands/skill.test.ts`**

Replace the existing file with the version below — drop `renderSkillTemplate` references, assert the install copies the on-disk `skills/grove/SKILL.md`.

```ts
/**
 * Tests for the `grove skill install` command.
 *
 * Uses temp directories; points the install at a temp catalog root.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleSkillInstall, type SkillTarget } from "./skill.js";

let tempDir: string;
let catalogRoot: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "grove-skill-test-"));
  catalogRoot = join(tempDir, "skills");
  mkdirSync(join(catalogRoot, "grove"), { recursive: true });
  writeFileSync(join(catalogRoot, "grove", "SKILL.md"), "CATALOG_CONTENT\n", "utf-8");
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("handleSkillInstall", () => {
  it("copies SKILL.md from the on-disk catalog to each target", async () => {
    const target = join(tempDir, "out/grove");
    await handleSkillInstall({
      targets: [{ platform: "test", path: target }],
      catalogRoot,
    });

    expect(readFileSync(join(target, "SKILL.md"), "utf-8")).toBe("CATALOG_CONTENT\n");
  });

  it("writes to multiple targets", async () => {
    const t1 = join(tempDir, "out/a");
    const t2 = join(tempDir, "out/b");
    await handleSkillInstall({
      targets: [
        { platform: "a", path: t1 },
        { platform: "b", path: t2 },
      ],
      catalogRoot,
    });

    expect(existsSync(join(t1, "SKILL.md"))).toBe(true);
    expect(existsSync(join(t2, "SKILL.md"))).toBe(true);
  });

  it("throws when catalog does not contain the grove skill", async () => {
    const emptyCatalog = join(tempDir, "empty");
    mkdirSync(emptyCatalog, { recursive: true });
    await expect(
      handleSkillInstall({
        targets: [{ platform: "t", path: join(tempDir, "out") }],
        catalogRoot: emptyCatalog,
      }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/cli/commands/skill.test.ts`
Expected: FAIL — current `handleSkillInstall` has no `catalogRoot` option and still calls `renderSkillTemplate`.

- [ ] **Step 3: Rewrite `src/cli/commands/skill.ts`**

Replace the file with:

```ts
/**
 * `grove skill install` command — install SKILL.md into AI assistant skill directories.
 *
 * Reads the skill content from the on-disk bundled catalog (default: `skills/`
 * at the grove install root) and writes it to each configured target directory.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SkillTarget {
  platform: string;
  path: string;
}

export interface SkillInstallArgs {
  targets?: readonly SkillTarget[] | undefined;
  /** Absolute path to the bundled catalog root (defaults to the grove install's `skills/`). */
  catalogRoot?: string | undefined;
}

const DEFAULT_SKILL_TARGETS: SkillTarget[] = [
  { platform: "claude-code", path: "~/.claude/skills/grove" },
  { platform: "codex", path: "~/.codex/skills/grove" },
];

function resolvePath(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    return join(homedir(), p.slice(1));
  }
  return p;
}

function defaultCatalogRoot(): string {
  const here = new URL(import.meta.url).pathname;
  // src/cli/commands/skill.ts (dev) OR dist/cli/commands/skill.js (build)
  // → walk up to the install root and append `skills/`.
  return join(here, "..", "..", "..", "..", "skills");
}

export async function handleSkillInstall(args: SkillInstallArgs): Promise<void> {
  const targets = args.targets ?? DEFAULT_SKILL_TARGETS;
  const catalogRoot = args.catalogRoot ?? defaultCatalogRoot();
  const sourcePath = join(catalogRoot, "grove", "SKILL.md");

  let content: string;
  try {
    content = await readFile(sourcePath, "utf-8");
  } catch (err) {
    throw new Error(
      `Cannot read bundled skill at ${sourcePath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const written: string[] = [];
  for (const target of targets) {
    const dir = resolvePath(target.path);
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, "SKILL.md");
    await writeFile(filePath, content, "utf-8");
    written.push(filePath);
    console.log(`  ${target.platform}: ${filePath}`);
  }

  console.log(`\nInstalled SKILL.md to ${written.length} target(s).`);
}

export async function handleSkill(args: readonly string[]): Promise<void> {
  const subcommand = args[0];
  if (subcommand !== "install") {
    throw new Error(
      subcommand
        ? `Unknown skill subcommand '${subcommand}'. Available: install`
        : "Missing subcommand. Usage: grove skill install",
    );
  }
  await handleSkillInstall({});
}
```

- [ ] **Step 4: Delete `skill-template.ts`**

Run: `git rm src/cli/commands/skill-template.ts`

- [ ] **Step 5: Update `src/cli/main.ts` help text if needed**

Confirm `src/cli/main.ts:363` (the skill command registration) and `src/cli/main.ts:538` (the help text) do not import or reference `skill-template.ts`. Remove any references to `--server-url` / `--mcp-url` flags there since they no longer exist.

Run: `grep -n "server-url\|mcp-url\|renderSkillTemplate\|skill-template" src/`
Expected: no matches after edits.

- [ ] **Step 6: Run tests**

Run: `bun test src/cli/commands/skill.test.ts`
Expected: PASS.

Run: `bun run typecheck`
Expected: PASS.

Run: `bun run check`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/cli/commands/skill.ts src/cli/commands/skill.test.ts src/cli/main.ts
git commit -m "refactor(skill-install): load SKILL.md from on-disk catalog, drop template module"
```

---

## Task 11: Integration test — spawned agent sees native skill paths

**Files:**
- Modify: `src/core/acpx-runtime.integration.test.ts`

The existing integration test spawns an agent via `AcpxRuntime` and exercises the full path. Add a variant that declares `skills: ["grove"]` on the role and asserts the spawned workspace contains the native skill files. If the integration suite does not yet construct the workspace via bootstrap (it may stub that), instead extend the full orchestrator integration test that does.

- [ ] **Step 1: Locate the integration test that exercises bootstrap + spawn end-to-end**

Run: `bun run -- grep -rn "bootstrapWorkspace\|orchestrator.*spawn\|injectSkills" src/**/*.test.ts`

Pick the test that already orchestrates workspace creation + spawn. If none exists at the orchestrator level, add the assertion to `src/core/workspace-bootstrap.test.ts` via a test that calls `bootstrapWorkspace` with the real bundled catalog resolved from the repo:

```ts
test("bundled grove catalog resolves via default root in repo", async () => {
  // Resolve the repo-root skills/ dir via import.meta.url, same trick as production.
  const here = new URL(import.meta.url).pathname;
  const repoSkills = join(here, "..", "..", "..", "skills");

  await bootstrapWorkspace({
    workspacePath: workspaceDir,
    roleId: "coder",
    goal: "Build",
    skills: ["grove"],
    bundledSkillsRoot: repoSkills,
  });

  const claudePath = join(workspaceDir, ".claude/skills/grove/SKILL.md");
  const content = readFileSync(claudePath, "utf-8");
  expect(content).toContain("name: grove");
  expect(content).toContain("grove_submit_work");
});
```

- [ ] **Step 2: Run the test**

Run: `bun test src/core/workspace-bootstrap.test.ts -t "bundled grove catalog"`
Expected: PASS.

- [ ] **Step 3: Run the full suite**

Run: `bun test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/core/workspace-bootstrap.test.ts
git commit -m "test(bootstrap): integration — bundled grove catalog resolves at workspace bootstrap"
```

---

## Task 12: Final verification + close the loop

- [ ] **Step 1: Run the complete suite once more**

Run: `bun test`
Expected: PASS.

Run: `bun run typecheck`
Expected: PASS.

Run: `bun run check`
Expected: PASS.

- [ ] **Step 2: Smoke-test `grove skill install` end-to-end**

Run: `bun run src/cli/main.ts skill install` — in a tmp dir with `HOME` pointed there, e.g.

```bash
mktemp -d | xargs -I{} env HOME={} bun run src/cli/main.ts skill install
```

Expected: stdout shows two target writes; the resulting `$HOME/.claude/skills/grove/SKILL.md` is byte-equal to `skills/grove/SKILL.md`.

- [ ] **Step 3: Close issue reference**

Confirm the PR description cites `#262` and references `#202` as the parent epic. No code changes in this step.

---

## Self-Review Notes

Spec coverage (each section of `2026-04-20-native-skill-injection-design.md` maps to tasks below):

| Spec section | Tasks |
|---|---|
| Architecture (two-layer source, two-target writes) | 4, 5 |
| Catalog shape (`skills/{name}/SKILL.md` + siblings) | 1, 4, 5 |
| Role → skill wiring (topology `skills`) | 2, 3 |
| Components: `skill-injector.ts` | 4, 5 |
| Components: `workspace-bootstrap.ts` | 6, 7 |
| Components: `grove skill install` refactor | 10 |
| Components: bundled catalog | 1 |
| Data flow (bootstrap → injector → native paths) | 7, 8, 9 |
| Error handling (unknown skill, missing SKILL.md, override wins, overwrite, empty skills) | 4 (tests), 5 (impl) |
| `grove skill install` disposition | 10 |
| Testing (unit + integration) | 4, 6, 11 |

No placeholders. No "TBD". Method names are consistent (`injectSkills`, `SkillResolutionError`, `SkillInjectionOptions`, `InjectionReport`, `resolveBundledSkillsRoot`). Type shapes match across spec and plan.
