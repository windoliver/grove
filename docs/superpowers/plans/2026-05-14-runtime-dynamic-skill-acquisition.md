# Runtime Dynamic Skill Acquisition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a stdio MCP `grove_request_skill` tool that lets an active Grove agent request an allowlisted skill, install it into the live workspace, return bounded `SKILL.md` content, and persist the acquired skill into session role state.

**Architecture:** Add runtime skill policy to `grove.json`, a narrow session-store append capability, a core runtime skill acquisition service, and an MCP tool wrapper. Reuse existing Nexus/local skill resolution and `injectSkills()` for final filesystem writes. Register the mutation tool only on stdio MCP; HTTP MCP omits it.

**Tech Stack:** Bun 1.3.x, TypeScript strict mode, `bun:test`, Zod, MCP SDK, SQLite via `bun:sqlite`, existing Nexus VFS client.

---

## Execution Notes

This repo's `bunfig.toml` enables coverage thresholds globally. For targeted
TDD commands in this plan, run the listed `bun test ...` command from outside
the repo with a temporary config and an absolute test path so a focused file
set can return a useful red/green exit code:

```bash
tmp=$(mktemp)
printf '[test]\ncoverage = false\n' > "$tmp"
cd /tmp
PATH="$HOME/.bun/bin:$PATH" bun test -c "$tmp" /absolute/path/to/test-file.test.ts
rc=$?
rm -f "$tmp"
exit "$rc"
```

For `bun run typecheck`, `bun run check`, `bun run build`, and full `bun test`,
use the repository config as written.

## File Structure

- `src/core/config.ts` owns `runtimeSkills` schema parsing and serialization.
- `src/core/config.test.ts` covers valid config, defaults, invalid modes, unsafe skill names, and round trips.
- `src/core/session.ts` exports a dedicated `RuntimeSkillSessionStore` capability and updates the `Session.topology` comment.
- `src/core/in-memory-session-store.ts` implements the append capability for tests.
- `src/core/session-store.conformance.ts` adds conformance tests for stores that implement `RuntimeSkillSessionStore`.
- `src/local/sqlite-goal-session-store.ts` implements the append capability with a SQLite transaction.
- `src/nexus/nexus-session-store.ts` implements the append capability with ETag conflict retry.
- `src/core/runtime-skill-acquisition.ts` contains service types, errors, validation, authorization, resolver orchestration, injection, bounded skill content, persistence, and optional acquisition notification.
- `src/core/runtime-skill-acquisition.test.ts` exercises the service with fake dependencies and temp workspaces.
- `src/mcp/tools/runtime-skills.ts` registers `grove_request_skill` and maps service errors to MCP tool results.
- `src/mcp/tools/runtime-skills.test.ts` tests MCP handler behavior and trusted caller binding.
- `src/mcp/deps.ts` carries the optional runtime skill service.
- `src/mcp/server.ts` registers runtime skill tools only for `preset.transport !== "http"`.
- `src/mcp/server.test.ts` covers stdio registration and HTTP omission.
- `src/mcp/serve.ts` constructs the runtime skill service for stdio MCP.
- `src/mcp/serve-http.ts` needs no runtime service wiring; server preset keeps the tool omitted on HTTP.

## Task 1: Runtime Skills Config Schema

**Files:**
- Modify: `src/core/config.ts`
- Modify: `src/core/config.test.ts`

- [ ] **Step 1: Add failing config tests**

Append these tests inside `describe("parseGroveConfig", ...)` in `src/core/config.test.ts`:

```ts
  test("parses runtime skill allowlist config", () => {
    const config = parseGroveConfig(
      JSON.stringify({
        name: "swarm",
        mode: "local",
        runtimeSkills: {
          mode: "role-allowlist",
          roles: {
            coder: ["grove", "review"],
            reviewer: ["grove"],
          },
          returnSkillMdMaxBytes: 32768,
        },
      }),
    );

    expect(config.runtimeSkills?.mode).toBe("role-allowlist");
    expect(config.runtimeSkills?.roles.coder).toEqual(["grove", "review"]);
    expect(config.runtimeSkills?.roles.reviewer).toEqual(["grove"]);
    expect(config.runtimeSkills?.returnSkillMdMaxBytes).toBe(32768);
  });

  test("defaults runtime skill content byte limit", () => {
    const config = parseGroveConfig(
      JSON.stringify({
        name: "swarm",
        runtimeSkills: {
          mode: "role-allowlist",
          roles: { coder: ["grove"] },
        },
      }),
    );

    expect(config.runtimeSkills?.returnSkillMdMaxBytes).toBe(65536);
  });
```

Append these tests inside `describe("parseGroveConfig errors", ...)`:

```ts
  test("rejects unknown runtime skills mode", () => {
    expect(() =>
      parseGroveConfig(
        JSON.stringify({
          name: "x",
          runtimeSkills: { mode: "approval", roles: { coder: ["grove"] } },
        }),
      ),
    ).toThrow("Invalid grove.json");
  });

  test("rejects unsafe runtime skill names", () => {
    for (const skillName of ["", ".", "..", "nested/name", "nested\\name", "bad\u0000name"]) {
      expect(() =>
        parseGroveConfig(
          JSON.stringify({
            name: "x",
            runtimeSkills: { mode: "role-allowlist", roles: { coder: [skillName] } },
          }),
        ),
      ).toThrow("Invalid grove.json");
    }
  });

  test("rejects empty runtime skill role names", () => {
    expect(() =>
      parseGroveConfig(
        JSON.stringify({
          name: "x",
          runtimeSkills: { mode: "role-allowlist", roles: { "": ["grove"] } },
        }),
      ),
    ).toThrow("Invalid grove.json");
  });

  test("rejects oversized runtime skill return limit", () => {
    expect(() =>
      parseGroveConfig(
        JSON.stringify({
          name: "x",
          runtimeSkills: {
            mode: "role-allowlist",
            roles: { coder: ["grove"] },
            returnSkillMdMaxBytes: 262145,
          },
        }),
      ),
    ).toThrow("Invalid grove.json");
  });
```

Append this test inside `describe("writeGroveConfig", ...)`:

```ts
  test("round-trips runtime skill config", () => {
    const original: GroveConfig = {
      name: "runtime-skills",
      mode: "local",
      runtimeSkills: {
        mode: "role-allowlist",
        roles: {
          coder: ["grove", "review"],
        },
        returnSkillMdMaxBytes: 4096,
      },
    };
    writeGroveConfig(original, tmpPath);

    const parsed = parseGroveConfig(readFileSync(tmpPath, "utf-8"));

    expect(parsed.runtimeSkills).toEqual(original.runtimeSkills);
  });
```

- [ ] **Step 2: Run config tests and verify failure**

Run: `bun test src/core/config.test.ts`

Expected: FAIL because `runtimeSkills` is rejected as an unknown field and `GroveConfig` has no `runtimeSkills` property.

- [ ] **Step 3: Implement config schema**

In `src/core/config.ts`, add these exported types after `SkillCatalogConfig`:

```ts
export type RuntimeSkillsMode = "role-allowlist";

export interface RuntimeSkillsConfig {
  readonly mode: RuntimeSkillsMode;
  readonly roles: Readonly<Record<string, readonly string[]>>;
  readonly returnSkillMdMaxBytes: number;
}
```

Add the field to `GroveConfig`:

```ts
  readonly runtimeSkills?: RuntimeSkillsConfig | undefined;
```

Add constants and schemas near the existing skill catalog schemas:

```ts
const SAFE_SKILL_NAME_PATTERN = /^[^/\\\0]+$/;

function isSafeSkillName(value: string): boolean {
  return (
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    SAFE_SKILL_NAME_PATTERN.test(value)
  );
}

const RuntimeSkillsModeSchema = z.literal("role-allowlist");

const RuntimeSkillNameSchema = z
  .string()
  .min(1)
  .max(128)
  .refine(isSafeSkillName, "skill name must be a safe path segment");

const RuntimeSkillsConfigSchema: z.ZodType<RuntimeSkillsConfig> = z
  .object({
    mode: RuntimeSkillsModeSchema,
    roles: z
      .record(
        z.string().min(1).max(128),
        z.array(RuntimeSkillNameSchema).max(100),
      )
      .default({}),
    returnSkillMdMaxBytes: z.number().int().min(1).max(262_144).default(65_536),
  })
  .strict();
```

Add `runtimeSkills: RuntimeSkillsConfigSchema.optional(),` to `GroveConfigSchema`.

In `writeGroveConfig`, add:

```ts
  if (config.runtimeSkills !== undefined) obj.runtimeSkills = config.runtimeSkills;
```

- [ ] **Step 4: Run config tests and verify pass**

Run: `bun test src/core/config.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/config.ts src/core/config.test.ts
git commit -m "feat(skills): add runtime skill policy config"
```

## Task 2: Session Skill Append Capability

**Files:**
- Modify: `src/core/session.ts`
- Modify: `src/core/in-memory-session-store.ts`
- Modify: `src/core/session-store.conformance.ts`

- [ ] **Step 1: Add failing conformance tests**

In `src/core/session-store.conformance.ts`, update the import:

```ts
import type { RuntimeSkillSessionStore, SessionStore } from "./session.js";
```

Add this type guard near the fixture:

```ts
function hasRuntimeSkillCapability(store: SessionStore): store is SessionStore & RuntimeSkillSessionStore {
  return (
    typeof (store as unknown as { appendSessionRoleSkill?: unknown }).appendSessionRoleSkill ===
    "function"
  );
}
```

Append these tests inside the conformance `describe` block:

```ts
    test("appendSessionRoleSkill appends and dedupes role skills", async () => {
      if (!hasRuntimeSkillCapability(store)) return;
      const session = await store.createSession({
        goal: "runtime skill",
        topology: {
          structure: "flat",
          roles: [{ name: "coder", skills: ["grove"] }, { name: "reviewer" }],
        },
      });

      await expect(store.appendSessionRoleSkill(session.id, "coder", "review")).resolves.toBe(
        "appended",
      );
      await expect(store.appendSessionRoleSkill(session.id, "coder", "review")).resolves.toBe(
        "already_present",
      );

      const fetched = await store.getSession(session.id);
      expect(fetched?.topology?.roles[0]?.skills).toEqual(["grove", "review"]);
      expect(fetched?.topology?.roles[1]?.skills).toBeUndefined();
    });

    test("appendSessionRoleSkill reports missing session and missing role", async () => {
      if (!hasRuntimeSkillCapability(store)) return;
      await expect(
        store.appendSessionRoleSkill("missing-session", "coder", "review"),
      ).resolves.toBe("session_missing");

      const session = await store.createSession({
        goal: "runtime skill missing role",
        topology: SAMPLE_TOPOLOGY,
      });
      await expect(store.appendSessionRoleSkill(session.id, "reviewer", "review")).resolves.toBe(
        "role_missing",
      );
    });
```

- [ ] **Step 2: Run in-memory conformance and verify failure**

Run: `bun test src/core/in-memory-session-store.test.ts`

Expected: FAIL because `RuntimeSkillSessionStore` and `appendSessionRoleSkill` do not exist.

- [ ] **Step 3: Add core interface**

In `src/core/session.ts`, update the topology comment:

```ts
  /**
   * Resolved effective topology at session creation time.
   * Runtime skill acquisition may append an authorized skill to a role's
   * `skills` list; all other topology fields remain immutable after creation.
   */
  readonly topology?: AgentTopology | undefined;
```

Add this exported type and interface after `SessionStore`:

```ts
export type AppendSessionRoleSkillResult =
  | "appended"
  | "already_present"
  | "session_missing"
  | "role_missing";

export interface RuntimeSkillSessionStore {
  appendSessionRoleSkill(
    sessionId: string,
    roleName: string,
    skillName: string,
  ): Promise<AppendSessionRoleSkillResult>;
}
```

- [ ] **Step 4: Implement in-memory append capability**

In `src/core/in-memory-session-store.ts`, add imports:

```ts
import type {
  AppendSessionRoleSkillResult,
  CreateSessionInput,
  RuntimeSkillSessionStore,
  Session,
  SessionDeleteBlocker,
  SessionDeleteOptions,
  SessionDeleteResult,
  SessionQuery,
  SessionStore,
} from "./session.js";
```

Change the class declaration:

```ts
export class InMemorySessionStore implements SessionStore, RuntimeSkillSessionStore {
```

Add this method before `archiveSession`:

```ts
  async appendSessionRoleSkill(
    sessionId: string,
    roleName: string,
    skillName: string,
  ): Promise<AppendSessionRoleSkillResult> {
    const idx = this.sessions.findIndex((s) => s.id === sessionId);
    if (idx === -1) return "session_missing";
    const existing = this.sessions[idx];
    if (!existing?.topology) return "role_missing";

    let changed = false;
    let foundRole = false;
    const nextRoles = existing.topology.roles.map((role) => {
      if (role.name !== roleName) return { ...role };
      foundRole = true;
      const currentSkills = role.skills ?? [];
      if (currentSkills.includes(skillName)) return { ...role };
      changed = true;
      return { ...role, skills: [...currentSkills, skillName] };
    });

    if (!foundRole) return "role_missing";
    if (!changed) return "already_present";

    this.sessions[idx] = {
      ...existing,
      topology: {
        ...existing.topology,
        roles: nextRoles,
      },
    };
    return "appended";
  }
```

- [ ] **Step 5: Run in-memory conformance and verify pass**

Run: `bun test src/core/in-memory-session-store.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/session.ts src/core/in-memory-session-store.ts src/core/session-store.conformance.ts
git commit -m "feat(skills): add session role skill append capability"
```

## Task 3: SQLite Session Persistence

**Files:**
- Modify: `src/local/sqlite-goal-session-store.ts`
- Modify: `src/local/sqlite-goal-session-store.test.ts`

- [ ] **Step 1: Run SQLite store tests and verify failure**

Run: `bun test src/local/sqlite-goal-session-store.test.ts`

Expected: FAIL in the new conformance tests because `SqliteGoalSessionStore` does not implement `appendSessionRoleSkill`.

- [ ] **Step 2: Implement SQLite append capability**

In `src/local/sqlite-goal-session-store.ts`, extend the session import:

```ts
import type {
  AppendSessionRoleSkillResult,
  CreateSessionInput,
  RuntimeSkillSessionStore,
  Session,
  SessionDeleteBlocker,
  SessionDeleteOptions,
  SessionDeleteResult,
  SessionQuery,
} from "../core/session.js";
```

Change the class declaration to implement `RuntimeSkillSessionStore`.

Add this method near `updateSession`:

```ts
  appendSessionRoleSkill = async (
    sessionId: string,
    roleName: string,
    skillName: string,
  ): Promise<AppendSessionRoleSkillResult> => {
    const tx = this.db.transaction((): AppendSessionRoleSkillResult => {
      const row = this.db
        .prepare("SELECT topology_json FROM sessions WHERE session_id = ?")
        .get(sessionId) as { topology_json: string | null } | undefined;
      if (row === undefined) return "session_missing";
      if (row.topology_json === null) return "role_missing";

      const topology = JSON.parse(row.topology_json) as AgentTopology;
      let foundRole = false;
      let changed = false;
      const roles = topology.roles.map((role) => {
        if (role.name !== roleName) return { ...role };
        foundRole = true;
        const currentSkills = role.skills ?? [];
        if (currentSkills.includes(skillName)) return { ...role };
        changed = true;
        return { ...role, skills: [...currentSkills, skillName] };
      });

      if (!foundRole) return "role_missing";
      if (!changed) return "already_present";

      this.db
        .prepare("UPDATE sessions SET topology_json = ? WHERE session_id = ?")
        .run(JSON.stringify({ ...topology, roles }), sessionId);
      return "appended";
    });

    return tx();
  };
```

- [ ] **Step 3: Run SQLite tests and verify pass**

Run: `bun test src/local/sqlite-goal-session-store.test.ts`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/local/sqlite-goal-session-store.ts src/local/sqlite-goal-session-store.test.ts
git commit -m "feat(skills): persist runtime skills in sqlite sessions"
```

## Task 4: Nexus Session Persistence

**Files:**
- Modify: `src/nexus/nexus-session-store.ts`
- Modify: `src/nexus/nexus-session-store.test.ts`

- [ ] **Step 1: Add focused Nexus tests**

Append these tests in `src/nexus/nexus-session-store.test.ts`:

```ts
  test("appendSessionRoleSkill updates persisted topology and dedupes", async () => {
    const store = new NexusSessionStore(client, "test-zone");
    const session = await store.createSession({
      goal: "runtime skill",
      topology: {
        structure: "flat",
        roles: [{ name: "coder", skills: ["grove"] }],
      },
    });

    await expect(store.appendSessionRoleSkill(session.id, "coder", "review")).resolves.toBe(
      "appended",
    );
    await expect(store.appendSessionRoleSkill(session.id, "coder", "review")).resolves.toBe(
      "already_present",
    );

    const fetched = await store.getSession(session.id);
    expect(fetched?.topology?.roles[0]?.skills).toEqual(["grove", "review"]);
  });

  test("appendSessionRoleSkill reports missing session and role", async () => {
    const store = new NexusSessionStore(client, "test-zone");
    await expect(store.appendSessionRoleSkill("missing", "coder", "review")).resolves.toBe(
      "session_missing",
    );

    const session = await store.createSession({
      goal: "runtime skill",
      topology: { structure: "flat", roles: [{ name: "coder" }] },
    });
    await expect(store.appendSessionRoleSkill(session.id, "reviewer", "review")).resolves.toBe(
      "role_missing",
    );
  });
```

- [ ] **Step 2: Run Nexus session tests and verify failure**

Run: `bun test src/nexus/nexus-session-store.test.ts`

Expected: FAIL because `appendSessionRoleSkill` is missing.

- [ ] **Step 3: Implement Nexus append capability**

In `src/nexus/nexus-session-store.ts`, import `AppendSessionRoleSkillResult` and `RuntimeSkillSessionStore` from `../core/session.js`, then make the class implement `RuntimeSkillSessionStore`.

Add this method near `updateSession`:

```ts
  async appendSessionRoleSkill(
    id: string,
    roleName: string,
    skillName: string,
  ): Promise<AppendSessionRoleSkillResult> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const loaded = await this.readPersistedSessionRecordWithEtag(id);
      if (loaded === undefined) return "session_missing";
      const existing = this.normalizeSessionRecord(loaded.persisted).session;
      if (existing.topology === undefined) return "role_missing";

      let foundRole = false;
      let changed = false;
      const roles = existing.topology.roles.map((role) => {
        if (role.name !== roleName) return { ...role };
        foundRole = true;
        const currentSkills = role.skills ?? [];
        if (currentSkills.includes(skillName)) return { ...role };
        changed = true;
        return { ...role, skills: [...currentSkills, skillName] };
      });

      if (!foundRole) return "role_missing";
      if (!changed) return "already_present";

      try {
        await this.writeSessionRecord(
          {
            ...existing,
            topology: {
              ...existing.topology,
              roles,
            },
          },
          { ifMatch: loaded.etag },
        );
        return "appended";
      } catch (error) {
        if (!isCasConflict(error) || attempt === 2) throw error;
      }
    }

    throw new Error("appendSessionRoleSkill retry loop exhausted");
  }
```

- [ ] **Step 4: Run Nexus session tests and verify pass**

Run: `bun test src/nexus/nexus-session-store.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/nexus/nexus-session-store.ts src/nexus/nexus-session-store.test.ts
git commit -m "feat(skills): persist runtime skills in nexus sessions"
```

## Task 5: Core Runtime Skill Acquisition Service

**Files:**
- Create: `src/core/runtime-skill-acquisition.ts`
- Create: `src/core/runtime-skill-acquisition.test.ts`

- [ ] **Step 1: Write failing core service tests**

Create `src/core/runtime-skill-acquisition.test.ts` with temp workspace helpers and these tests:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeSkillsConfig } from "./config.js";
import {
  DefaultRuntimeSkillAcquisitionService,
  RuntimeSkillAcquisitionError,
} from "./runtime-skill-acquisition.js";
import type { RuntimeSkillSessionStore } from "./session.js";

let root: string;
let workspace: string;
let catalogRoot: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "grove-runtime-skills-"));
  workspace = join(root, "workspace");
  catalogRoot = join(root, "catalog");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(join(catalogRoot, "review"), { recursive: true });
  writeFileSync(join(catalogRoot, "review", "SKILL.md"), "review skill", "utf-8");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function config(overrides: Partial<RuntimeSkillsConfig> = {}): RuntimeSkillsConfig {
  return {
    mode: "role-allowlist",
    roles: { coder: ["review"] },
    returnSkillMdMaxBytes: 65536,
    ...overrides,
  };
}

function service(opts: {
  runtimeSkills?: RuntimeSkillsConfig | undefined;
  sessionStore?: RuntimeSkillSessionStore | undefined;
} = {}): DefaultRuntimeSkillAcquisitionService {
  return new DefaultRuntimeSkillAcquisitionService({
    readRuntimeSkillsConfig: async () => opts.runtimeSkills,
    resolveSkillRoot: async () => ({ root: catalogRoot, source: "bundled", warnings: [] }),
    bundledSkillsRoot: catalogRoot,
    sessionStore: opts.sessionStore,
  });
}

describe("DefaultRuntimeSkillAcquisitionService", () => {
  test("denies when runtime skills are not configured", async () => {
    await expect(
      service().requestSkill({
        skillName: "review",
        caller: { role: "coder", workspacePath: workspace, sessionId: "s1" },
      }),
    ).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
  });

  test("denies skills not allowlisted for role", async () => {
    await expect(
      service({ runtimeSkills: config() }).requestSkill({
        skillName: "grove",
        caller: { role: "coder", workspacePath: workspace, sessionId: "s1" },
      }),
    ).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
  });

  test("rejects unsafe skill names before resolver call", async () => {
    await expect(
      service({ runtimeSkills: config() }).requestSkill({
        skillName: "../review",
        caller: { role: "coder", workspacePath: workspace, sessionId: "s1" },
      }),
    ).rejects.toMatchObject({ code: "INVALID_SKILL_NAME" });
  });

  test("installs skill, returns content, and persists session role skill", async () => {
    const calls: Array<[string, string, string]> = [];
    const sessionStore: RuntimeSkillSessionStore = {
      appendSessionRoleSkill: async (sessionId, roleName, skillName) => {
        calls.push([sessionId, roleName, skillName]);
        return "appended";
      },
    };

    const result = await service({ runtimeSkills: config(), sessionStore }).requestSkill({
      skillName: "review",
      reason: "Need review instructions",
      caller: { role: "coder", agentId: "agent-1", workspacePath: workspace, sessionId: "s1" },
    });

    expect(result.status).toBe("installed");
    expect(result.skill.skillMd).toBe("review skill");
    expect(result.sessionPersisted).toBe(true);
    expect(calls).toEqual([["s1", "coder", "review"]]);
    expect(readFileSync(join(workspace, ".codex/skills/review/SKILL.md"), "utf-8")).toBe(
      "review skill",
    );
  });

  test("truncates returned skill content by configured byte limit", async () => {
    writeFileSync(join(catalogRoot, "review", "SKILL.md"), "1234567890", "utf-8");

    const result = await service({
      runtimeSkills: config({ returnSkillMdMaxBytes: 4 }),
    }).requestSkill({
      skillName: "review",
      caller: { role: "coder", workspacePath: workspace },
    });

    expect(result.skill.skillMd).toBe("1234");
    expect(result.skill.truncated).toBe(true);
  });

  test("returns already_installed when both native targets exist", async () => {
    mkdirSync(join(workspace, ".codex", "skills", "review"), { recursive: true });
    mkdirSync(join(workspace, ".claude", "skills", "review"), { recursive: true });
    writeFileSync(join(workspace, ".codex", "skills", "review", "SKILL.md"), "installed", "utf-8");
    writeFileSync(
      join(workspace, ".claude", "skills", "review", "SKILL.md"),
      "installed",
      "utf-8",
    );

    const result = await service({ runtimeSkills: config() }).requestSkill({
      skillName: "review",
      caller: { role: "coder", workspacePath: workspace },
    });

    expect(result.status).toBe("already_installed");
    expect(result.skill.skillMd).toBe("installed");
  });

  test("reports retry-safe persistence failure after install", async () => {
    const sessionStore: RuntimeSkillSessionStore = {
      appendSessionRoleSkill: async () => "role_missing",
    };

    await expect(
      service({ runtimeSkills: config(), sessionStore }).requestSkill({
        skillName: "review",
        caller: { role: "coder", workspacePath: workspace, sessionId: "s1" },
      }),
    ).rejects.toMatchObject({
      code: "SESSION_PERSIST_FAILED",
      workspaceInstalled: true,
    });
  });
});
```

- [ ] **Step 2: Run service tests and verify failure**

Run: `bun test src/core/runtime-skill-acquisition.test.ts`

Expected: FAIL because `src/core/runtime-skill-acquisition.ts` does not exist.

- [ ] **Step 3: Implement service types and errors**

Create `src/core/runtime-skill-acquisition.ts` with these exported types:

```ts
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import type { RuntimeSkillsConfig } from "./config.js";
import { injectSkills, SkillResolutionError } from "./skill-injector.js";
import type { RuntimeSkillSessionStore } from "./session.js";

export type RuntimeSkillSource = "nexus" | "cache" | "local" | "override" | "bundled";
export type RuntimeSkillStatus = "installed" | "already_installed";
export type ProviderReloadStatus = "context-returned" | "reloaded" | "restart-required";

export type RuntimeSkillErrorCode =
  | "NOT_CONFIGURED"
  | "NOT_AUTHORIZED"
  | "INVALID_SKILL_NAME"
  | "WORKSPACE_UNAVAILABLE"
  | "NOT_FOUND"
  | "CATALOG_UNAVAILABLE"
  | "INTEGRITY_ERROR"
  | "INSTALL_FAILED"
  | "SESSION_PERSIST_FAILED";

export interface RuntimeSkillCaller {
  readonly role: string;
  readonly agentId?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly workspacePath: string;
}

export interface RuntimeSkillAcquisitionOptions {
  readonly skillName: string;
  readonly reason?: string | undefined;
  readonly caller: RuntimeSkillCaller;
}

export interface RuntimeSkillResolutionWarning {
  readonly skillName: string;
  readonly attemptedSource: string;
  readonly fallbackSource?: string | undefined;
  readonly reason: string;
}

export interface RuntimeSkillResolvedRoot {
  readonly root: string;
  readonly source: RuntimeSkillSource;
  readonly warnings: readonly RuntimeSkillResolutionWarning[];
}

export interface RuntimeSkillAcquisitionResult {
  readonly skillName: string;
  readonly status: RuntimeSkillStatus;
  readonly source: RuntimeSkillSource;
  readonly sessionPersisted: boolean;
  readonly providerReload: {
    readonly status: ProviderReloadStatus;
    readonly message: string;
  };
  readonly installedTargets: readonly string[];
  readonly skill: {
    readonly name: string;
    readonly skillMd: string;
    readonly truncated: boolean;
  };
  readonly warnings: readonly RuntimeSkillResolutionWarning[];
}

export class RuntimeSkillAcquisitionError extends Error {
  readonly code: RuntimeSkillErrorCode;
  readonly workspaceInstalled: boolean;
  readonly installedTargets: readonly string[];

  constructor(
    code: RuntimeSkillErrorCode,
    message: string,
    options?: {
      readonly cause?: unknown;
      readonly workspaceInstalled?: boolean;
      readonly installedTargets?: readonly string[];
    },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "RuntimeSkillAcquisitionError";
    this.code = code;
    this.workspaceInstalled = options?.workspaceInstalled ?? false;
    this.installedTargets = options?.installedTargets ?? [];
  }
}
```

- [ ] **Step 4: Implement service class**

Append this implementation in the same file:

```ts
export interface RuntimeSkillResolver {
  (skills: readonly string[]): Promise<RuntimeSkillResolvedRoot | undefined>;
}

export interface RuntimeSkillAcquisitionService {
  requestSkill(options: RuntimeSkillAcquisitionOptions): Promise<RuntimeSkillAcquisitionResult>;
}

export interface RuntimeSkillAcquisitionDeps {
  readonly readRuntimeSkillsConfig: () => Promise<RuntimeSkillsConfig | undefined>;
  readonly resolveSkillRoot?: RuntimeSkillResolver | undefined;
  readonly bundledSkillsRoot: string;
  readonly workspaceOverrideRoot?: string | undefined;
  readonly sessionStore?: RuntimeSkillSessionStore | undefined;
  readonly onAcquired?: ((result: RuntimeSkillAcquisitionResult) => void) | undefined;
}

function isSafeSkillName(value: string): boolean {
  return value.length > 0 && value !== "." && value !== ".." && !/[\/\\\0]/.test(value);
}

async function assertWorkspace(path: string): Promise<void> {
  try {
    const s = await stat(path);
    if (!s.isDirectory()) {
      throw new RuntimeSkillAcquisitionError(
        "WORKSPACE_UNAVAILABLE",
        `Runtime skill workspace is not a directory: ${path}`,
      );
    }
  } catch (error) {
    if (error instanceof RuntimeSkillAcquisitionError) throw error;
    throw new RuntimeSkillAcquisitionError(
      "WORKSPACE_UNAVAILABLE",
      `Runtime skill workspace is unavailable: ${path}`,
      { cause: error },
    );
  }
}

async function readBoundedText(path: string, maxBytes: number): Promise<{
  readonly text: string;
  readonly truncated: boolean;
}> {
  const bytes = await readFile(path);
  const truncated = bytes.byteLength > maxBytes;
  const slice = truncated ? bytes.subarray(0, maxBytes) : bytes;
  return { text: new TextDecoder().decode(slice), truncated };
}

export class DefaultRuntimeSkillAcquisitionService implements RuntimeSkillAcquisitionService {
  private readonly deps: RuntimeSkillAcquisitionDeps;

  constructor(deps: RuntimeSkillAcquisitionDeps) {
    this.deps = deps;
  }

  async requestSkill(
    options: RuntimeSkillAcquisitionOptions,
  ): Promise<RuntimeSkillAcquisitionResult> {
    const { skillName, caller } = options;
    if (!isSafeSkillName(skillName)) {
      throw new RuntimeSkillAcquisitionError(
        "INVALID_SKILL_NAME",
        `Invalid runtime skill name: ${skillName}`,
      );
    }
    await assertWorkspace(caller.workspacePath);

    const runtimeSkills = await this.deps.readRuntimeSkillsConfig();
    if (runtimeSkills === undefined) {
      throw new RuntimeSkillAcquisitionError(
        "NOT_CONFIGURED",
        "Runtime skill acquisition is not configured",
      );
    }
    const allowed = runtimeSkills.roles[caller.role] ?? [];
    if (!allowed.includes(skillName)) {
      throw new RuntimeSkillAcquisitionError(
        "NOT_AUTHORIZED",
        `Role '${caller.role}' is not authorized to request skill '${skillName}'`,
      );
    }

    const nativeTargets = [
      join(caller.workspacePath, ".claude", "skills", skillName),
      join(caller.workspacePath, ".codex", "skills", skillName),
    ];
    const alreadyInstalled = nativeTargets.every((target) => existsSync(join(target, "SKILL.md")));

    let resolved: RuntimeSkillResolvedRoot = {
      root: this.deps.bundledSkillsRoot,
      source: "bundled",
      warnings: [],
    };
    if (!alreadyInstalled && this.deps.resolveSkillRoot !== undefined) {
      resolved = (await this.deps.resolveSkillRoot([skillName])) ?? resolved;
    }

    let installedTargets = nativeTargets;
    let actualSource = resolved.source;
    try {
      if (!alreadyInstalled) {
        const report = await injectSkills({
          workspacePath: caller.workspacePath,
          skills: [skillName],
          bundledSkillsRoot: resolved.root,
          workspaceOverrideRoot: resolved.source === "bundled" ? this.deps.workspaceOverrideRoot : undefined,
        });
        installedTargets = report.injected[0]?.targets ?? installedTargets;
        const injectedSource = report.injected[0]?.source;
        if (injectedSource === "override" || injectedSource === "bundled") {
          actualSource = injectedSource;
        }
      }
    } catch (error) {
      if (error instanceof SkillResolutionError) {
        throw new RuntimeSkillAcquisitionError("NOT_FOUND", error.message, { cause: error });
      }
      throw new RuntimeSkillAcquisitionError("INSTALL_FAILED", "Runtime skill installation failed", {
        cause: error,
      });
    }

    if (caller.sessionId !== undefined && this.deps.sessionStore !== undefined) {
      const persist = await this.deps.sessionStore.appendSessionRoleSkill(
        caller.sessionId,
        caller.role,
        skillName,
      );
      if (persist === "session_missing" || persist === "role_missing") {
        throw new RuntimeSkillAcquisitionError(
          "SESSION_PERSIST_FAILED",
          `Runtime skill installed but session persistence returned ${persist}`,
          {
            workspaceInstalled: true,
            installedTargets: installedTargets.map((target) => relative(caller.workspacePath, target)),
          },
        );
      }
    }

    const skillPath = join(caller.workspacePath, ".codex", "skills", skillName, "SKILL.md");
    const bounded = await readBoundedText(skillPath, runtimeSkills.returnSkillMdMaxBytes);
    const result: RuntimeSkillAcquisitionResult = {
      skillName,
      status: alreadyInstalled ? "already_installed" : "installed",
      source: actualSource,
      sessionPersisted: caller.sessionId !== undefined && this.deps.sessionStore !== undefined,
      providerReload: {
        status: "context-returned",
        message:
          "Provider live reload is not guaranteed; use returned skill content immediately.",
      },
      installedTargets: installedTargets.map((target) => relative(caller.workspacePath, target)),
      skill: { name: skillName, skillMd: bounded.text, truncated: bounded.truncated },
      warnings: resolved.warnings,
    };
    this.deps.onAcquired?.(result);
    return result;
  }
}
```

- [ ] **Step 5: Run service tests and verify pass**

Run: `bun test src/core/runtime-skill-acquisition.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/runtime-skill-acquisition.ts src/core/runtime-skill-acquisition.test.ts
git commit -m "feat(skills): add runtime acquisition service"
```

## Task 6: MCP Runtime Skill Tool

**Files:**
- Create: `src/mcp/tools/runtime-skills.ts`
- Create: `src/mcp/tools/runtime-skills.test.ts`
- Modify: `src/mcp/deps.ts`
- Modify: `src/mcp/server.ts`
- Modify: `src/mcp/server.test.ts`

- [ ] **Step 1: Add failing server registration tests**

In `src/mcp/server.test.ts`, add:

```ts
  test("stdio transport registers runtime skill request tool", async () => {
    const server = await createMcpServer(deps, { transport: "stdio" });
    const names = getRegisteredToolNames(server);
    expect(names).toContain("grove_request_skill");
  });

  test("http transport omits runtime skill request tool", async () => {
    const server = await createMcpServer(deps, { transport: "http" });
    const names = getRegisteredToolNames(server);
    expect(names).not.toContain("grove_request_skill");
  });
```

- [ ] **Step 2: Add failing MCP tool tests**

Create `src/mcp/tools/runtime-skills.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RuntimeSkillAcquisitionService } from "../../core/runtime-skill-acquisition.js";
import type { McpDeps } from "../deps.js";
import type { TestMcpDeps } from "../test-helpers.js";
import { createTestMcpDeps } from "../test-helpers.js";
import { registerRuntimeSkillTools } from "./runtime-skills.js";

async function callTool(
  server: McpServer,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean | undefined; text: string }> {
  const registeredTools = (
    server as unknown as {
      _registeredTools: Record<string, { handler: (args: unknown) => Promise<unknown> }>;
    }
  )._registeredTools;
  const tool = registeredTools[name];
  if (!tool) throw new Error(`Tool ${name} not registered`);
  const result = (await tool.handler(args)) as {
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
  };
  return { isError: result.isError, text: result.content[0]?.text ?? "" };
}

describe("grove_request_skill", () => {
  let testDeps: TestMcpDeps | undefined;
  const originalRole = process.env.GROVE_AGENT_ROLE;
  const originalAgent = process.env.GROVE_AGENT_ID;
  const originalSession = process.env.GROVE_SESSION_ID;

  afterEach(async () => {
    if (originalRole === undefined) delete process.env.GROVE_AGENT_ROLE;
    else process.env.GROVE_AGENT_ROLE = originalRole;
    if (originalAgent === undefined) delete process.env.GROVE_AGENT_ID;
    else process.env.GROVE_AGENT_ID = originalAgent;
    if (originalSession === undefined) delete process.env.GROVE_SESSION_ID;
    else process.env.GROVE_SESSION_ID = originalSession;
    await testDeps?.cleanup();
    testDeps = undefined;
  });

  test("binds trusted caller context from env and cwd", async () => {
    testDeps = await createTestMcpDeps();
    process.env.GROVE_AGENT_ROLE = "coder";
    process.env.GROVE_AGENT_ID = "agent-1";
    process.env.GROVE_SESSION_ID = "session-1";

    const calls: unknown[] = [];
    const runtimeSkillService: RuntimeSkillAcquisitionService = {
      requestSkill: async (input) => {
        calls.push(input);
        return {
          skillName: input.skillName,
          status: "installed",
          source: "bundled",
          sessionPersisted: true,
          providerReload: { status: "context-returned", message: "use returned content" },
          installedTargets: [".codex/skills/review", ".claude/skills/review"],
          skill: { name: "review", skillMd: "review skill", truncated: false },
          warnings: [],
        };
      },
    };
    const deps: McpDeps = { ...testDeps.deps, runtimeSkillService };
    const server = new McpServer({ name: "test", version: "0.0.1" }, { capabilities: { tools: {} } });
    registerRuntimeSkillTools(server, deps);

    const result = await callTool(server, "grove_request_skill", { skillName: "review" });

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.text).skill.skillMd).toBe("review skill");
    expect(calls).toEqual([
      {
        skillName: "review",
        caller: {
          role: "coder",
          agentId: "agent-1",
          sessionId: "session-1",
          workspacePath: process.cwd(),
        },
      },
    ]);
  });

  test("returns NOT_CONFIGURED when service is absent", async () => {
    testDeps = await createTestMcpDeps();
    const server = new McpServer({ name: "test", version: "0.0.1" }, { capabilities: { tools: {} } });
    registerRuntimeSkillTools(server, testDeps.deps);

    const result = await callTool(server, "grove_request_skill", { skillName: "review" });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("[NOT_CONFIGURED]");
  });
});
```

- [ ] **Step 3: Run MCP tests and verify failure**

Run: `bun test src/mcp/server.test.ts src/mcp/tools/runtime-skills.test.ts`

Expected: FAIL because runtime skill tools and `runtimeSkillService` are missing.

- [ ] **Step 4: Add MCP dependency**

In `src/mcp/deps.ts`, import:

```ts
import type { RuntimeSkillAcquisitionService } from "../core/runtime-skill-acquisition.js";
```

Add to `McpDeps`:

```ts
  readonly runtimeSkillService?: RuntimeSkillAcquisitionService | undefined;
```

- [ ] **Step 5: Implement MCP tool**

Create `src/mcp/tools/runtime-skills.ts`:

```ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { RuntimeSkillAcquisitionError } from "../../core/runtime-skill-acquisition.js";
import type { McpDeps } from "../deps.js";
import { toolError } from "../error-handler.js";

const requestSkillInputSchema = z.object({
  skillName: z.string().min(1).max(128).describe("Name of the skill to request"),
  reason: z.string().max(1000).optional().describe("Why the agent needs this skill"),
});

function callerRole(): string | undefined {
  const role = process.env.GROVE_AGENT_ROLE;
  return role && role.length > 0 ? role : undefined;
}

export function registerRuntimeSkillTools(server: McpServer, deps: McpDeps): void {
  server.registerTool(
    "grove_request_skill",
    {
      description:
        "Request an allowlisted Grove skill at runtime. Installs it into the live workspace and returns bounded SKILL.md content for immediate use.",
      inputSchema: requestSkillInputSchema,
    },
    async (args) => {
      if (deps.runtimeSkillService === undefined) {
        return toolError("NOT_CONFIGURED", "Runtime skill acquisition is not configured");
      }
      const role = callerRole();
      if (role === undefined) {
        return toolError("NOT_AUTHORIZED", "Runtime skill request has no bound agent role");
      }

      try {
        const result = await deps.runtimeSkillService.requestSkill({
          skillName: args.skillName,
          ...(args.reason !== undefined ? { reason: args.reason } : {}),
          caller: {
            role,
            ...(process.env.GROVE_AGENT_ID ? { agentId: process.env.GROVE_AGENT_ID } : {}),
            ...(process.env.GROVE_SESSION_ID ? { sessionId: process.env.GROVE_SESSION_ID } : {}),
            workspacePath: process.cwd(),
          },
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (error) {
        if (error instanceof RuntimeSkillAcquisitionError) {
          return toolError(error.code, error.message);
        }
        throw error;
      }
    },
  );
}
```

- [ ] **Step 6: Register tool in server**

In `src/mcp/server.ts`, import:

```ts
import { registerRuntimeSkillTools } from "./tools/runtime-skills.js";
```

After the always-registered contribution/done/handoff section, add:

```ts
  if (preset?.transport !== "http") registerRuntimeSkillTools(server, deps);
```

- [ ] **Step 7: Run MCP tests and verify pass**

Run: `bun test src/mcp/server.test.ts src/mcp/tools/runtime-skills.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/mcp/deps.ts src/mcp/server.ts src/mcp/server.test.ts src/mcp/tools/runtime-skills.ts src/mcp/tools/runtime-skills.test.ts
git commit -m "feat(mcp): add runtime skill request tool"
```

## Task 7: Stdio Runtime Wiring

**Files:**
- Modify: `src/mcp/serve.ts`
- Modify: `src/mcp/serve-http.ts`
- Modify: `src/mcp/deps-parity.test.ts`

- [ ] **Step 1: Add deps parity expectation**

In `src/mcp/deps-parity.test.ts`, add `runtimeSkillService` to the stdio dependency assertions and assert it is omitted or undefined for HTTP scoped deps. Use the same assertion style already in that file:

```ts
expect(deps.runtimeSkillService).toBeDefined();
```

For HTTP scoped deps:

```ts
expect(scopedDeps.runtimeSkillService).toBeUndefined();
```

- [ ] **Step 2: Run parity tests and verify failure**

Run: `bun test src/mcp/deps-parity.test.ts`

Expected: FAIL because stdio deps do not build `runtimeSkillService` yet.

- [ ] **Step 3: Wire service in stdio MCP**

In `src/mcp/serve.ts`, add imports:

```ts
import { readFile } from "node:fs/promises";
import { DefaultRuntimeSkillAcquisitionService } from "../core/runtime-skill-acquisition.js";
import { parseGroveConfig } from "../core/config.js";
import { resolveBundledSkillsRoot } from "../core/resolve-mcp-serve-path.js";
import { resolveConfiguredNexusUrl } from "../shared/nexus-url.js";
```

If an import already exists in `serve.ts`, reuse it instead of duplicating.

Before constructing `deps`, create:

```ts
  const projectRoot = join(groveDir, "..");
  const readRuntimeSkillsConfig = async () => {
    const configPath = join(groveDir, "grove.json");
    if (!existsSync(configPath)) return undefined;
    const config = parseGroveConfig(await readFile(configPath, "utf-8"));
    return config.runtimeSkills;
  };

  const runtimeSkillService = new DefaultRuntimeSkillAcquisitionService({
    readRuntimeSkillsConfig,
    bundledSkillsRoot: resolveBundledSkillsRoot(projectRoot),
    workspaceOverrideRoot: join(groveDir, "skills"),
    sessionStore: runtime.goalSessionStore,
    resolveSkillRoot: async (skills) => {
      const configPath = join(groveDir, "grove.json");
      if (!existsSync(configPath)) return undefined;
      const config = parseGroveConfig(await readFile(configPath, "utf-8"));
      if (config.mode !== "nexus" || config.skillCatalog === undefined || nexusClient === undefined) {
        return undefined;
      }
      const nexusUrlForSkills = resolveConfiguredNexusUrl({ projectRoot, config, env: process.env });
      if (!nexusUrlForSkills) return undefined;
      const { resolveNexusSkillCatalogRoot } = await import("../nexus/nexus-skill-catalog.js");
      return resolveNexusSkillCatalogRoot({
        client: nexusClient,
        zoneId,
        cacheRoot: join(groveDir, "cache", "skills"),
        skills,
        policy: config.skillCatalog.policy,
        trustedKeys: config.skillCatalog.trustedKeys,
        localFallbackRoots: [join(groveDir, "skills"), resolveBundledSkillsRoot(projectRoot)],
      });
    },
  });
```

Add to `deps`:

```ts
    runtimeSkillService,
```

- [ ] **Step 4: Keep HTTP omission explicit**

In `src/mcp/serve-http.ts`, do not construct `runtimeSkillService` for `scopedDeps`. Add a short comment immediately before `createMcpServer(scopedDeps, { transport: "http" })`:

```ts
    // Runtime skill acquisition mutates the caller workspace and requires
    // stdio's per-agent role/cwd binding. HTTP MCP intentionally omits it.
```

- [ ] **Step 5: Run parity and MCP server tests**

Run: `bun test src/mcp/deps-parity.test.ts src/mcp/server.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/serve.ts src/mcp/serve-http.ts src/mcp/deps-parity.test.ts
git commit -m "feat(mcp): wire runtime skill service for stdio"
```

## Task 8: End-to-End Runtime Skill Coverage

**Files:**
- Modify: `src/mcp/server.integration.test.ts`
- Modify: `README.md`

- [ ] **Step 1: Add integration test for local catalog install**

In `src/mcp/server.integration.test.ts`, add a test that:

1. Creates temp `groveDir`, `workspace`, and `skills/review/SKILL.md`.
2. Writes `.grove/grove.json` with `runtimeSkills`.
3. Creates a session with topology role `coder`.
4. Builds `DefaultRuntimeSkillAcquisitionService` with the temp roots.
5. Registers MCP server with stdio preset.
6. Calls `grove_request_skill`.
7. Asserts both native skill paths exist and session topology includes `review`.

Use this assertion block:

```ts
expect(readFileSync(join(workspace, ".codex/skills/review/SKILL.md"), "utf-8")).toBe(
  "review skill",
);
expect(readFileSync(join(workspace, ".claude/skills/review/SKILL.md"), "utf-8")).toBe(
  "review skill",
);
const updated = await goalSessionStore.getSession(session.id);
expect(updated?.topology?.roles[0]?.skills).toEqual(["grove", "review"]);
```

- [ ] **Step 2: Run integration test and verify pass**

Run: `bun test src/mcp/server.integration.test.ts`

Expected: PASS.

- [ ] **Step 3: Document runtime skill configuration**

In `README.md`, under the existing "Agent skills" section, add:

````md
### Runtime skill requests

Bootstrap `skills:` remain the default way to give agents capabilities. A Grove
can also opt into runtime skill requests for stdio MCP agents by adding a
`runtimeSkills` allowlist to `.grove/grove.json`:

```json
{
  "runtimeSkills": {
    "mode": "role-allowlist",
    "roles": {
      "coder": ["grove", "review"]
    }
  }
}
```

An allowed agent can call `grove_request_skill({ "skillName": "review" })`.
Grove installs the skill into the live workspace, returns bounded `SKILL.md`
content for immediate use, and appends the skill to the session's effective
role skills for reattach or restart. HTTP MCP does not expose this mutation
tool.
````

- [ ] **Step 4: Run targeted docs and integration checks**

Run:

```bash
bun test src/mcp/server.integration.test.ts src/core/runtime-skill-acquisition.test.ts src/mcp/tools/runtime-skills.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/server.integration.test.ts README.md
git commit -m "test(skills): cover runtime skill request flow"
```

## Task 9: Full Verification

**Files:**
- No new files.

- [ ] **Step 1: Run typecheck**

Run: `bun run typecheck`

Expected: PASS.

- [ ] **Step 2: Run Biome check**

Run: `bun run check`

Expected: PASS.

- [ ] **Step 3: Run focused test suite**

Run:

```bash
bun test \
  src/core/config.test.ts \
  src/core/in-memory-session-store.test.ts \
  src/local/sqlite-goal-session-store.test.ts \
  src/nexus/nexus-session-store.test.ts \
  src/core/runtime-skill-acquisition.test.ts \
  src/mcp/server.test.ts \
  src/mcp/tools/runtime-skills.test.ts \
  src/mcp/deps-parity.test.ts \
  src/mcp/server.integration.test.ts
```

Expected: PASS.

- [ ] **Step 4: Run full test suite**

Run: `bun test`

Expected: PASS. If unrelated existing failures appear, capture the failing test names and error snippets in the final implementation report.

- [ ] **Step 5: Final status**

Run: `git status --short`

Expected: clean worktree after the final implementation commit.

## Self-Review Notes

- Spec coverage: config, stdio-only MCP contract, role allowlist, runtime service, existing resolver reuse, workspace injection, bounded returned content, session persistence, provider reload fallback, structured errors, security defaults, and testing are each mapped to tasks.
- Scope check: HTTP mutation, approval queues, capability tokens, provider-specific reload hooks, skill removal, and TUI UI are intentionally outside this implementation plan.
- Type consistency: `runtimeSkills`, `RuntimeSkillSessionStore`, `appendSessionRoleSkill`, `DefaultRuntimeSkillAcquisitionService`, `RuntimeSkillAcquisitionError`, and `grove_request_skill` use the same names across tasks.
