# Project Identity (A2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist a UUIDv4 project identity in `.grove/project-id` on `grove init`, with a user-level registry at `~/.grove/projects.yaml` keyed by normalized git origin URL — satisfying issue #288 acceptance criteria.

**Architecture:** Four modules. Pure file I/O lives in `src/core/project-id.ts` and `src/core/project-registry.ts`. Git-origin detection and URL normalization live in `src/cli/utils/origin-url.ts`. Orchestration (derivation flow + optional TTY prompt) lives in `src/cli/utils/ensure-project-id.ts`. `grove init` calls the orchestrator once, after `.grove/` is created and before `grove.json` is written.

**Tech Stack:** TypeScript (Bun), Bun test runner, `yaml` v2 for registry serialization, `crypto.randomUUID()` for generation, `child_process.spawnSync` for git invocation, `node:readline` for the interactive prompt.

**Spec:** `docs/superpowers/specs/2026-04-24-project-identity-a2-design.md`

---

## File Structure

**New files:**

- `src/core/project-id.ts` — pure: UUIDv4 validation, generation, `.grove/project-id` read/write.
- `src/core/project-id.test.ts` — unit tests for the above.
- `src/core/project-registry.ts` — pure: `~/.grove/projects.yaml` load/save, lookup/upsert. Owns the `Registry` and `RegistryEntry` types.
- `src/core/project-registry.test.ts` — unit tests.
- `src/cli/utils/origin-url.ts` — git origin detection via `git remote get-url origin`, URL normalization.
- `src/cli/utils/origin-url.test.ts` — table-driven normalization tests + real-git-repo detection tests.
- `src/cli/utils/ensure-project-id.ts` — orchestrator: derivation flow, optional TTY prompt, progress log line.
- `src/cli/utils/ensure-project-id.test.ts` — integration tests with injected deps.

**Modified files:**

- `src/cli/commands/init.ts` — add `--unify` / `--no-unify` flags; call `ensureProjectId` after `.grove/` is created; emit the progress line from its result.
- `src/cli/commands/init.test.ts` — add the four acceptance tests from issue #288.

---

## Task 1: UUID validation + generation

**Files:**
- Create: `src/core/project-id.ts`
- Test: `src/core/project-id.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/core/project-id.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { generateProjectId, isValidProjectId } from "./project-id.js";

describe("isValidProjectId", () => {
  test("accepts a canonical UUIDv4", () => {
    expect(isValidProjectId("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
  });

  test("accepts uppercase UUIDv4", () => {
    expect(isValidProjectId("550E8400-E29B-41D4-A716-446655440000")).toBe(true);
  });

  test("rejects empty string", () => {
    expect(isValidProjectId("")).toBe(false);
  });

  test("rejects a UUIDv1", () => {
    // version nibble is '1', not '4'
    expect(isValidProjectId("550e8400-e29b-11d4-a716-446655440000")).toBe(false);
  });

  test("rejects a UUIDv7", () => {
    expect(isValidProjectId("01890abc-def0-7123-8abc-def012345678")).toBe(false);
  });

  test("rejects strings with surrounding whitespace", () => {
    expect(isValidProjectId(" 550e8400-e29b-41d4-a716-446655440000 ")).toBe(false);
  });

  test("rejects non-UUID garbage", () => {
    expect(isValidProjectId("not-a-uuid")).toBe(false);
  });
});

describe("generateProjectId", () => {
  test("returns a valid UUIDv4", () => {
    const id = generateProjectId();
    expect(isValidProjectId(id)).toBe(true);
  });

  test("returns a different UUID each call", () => {
    const a = generateProjectId();
    const b = generateProjectId();
    expect(a).not.toBe(b);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/project-id.test.ts`
Expected: FAIL — module `./project-id.js` not found.

- [ ] **Step 3: Write minimal implementation**

Create `src/core/project-id.ts`:

```ts
/**
 * Project identity — persistent UUIDv4 for a Grove-initialized clone.
 *
 * The project id lives at `<groveDir>/project-id` as a single UUIDv4 line.
 * It is created by `grove init` and is immutable for the life of the clone.
 */

import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const PROJECT_ID_FILE = "project-id";

const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidProjectId(s: string): boolean {
  return UUID_V4_REGEX.test(s);
}

export function generateProjectId(): string {
  return randomUUID();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/core/project-id.test.ts`
Expected: PASS — all 9 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/project-id.ts src/core/project-id.test.ts
git commit -m "feat(core): UUIDv4 validation + generation for project id (#288)"
```

---

## Task 2: `readProjectId`

**Files:**
- Modify: `src/core/project-id.ts`
- Modify: `src/core/project-id.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/core/project-id.test.ts`:

```ts
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readProjectId } from "./project-id.js";

function makeTmpGroveDir(): string {
  const dir = join(
    tmpdir(),
    `grove-project-id-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("readProjectId", () => {
  test("returns null when file is missing", () => {
    const dir = makeTmpGroveDir();
    expect(readProjectId(dir)).toBeNull();
  });

  test("returns null when file is empty", () => {
    const dir = makeTmpGroveDir();
    writeFileSync(join(dir, "project-id"), "");
    expect(readProjectId(dir)).toBeNull();
  });

  test("returns id without trailing newline", () => {
    const dir = makeTmpGroveDir();
    writeFileSync(join(dir, "project-id"), "550e8400-e29b-41d4-a716-446655440000");
    expect(readProjectId(dir)).toBe("550e8400-e29b-41d4-a716-446655440000");
  });

  test("returns id with trailing newline", () => {
    const dir = makeTmpGroveDir();
    writeFileSync(join(dir, "project-id"), "550e8400-e29b-41d4-a716-446655440000\n");
    expect(readProjectId(dir)).toBe("550e8400-e29b-41d4-a716-446655440000");
  });

  test("throws on malformed contents", () => {
    const dir = makeTmpGroveDir();
    writeFileSync(join(dir, "project-id"), "garbage\n");
    expect(() => readProjectId(dir)).toThrow(/Invalid project id/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/project-id.test.ts`
Expected: FAIL — `readProjectId` is not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/core/project-id.ts`:

```ts
export function readProjectId(groveDir: string): string | null {
  const path = join(groveDir, PROJECT_ID_FILE);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const trimmed = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  if (trimmed === "") return null;
  if (!isValidProjectId(trimmed)) {
    throw new Error(
      `Invalid project id in ${path}. Fix the file or delete it to regenerate.`,
    );
  }
  return trimmed;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/core/project-id.test.ts`
Expected: PASS — all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/project-id.ts src/core/project-id.test.ts
git commit -m "feat(core): readProjectId from .grove/project-id (#288)"
```

---

## Task 3: `writeProjectId`

**Files:**
- Modify: `src/core/project-id.ts`
- Modify: `src/core/project-id.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/core/project-id.test.ts`:

```ts
import { readFileSync, statSync } from "node:fs";
import { writeProjectId } from "./project-id.js";

describe("writeProjectId", () => {
  test("writes id with trailing newline", () => {
    const dir = makeTmpGroveDir();
    const id = "550e8400-e29b-41d4-a716-446655440000";
    writeProjectId(dir, id);
    const raw = readFileSync(join(dir, "project-id"), "utf8");
    expect(raw).toBe(`${id}\n`);
  });

  test("rejects invalid id", () => {
    const dir = makeTmpGroveDir();
    expect(() => writeProjectId(dir, "not-a-uuid")).toThrow(/invalid/i);
  });

  test("round-trips through readProjectId", () => {
    const dir = makeTmpGroveDir();
    const id = generateProjectId();
    writeProjectId(dir, id);
    expect(readProjectId(dir)).toBe(id);
  });

  test("is stable on repeated writes with same id", () => {
    const dir = makeTmpGroveDir();
    const id = generateProjectId();
    writeProjectId(dir, id);
    const first = readFileSync(join(dir, "project-id"), "utf8");
    writeProjectId(dir, id);
    const second = readFileSync(join(dir, "project-id"), "utf8");
    expect(second).toBe(first);
  });

  test("writes mode 0644", () => {
    const dir = makeTmpGroveDir();
    writeProjectId(dir, generateProjectId());
    const mode = statSync(join(dir, "project-id")).mode & 0o777;
    expect(mode).toBe(0o644);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/project-id.test.ts`
Expected: FAIL — `writeProjectId` is not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/core/project-id.ts`:

```ts
export function writeProjectId(groveDir: string, id: string): void {
  if (!isValidProjectId(id)) {
    throw new Error(`Cannot write invalid project id: ${JSON.stringify(id)}`);
  }
  const target = join(groveDir, PROJECT_ID_FILE);
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${id}\n`, { encoding: "utf8", mode: 0o644 });
  renameSync(tmp, target);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/core/project-id.test.ts`
Expected: PASS — all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/project-id.ts src/core/project-id.test.ts
git commit -m "feat(core): writeProjectId atomic write with 0644 (#288)"
```

---

## Task 4: Registry types + `defaultRegistryPath`

**Files:**
- Create: `src/core/project-registry.ts`
- Test: `src/core/project-registry.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/core/project-registry.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  defaultRegistryPath,
  type Registry,
  type RegistryEntry,
} from "./project-registry.js";

describe("Registry types", () => {
  test("RegistryEntry requires id, name, createdAt", () => {
    const e: RegistryEntry = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      name: "foo/bar",
      createdAt: "2026-04-24T00:00:00.000Z",
    };
    expect(e.id).toBeDefined();
  });

  test("Registry has version: 1 and projects map", () => {
    const r: Registry = { version: 1, projects: {} };
    expect(r.version).toBe(1);
    expect(r.projects).toEqual({});
  });
});

describe("defaultRegistryPath", () => {
  test("returns $HOME/.grove/projects.yaml", () => {
    expect(defaultRegistryPath()).toBe(join(homedir(), ".grove", "projects.yaml"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/project-registry.test.ts`
Expected: FAIL — module `./project-registry.js` not found.

- [ ] **Step 3: Write minimal implementation**

Create `src/core/project-registry.ts`:

```ts
/**
 * User-level project registry: `~/.grove/projects.yaml`.
 *
 * Keyed by the normalized git-origin URL, one entry per logical project.
 * Used by `grove init` to correlate clones of the same remote.
 */

import { homedir } from "node:os";
import { join } from "node:path";

export interface RegistryEntry {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
}

export interface Registry {
  readonly version: 1;
  readonly projects: Readonly<Record<string, RegistryEntry>>;
}

export function defaultRegistryPath(): string {
  const home = homedir();
  if (!home) {
    throw new Error("Cannot resolve user home directory for ~/.grove registry.");
  }
  return join(home, ".grove", "projects.yaml");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/core/project-registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/project-registry.ts src/core/project-registry.test.ts
git commit -m "feat(core): project registry types + default path (#288)"
```

---

## Task 5: `loadRegistry`

**Files:**
- Modify: `src/core/project-registry.ts`
- Modify: `src/core/project-registry.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/core/project-registry.test.ts`:

```ts
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { loadRegistry } from "./project-registry.js";

function makeTmpFile(basename: string): string {
  const dir = join(
    tmpdir(),
    `grove-registry-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return join(dir, basename);
}

describe("loadRegistry", () => {
  test("returns empty registry when file is missing", () => {
    const path = makeTmpFile("projects.yaml");
    const r = loadRegistry(path);
    expect(r).toEqual({ version: 1, projects: {} });
  });

  test("loads a well-formed registry", () => {
    const path = makeTmpFile("projects.yaml");
    writeFileSync(
      path,
      [
        "version: 1",
        "projects:",
        "  github.com/foo/bar:",
        "    id: 550e8400-e29b-41d4-a716-446655440000",
        "    name: foo/bar",
        "    createdAt: 2026-04-24T00:00:00.000Z",
        "",
      ].join("\n"),
    );
    const r = loadRegistry(path);
    expect(r.version).toBe(1);
    expect(r.projects["github.com/foo/bar"]?.id).toBe(
      "550e8400-e29b-41d4-a716-446655440000",
    );
    expect(r.projects["github.com/foo/bar"]?.name).toBe("foo/bar");
  });

  test("throws on malformed YAML", () => {
    const path = makeTmpFile("projects.yaml");
    writeFileSync(path, ":: this is not valid yaml ::\n  - [\n");
    expect(() => loadRegistry(path)).toThrow();
  });

  test("throws on unknown version", () => {
    const path = makeTmpFile("projects.yaml");
    writeFileSync(path, "version: 2\nprojects: {}\n");
    expect(() => loadRegistry(path)).toThrow(/version/i);
  });

  test("throws when an entry has a non-UUIDv4 id", () => {
    const path = makeTmpFile("projects.yaml");
    writeFileSync(
      path,
      [
        "version: 1",
        "projects:",
        "  github.com/foo/bar:",
        "    id: not-a-uuid",
        "    name: foo/bar",
        "    createdAt: 2026-04-24T00:00:00.000Z",
        "",
      ].join("\n"),
    );
    expect(() => loadRegistry(path)).toThrow(/invalid/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/project-registry.test.ts`
Expected: FAIL — `loadRegistry` is not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/core/project-registry.ts`:

```ts
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { isValidProjectId } from "./project-id.js";

export function loadRegistry(path: string): Registry {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, projects: {} };
    }
    throw err;
  }
  const parsed = parseYaml(raw) as unknown;
  if (parsed == null || typeof parsed !== "object") {
    throw new Error(`Malformed registry at ${path}: expected a YAML mapping.`);
  }
  const root = parsed as Record<string, unknown>;
  if (root.version !== 1) {
    throw new Error(
      `Unknown registry version at ${path}: got ${JSON.stringify(root.version)}, expected 1.`,
    );
  }
  const projectsRaw = root.projects;
  if (projectsRaw == null) {
    return { version: 1, projects: {} };
  }
  if (typeof projectsRaw !== "object") {
    throw new Error(`Malformed registry at ${path}: 'projects' must be a mapping.`);
  }
  const projects: Record<string, RegistryEntry> = {};
  for (const [key, valueRaw] of Object.entries(projectsRaw as Record<string, unknown>)) {
    if (valueRaw == null || typeof valueRaw !== "object") {
      throw new Error(
        `Malformed registry at ${path}: entry '${key}' must be a mapping.`,
      );
    }
    const entry = valueRaw as Record<string, unknown>;
    const id = entry.id;
    const name = entry.name;
    const createdAt = entry.createdAt;
    if (typeof id !== "string" || !isValidProjectId(id)) {
      throw new Error(
        `Invalid registry entry '${key}' at ${path}: id is not a valid UUIDv4.`,
      );
    }
    if (typeof name !== "string" || typeof createdAt !== "string") {
      throw new Error(
        `Invalid registry entry '${key}' at ${path}: name and createdAt must be strings.`,
      );
    }
    projects[key] = { id, name, createdAt };
  }
  return { version: 1, projects };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/core/project-registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/project-registry.ts src/core/project-registry.test.ts
git commit -m "feat(core): loadRegistry from ~/.grove/projects.yaml (#288)"
```

---

## Task 6: `saveRegistry` + `lookupByOrigin` + `upsertEntry`

**Files:**
- Modify: `src/core/project-registry.ts`
- Modify: `src/core/project-registry.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/core/project-registry.test.ts`:

```ts
import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { lookupByOrigin, saveRegistry, upsertEntry } from "./project-registry.js";

describe("saveRegistry", () => {
  test("creates parent directory if missing", () => {
    const path = join(makeTmpFile("unused").replace(/\/[^/]+$/, ""), "nested", "projects.yaml");
    const reg: Registry = {
      version: 1,
      projects: {
        "github.com/foo/bar": {
          id: "550e8400-e29b-41d4-a716-446655440000",
          name: "foo/bar",
          createdAt: "2026-04-24T00:00:00.000Z",
        },
      },
    };
    saveRegistry(path, reg);
    expect(existsSync(dirname(path))).toBe(true);
    expect(existsSync(path)).toBe(true);
  });

  test("round-trips through loadRegistry", () => {
    const path = makeTmpFile("projects.yaml");
    const reg: Registry = {
      version: 1,
      projects: {
        "github.com/foo/bar": {
          id: "550e8400-e29b-41d4-a716-446655440000",
          name: "foo/bar",
          createdAt: "2026-04-24T00:00:00.000Z",
        },
      },
    };
    saveRegistry(path, reg);
    expect(loadRegistry(path)).toEqual(reg);
  });

  test("writes with version: 1 field visible at top of file", () => {
    const path = makeTmpFile("projects.yaml");
    saveRegistry(path, { version: 1, projects: {} });
    const raw = readFileSync(path, "utf8");
    expect(raw.startsWith("version: 1")).toBe(true);
  });
});

describe("lookupByOrigin", () => {
  const reg: Registry = {
    version: 1,
    projects: {
      "github.com/foo/bar": {
        id: "550e8400-e29b-41d4-a716-446655440000",
        name: "foo/bar",
        createdAt: "2026-04-24T00:00:00.000Z",
      },
    },
  };

  test("returns entry on hit", () => {
    expect(lookupByOrigin(reg, "github.com/foo/bar")?.id).toBe(
      "550e8400-e29b-41d4-a716-446655440000",
    );
  });

  test("returns null on miss", () => {
    expect(lookupByOrigin(reg, "gitlab.com/acme/service")).toBeNull();
  });
});

describe("upsertEntry", () => {
  const base: Registry = { version: 1, projects: {} };

  test("adds a new entry without mutating input", () => {
    const next = upsertEntry(base, "github.com/foo/bar", {
      id: "550e8400-e29b-41d4-a716-446655440000",
      name: "foo/bar",
      createdAt: "2026-04-24T00:00:00.000Z",
    });
    expect(next.projects["github.com/foo/bar"]?.id).toBe(
      "550e8400-e29b-41d4-a716-446655440000",
    );
    expect(base.projects["github.com/foo/bar"]).toBeUndefined();
  });

  test("overwrites an existing entry", () => {
    const seeded: Registry = {
      version: 1,
      projects: {
        "github.com/foo/bar": {
          id: "550e8400-e29b-41d4-a716-446655440000",
          name: "foo/bar",
          createdAt: "2026-04-24T00:00:00.000Z",
        },
      },
    };
    const next = upsertEntry(seeded, "github.com/foo/bar", {
      id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
      name: "foo/bar",
      createdAt: "2026-04-25T00:00:00.000Z",
    });
    expect(next.projects["github.com/foo/bar"]?.id).toBe(
      "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/project-registry.test.ts`
Expected: FAIL — `saveRegistry`, `lookupByOrigin`, `upsertEntry` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/core/project-registry.ts`:

```ts
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { stringify as stringifyYaml } from "yaml";

export function saveRegistry(path: string, reg: Registry): void {
  mkdirSync(dirname(path), { recursive: true });
  const body = stringifyYaml(reg);
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, body, { encoding: "utf8", mode: 0o644 });
  renameSync(tmp, path);
}

export function lookupByOrigin(
  reg: Registry,
  origin: string,
): RegistryEntry | null {
  return reg.projects[origin] ?? null;
}

export function upsertEntry(
  reg: Registry,
  origin: string,
  entry: RegistryEntry,
): Registry {
  return {
    version: 1,
    projects: { ...reg.projects, [origin]: entry },
  };
}
```

Also extend the top-of-file `parse as parseYaml` import line to include `stringify`. If the import already uses the named form, merge:

```ts
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
```

(Consolidate to a single import statement.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/core/project-registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/project-registry.ts src/core/project-registry.test.ts
git commit -m "feat(core): saveRegistry + lookupByOrigin + upsertEntry (#288)"
```

---

## Task 7: `normalizeOriginUrl`

**Files:**
- Create: `src/cli/utils/origin-url.ts`
- Test: `src/cli/utils/origin-url.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/cli/utils/origin-url.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { normalizeOriginUrl } from "./origin-url.js";

describe("normalizeOriginUrl", () => {
  const cases: Array<[string, string | null]> = [
    ["https://github.com/Foo/Bar.git", "github.com/Foo/Bar"],
    ["https://github.com/Foo/Bar", "github.com/Foo/Bar"],
    ["http://github.com/Foo/Bar", "github.com/Foo/Bar"],
    ["git@github.com:Foo/Bar.git", "github.com/Foo/Bar"],
    ["git@github.com:Foo/Bar", "github.com/Foo/Bar"],
    ["ssh://git@github.com/Foo/Bar.git", "github.com/Foo/Bar"],
    ["ssh://git@github.com:22/Foo/Bar.git", "github.com/Foo/Bar"],
    ["git://github.com/Foo/Bar", "github.com/Foo/Bar"],
    ["git+ssh://git@github.com/Foo/Bar.git", "github.com/Foo/Bar"],
    ["https://GitHub.com/foo/bar", "github.com/foo/bar"],
    ["https://github.com/ACME/Repo/", "github.com/ACME/Repo"],
    ["", null],
    ["just-a-string", null],
    ["file:///tmp/repo", null],
  ];

  for (const [input, expected] of cases) {
    test(`${JSON.stringify(input)} → ${JSON.stringify(expected)}`, () => {
      expect(normalizeOriginUrl(input)).toBe(expected);
    });
  }

  test("preserves path case for GitLab-style paths", () => {
    expect(normalizeOriginUrl("https://gitlab.com/Acme/Service.git")).toBe(
      "gitlab.com/Acme/Service",
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/cli/utils/origin-url.test.ts`
Expected: FAIL — module `./origin-url.js` not found.

- [ ] **Step 3: Write minimal implementation**

Create `src/cli/utils/origin-url.ts`:

```ts
/**
 * Git origin URL detection and normalization.
 *
 * Normalization collapses the common "same repo, different URL" cases
 * (HTTPS vs SSH, with/without .git suffix, with/without port, mixed case
 * host) to a single canonical key of the form "host/path" with the host
 * lowercased and the path case preserved.
 */

const SCHEME_RE = /^(?:https?|ssh|git|git\+ssh):\/\//i;

export function normalizeOriginUrl(raw: string): string | null {
  if (!raw) return null;

  let s = raw.trim();
  if (!s) return null;

  // Reject schemes we don't correlate (file://, local paths).
  if (s.toLowerCase().startsWith("file://")) return null;

  // 1. Strip known scheme.
  const hadScheme = SCHEME_RE.test(s);
  if (hadScheme) s = s.replace(SCHEME_RE, "");

  // 2. Strip leading user@ (only if it appears before the first '/' or ':').
  const atIdx = s.indexOf("@");
  if (atIdx > -1) {
    const firstSep = Math.min(
      ...["/", ":"].map((c) => {
        const i = s.indexOf(c);
        return i === -1 ? Number.POSITIVE_INFINITY : i;
      }),
    );
    if (atIdx < firstSep) {
      s = s.slice(atIdx + 1);
    }
  }

  // 3. SCP-style host:path → host/path (only when there is no '/' before the ':').
  if (!hadScheme) {
    const colonIdx = s.indexOf(":");
    const slashIdx = s.indexOf("/");
    if (colonIdx > 0 && (slashIdx === -1 || colonIdx < slashIdx)) {
      s = `${s.slice(0, colonIdx)}/${s.slice(colonIdx + 1)}`;
    }
  }

  // 4. Strip :<port> between host and '/'.
  const portMatch = s.match(/^([^/:]+):(\d+)\//);
  if (portMatch) {
    s = `${portMatch[1]}/${s.slice(portMatch[0].length)}`;
  }

  // 5. Strip trailing .git.
  if (s.toLowerCase().endsWith(".git")) s = s.slice(0, -4);

  // 6. Strip trailing /.
  while (s.endsWith("/")) s = s.slice(0, -1);

  // 7. Lowercase host (characters up to the first '/').
  const firstSlash = s.indexOf("/");
  if (firstSlash === -1) return null;
  s = `${s.slice(0, firstSlash).toLowerCase()}${s.slice(firstSlash)}`;

  // 8. Reject if no path part after host.
  const afterSlash = s.slice(firstSlash + 1);
  if (!afterSlash) return null;

  return s;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/cli/utils/origin-url.test.ts`
Expected: PASS — all 15+ cases pass.

- [ ] **Step 5: Commit**

```bash
git add src/cli/utils/origin-url.ts src/cli/utils/origin-url.test.ts
git commit -m "feat(cli): normalizeOriginUrl — canonical host/path key (#288)"
```

---

## Task 8: `detectOriginUrl`

**Files:**
- Modify: `src/cli/utils/origin-url.ts`
- Modify: `src/cli/utils/origin-url.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/cli/utils/origin-url.test.ts`:

```ts
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectOriginUrl } from "./origin-url.js";

function makeTmpDir(): string {
  const dir = join(
    tmpdir(),
    `grove-origin-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function initGitRepo(dir: string): void {
  const run = (args: string[]) =>
    spawnSync("git", ["-C", dir, ...args], { stdio: "ignore" });
  run(["init", "-q"]);
  run(["config", "user.email", "test@example.com"]);
  run(["config", "user.name", "test"]);
}

describe("detectOriginUrl", () => {
  test("returns null in a non-git directory", () => {
    const dir = makeTmpDir();
    expect(detectOriginUrl(dir)).toBeNull();
  });

  test("returns null in a git repo with no origin remote", () => {
    const dir = makeTmpDir();
    initGitRepo(dir);
    expect(detectOriginUrl(dir)).toBeNull();
  });

  test("returns the raw origin URL", () => {
    const dir = makeTmpDir();
    initGitRepo(dir);
    spawnSync(
      "git",
      ["-C", dir, "remote", "add", "origin", "git@github.com:foo/bar.git"],
      { stdio: "ignore" },
    );
    expect(detectOriginUrl(dir)).toBe("git@github.com:foo/bar.git");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/cli/utils/origin-url.test.ts`
Expected: FAIL — `detectOriginUrl` is not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/cli/utils/origin-url.ts`:

```ts
import { spawnSync } from "node:child_process";

export function detectOriginUrl(cwd: string): string | null {
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync("git", ["-C", cwd, "remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
  if (result.error) return null;
  if (result.status !== 0) return null;
  const out = (result.stdout ?? "").trim();
  return out === "" ? null : out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/cli/utils/origin-url.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/utils/origin-url.ts src/cli/utils/origin-url.test.ts
git commit -m "feat(cli): detectOriginUrl via 'git remote get-url origin' (#288)"
```

---

## Task 9: `ensureProjectId` — happy paths without prompt

**Files:**
- Create: `src/cli/utils/ensure-project-id.ts`
- Test: `src/cli/utils/ensure-project-id.test.ts`

This task covers every branch of the derivation flow *except* the interactive prompt. Prompt handling is a separate task.

- [ ] **Step 1: Write the failing test**

Create `src/cli/utils/ensure-project-id.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readProjectId } from "../../core/project-id.js";
import { loadRegistry } from "../../core/project-registry.js";
import type { EnsureOpts } from "./ensure-project-id.js";
import { ensureProjectId } from "./ensure-project-id.js";

function mkTmp(prefix: string): string {
  const dir = join(
    tmpdir(),
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function mkClone(origin: string | null): string {
  const dir = mkTmp("grove-ensure-clone");
  const run = (args: string[]) =>
    spawnSync("git", ["-C", dir, ...args], { stdio: "ignore" });
  run(["init", "-q"]);
  run(["config", "user.email", "t@t"]);
  run(["config", "user.name", "t"]);
  if (origin) run(["remote", "add", "origin", origin]);
  return dir;
}

function mkGroveDir(parent: string): string {
  const g = join(parent, ".grove");
  mkdirSync(g, { recursive: true });
  return g;
}

function baseOpts(overrides: Partial<EnsureOpts>): EnsureOpts {
  const now = new Date("2026-04-24T00:00:00.000Z");
  return {
    groveDir: overrides.groveDir ?? "",
    cwd: overrides.cwd ?? "",
    registryPath: overrides.registryPath ?? join(mkTmp("registry"), "projects.yaml"),
    isTTY: false,
    now: () => now,
    ...overrides,
  };
}

describe("ensureProjectId — no prompt paths", () => {
  test("returns 'local' when .grove/project-id already exists", async () => {
    const clone = mkClone("git@github.com:foo/bar.git");
    const groveDir = mkGroveDir(clone);
    writeFileSync(
      join(groveDir, "project-id"),
      "550e8400-e29b-41d4-a716-446655440000\n",
    );
    const registryPath = join(mkTmp("registry"), "projects.yaml");
    const res = await ensureProjectId(baseOpts({ groveDir, cwd: clone, registryPath }));
    expect(res.source).toBe("local");
    expect(res.id).toBe("550e8400-e29b-41d4-a716-446655440000");
    // Registry untouched.
    expect(loadRegistry(registryPath)).toEqual({ version: 1, projects: {} });
  });

  test("generates new + skips registry when no git origin", async () => {
    const clone = mkClone(null);
    const groveDir = mkGroveDir(clone);
    const registryPath = join(mkTmp("registry"), "projects.yaml");
    const res = await ensureProjectId(baseOpts({ groveDir, cwd: clone, registryPath }));
    expect(res.source).toBe("generated");
    expect(res.origin).toBeNull();
    expect(res.registered).toBe(false);
    expect(readProjectId(groveDir)).toBe(res.id);
    expect(loadRegistry(registryPath)).toEqual({ version: 1, projects: {} });
  });

  test("generates new + registers entry on registry miss", async () => {
    const clone = mkClone("git@github.com:foo/bar.git");
    const groveDir = mkGroveDir(clone);
    const registryPath = join(mkTmp("registry"), "projects.yaml");
    const res = await ensureProjectId(baseOpts({ groveDir, cwd: clone, registryPath }));
    expect(res.source).toBe("generated");
    expect(res.origin).toBe("github.com/foo/bar");
    expect(res.registered).toBe(true);
    const reg = loadRegistry(registryPath);
    expect(reg.projects["github.com/foo/bar"]?.id).toBe(res.id);
    expect(reg.projects["github.com/foo/bar"]?.name).toBe("foo/bar");
  });

  test("adopts existing id when registry hits and --unify", async () => {
    const firstClone = mkClone("git@github.com:foo/bar.git");
    const firstGrove = mkGroveDir(firstClone);
    const registryPath = join(mkTmp("registry"), "projects.yaml");
    const first = await ensureProjectId(
      baseOpts({ groveDir: firstGrove, cwd: firstClone, registryPath }),
    );

    const secondClone = mkClone("https://github.com/foo/bar.git");
    const secondGrove = mkGroveDir(secondClone);
    const second = await ensureProjectId(
      baseOpts({
        groveDir: secondGrove,
        cwd: secondClone,
        registryPath,
        unify: true,
      }),
    );
    expect(second.source).toBe("registry");
    expect(second.id).toBe(first.id);
    expect(readProjectId(secondGrove)).toBe(first.id);
  });

  test("generates new id when registry hits and --no-unify", async () => {
    const firstClone = mkClone("git@github.com:foo/bar.git");
    const firstGrove = mkGroveDir(firstClone);
    const registryPath = join(mkTmp("registry"), "projects.yaml");
    const first = await ensureProjectId(
      baseOpts({ groveDir: firstGrove, cwd: firstClone, registryPath }),
    );

    const secondClone = mkClone("https://github.com/foo/bar.git");
    const secondGrove = mkGroveDir(secondClone);
    const second = await ensureProjectId(
      baseOpts({
        groveDir: secondGrove,
        cwd: secondClone,
        registryPath,
        unify: false,
      }),
    );
    expect(second.source).toBe("generated");
    expect(second.id).not.toBe(first.id);
    expect(second.registered).toBe(false);
    // Registry unchanged — still points at first's id.
    const reg = loadRegistry(registryPath);
    expect(reg.projects["github.com/foo/bar"]?.id).toBe(first.id);
  });

  test("generates new id when registry hits and non-TTY, no flag", async () => {
    const firstClone = mkClone("git@github.com:foo/bar.git");
    const firstGrove = mkGroveDir(firstClone);
    const registryPath = join(mkTmp("registry"), "projects.yaml");
    const first = await ensureProjectId(
      baseOpts({ groveDir: firstGrove, cwd: firstClone, registryPath }),
    );

    const secondClone = mkClone("https://github.com/foo/bar.git");
    const secondGrove = mkGroveDir(secondClone);
    const second = await ensureProjectId(
      baseOpts({
        groveDir: secondGrove,
        cwd: secondClone,
        registryPath,
        isTTY: false,
      }),
    );
    expect(second.source).toBe("generated");
    expect(second.id).not.toBe(first.id);
  });

  test("is idempotent — second call on an initialized clone returns local", async () => {
    const clone = mkClone("git@github.com:foo/bar.git");
    const groveDir = mkGroveDir(clone);
    const registryPath = join(mkTmp("registry"), "projects.yaml");
    const first = await ensureProjectId(
      baseOpts({ groveDir, cwd: clone, registryPath }),
    );
    const second = await ensureProjectId(
      baseOpts({ groveDir, cwd: clone, registryPath }),
    );
    expect(second.source).toBe("local");
    expect(second.id).toBe(first.id);
  });

  test("throws on malformed local project-id", async () => {
    const clone = mkClone("git@github.com:foo/bar.git");
    const groveDir = mkGroveDir(clone);
    writeFileSync(join(groveDir, "project-id"), "garbage\n");
    const registryPath = join(mkTmp("registry"), "projects.yaml");
    await expect(
      ensureProjectId(baseOpts({ groveDir, cwd: clone, registryPath })),
    ).rejects.toThrow(/Invalid project id/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/cli/utils/ensure-project-id.test.ts`
Expected: FAIL — module `./ensure-project-id.js` not found.

- [ ] **Step 3: Write minimal implementation**

Create `src/cli/utils/ensure-project-id.ts`:

```ts
/**
 * Orchestrator: ensure a `.grove/project-id` exists on `grove init`.
 *
 * Derivation flow (authoritative, spec #288):
 *   1. Existing local file → use.
 *   2. No git origin → generate, write local, skip registry.
 *   3. Registry miss → generate, write local, register.
 *   4. Registry hit → adopt (unify) or new, per flag / TTY prompt / non-TTY default.
 */

import {
  generateProjectId,
  readProjectId,
  writeProjectId,
} from "../../core/project-id.js";
import {
  type Registry,
  type RegistryEntry,
  defaultRegistryPath,
  loadRegistry,
  lookupByOrigin,
  saveRegistry,
  upsertEntry,
} from "../../core/project-registry.js";
import { detectOriginUrl, normalizeOriginUrl } from "./origin-url.js";

export interface EnsureOpts {
  readonly groveDir: string;
  readonly cwd: string;
  readonly unify?: boolean;
  readonly isTTY?: boolean;
  readonly registryPath?: string;
  readonly now?: () => Date;
  readonly stdin?: NodeJS.ReadableStream;
  readonly stdout?: NodeJS.WritableStream;
}

export type EnsureSource = "local" | "registry" | "generated";

export interface EnsureResult {
  readonly id: string;
  readonly source: EnsureSource;
  readonly origin: string | null;
  readonly registered: boolean;
  readonly registryName: string | null;
}

function nameFromOrigin(normalized: string): string {
  // "host/owner/repo" → "owner/repo"; "host/foo" → "foo"
  const idx = normalized.indexOf("/");
  return idx === -1 ? normalized : normalized.slice(idx + 1);
}

export async function ensureProjectId(opts: EnsureOpts): Promise<EnsureResult> {
  const registryPath = opts.registryPath ?? defaultRegistryPath();
  const now = opts.now ?? (() => new Date());

  // 1. Existing local.
  const existing = readProjectId(opts.groveDir);
  if (existing != null) {
    return {
      id: existing,
      source: "local",
      origin: null,
      registered: false,
      registryName: null,
    };
  }

  // 2. Origin detection.
  const raw = detectOriginUrl(opts.cwd);
  const origin = raw ? normalizeOriginUrl(raw) : null;
  if (origin == null) {
    if (raw != null) {
      // Log unparseable URL so the user knows registry was skipped.
      process.stderr.write(
        `grove init: unrecognized origin URL format: ${raw} — registry skipped.\n`,
      );
    }
    const id = generateProjectId();
    writeProjectId(opts.groveDir, id);
    return {
      id,
      source: "generated",
      origin: null,
      registered: false,
      registryName: null,
    };
  }

  // 3. Registry lookup.
  const reg = loadRegistry(registryPath);
  const hit = lookupByOrigin(reg, origin);
  if (hit == null) {
    const id = generateProjectId();
    writeProjectId(opts.groveDir, id);
    const name = nameFromOrigin(origin);
    const entry: RegistryEntry = {
      id,
      name,
      createdAt: now().toISOString(),
    };
    saveRegistry(registryPath, upsertEntry(reg, origin, entry));
    return {
      id,
      source: "generated",
      origin,
      registered: true,
      registryName: name,
    };
  }

  // 4. Hit: decide adopt vs new.
  const decision = await decideAdopt(opts, hit);
  if (decision === "adopt") {
    writeProjectId(opts.groveDir, hit.id);
    return {
      id: hit.id,
      source: "registry",
      origin,
      registered: true,
      registryName: hit.name,
    };
  }
  const id = generateProjectId();
  writeProjectId(opts.groveDir, id);
  return {
    id,
    source: "generated",
    origin,
    registered: false,
    registryName: hit.name,
  };
}

async function decideAdopt(
  opts: EnsureOpts,
  _hit: RegistryEntry,
): Promise<"adopt" | "new"> {
  if (opts.unify === true) return "adopt";
  if (opts.unify === false) return "new";
  // Prompt is introduced in Task 10. For now, default matches non-TTY.
  return "new";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/cli/utils/ensure-project-id.test.ts`
Expected: PASS — all 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/cli/utils/ensure-project-id.ts src/cli/utils/ensure-project-id.test.ts
git commit -m "feat(cli): ensureProjectId — non-interactive derivation flow (#288)"
```

---

## Task 10: `ensureProjectId` — TTY prompt

**Files:**
- Modify: `src/cli/utils/ensure-project-id.ts`
- Modify: `src/cli/utils/ensure-project-id.test.ts`

- [ ] **Step 1: Write the failing test**

First, add `import { PassThrough } from "node:stream";` to the **top** of `src/cli/utils/ensure-project-id.test.ts` alongside the existing imports (test-file imports must be at the top of the module, not inline in a describe block).

Then append to `src/cli/utils/ensure-project-id.test.ts`:

```ts
function stdinFeeding(input: string): NodeJS.ReadableStream {
  const s = new PassThrough();
  s.end(input);
  return s;
}

function captureStdout(): { stream: NodeJS.WritableStream; text: () => string } {
  const chunks: string[] = [];
  const s = new PassThrough();
  s.on("data", (b) => chunks.push(b.toString("utf8")));
  return { stream: s, text: () => chunks.join("") };
}

describe("ensureProjectId — TTY prompt", () => {
  test("TTY + 'y\\n' adopts", async () => {
    const firstClone = mkClone("git@github.com:foo/bar.git");
    const firstGrove = mkGroveDir(firstClone);
    const registryPath = join(mkTmp("registry"), "projects.yaml");
    const first = await ensureProjectId(
      baseOpts({ groveDir: firstGrove, cwd: firstClone, registryPath }),
    );

    const secondClone = mkClone("https://github.com/foo/bar.git");
    const secondGrove = mkGroveDir(secondClone);
    const out = captureStdout();
    const second = await ensureProjectId(
      baseOpts({
        groveDir: secondGrove,
        cwd: secondClone,
        registryPath,
        isTTY: true,
        stdin: stdinFeeding("y\n"),
        stdout: out.stream,
      }),
    );
    expect(second.source).toBe("registry");
    expect(second.id).toBe(first.id);
    expect(out.text()).toMatch(/Unify\?/);
  });

  test("TTY + Enter (default Y) adopts", async () => {
    const firstClone = mkClone("git@github.com:foo/bar.git");
    const firstGrove = mkGroveDir(firstClone);
    const registryPath = join(mkTmp("registry"), "projects.yaml");
    const first = await ensureProjectId(
      baseOpts({ groveDir: firstGrove, cwd: firstClone, registryPath }),
    );

    const secondClone = mkClone("https://github.com/foo/bar.git");
    const secondGrove = mkGroveDir(secondClone);
    const second = await ensureProjectId(
      baseOpts({
        groveDir: secondGrove,
        cwd: secondClone,
        registryPath,
        isTTY: true,
        stdin: stdinFeeding("\n"),
        stdout: new PassThrough(),
      }),
    );
    expect(second.source).toBe("registry");
    expect(second.id).toBe(first.id);
  });

  test("TTY + 'n\\n' creates new", async () => {
    const firstClone = mkClone("git@github.com:foo/bar.git");
    const firstGrove = mkGroveDir(firstClone);
    const registryPath = join(mkTmp("registry"), "projects.yaml");
    const first = await ensureProjectId(
      baseOpts({ groveDir: firstGrove, cwd: firstClone, registryPath }),
    );

    const secondClone = mkClone("https://github.com/foo/bar.git");
    const secondGrove = mkGroveDir(secondClone);
    const second = await ensureProjectId(
      baseOpts({
        groveDir: secondGrove,
        cwd: secondClone,
        registryPath,
        isTTY: true,
        stdin: stdinFeeding("n\n"),
        stdout: new PassThrough(),
      }),
    );
    expect(second.source).toBe("generated");
    expect(second.id).not.toBe(first.id);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/cli/utils/ensure-project-id.test.ts`
Expected: FAIL — prompt branch not yet implemented; all three new tests default to "new" and the `registry` / `y\n` tests fail.

- [ ] **Step 3: Replace `decideAdopt` with a prompt-aware version**

In `src/cli/utils/ensure-project-id.ts`, replace the body of `decideAdopt` with:

```ts
async function decideAdopt(
  opts: EnsureOpts,
  hit: RegistryEntry,
): Promise<"adopt" | "new"> {
  if (opts.unify === true) return "adopt";
  if (opts.unify === false) return "new";
  if (!opts.isTTY) return "new";

  const stdout = opts.stdout ?? process.stdout;
  const stdin = opts.stdin ?? process.stdin;
  const prompt = `Matching project '${hit.name}' already registered (id ${hit.id}). Unify? [Y/n] `;
  stdout.write(prompt);

  const answer = await readLine(stdin);
  const trimmed = answer.trim().toLowerCase();
  if (trimmed === "" || trimmed === "y" || trimmed === "yes") return "adopt";
  return "new";
}

function readLine(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve) => {
    let buf = "";
    const onData = (chunk: Buffer | string) => {
      buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl !== -1) {
        stream.off("data", onData);
        stream.off("end", onEnd);
        resolve(buf.slice(0, nl));
      }
    };
    const onEnd = () => {
      stream.off("data", onData);
      resolve(buf);
    };
    stream.on("data", onData);
    stream.on("end", onEnd);
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/cli/utils/ensure-project-id.test.ts`
Expected: PASS — all 11 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/cli/utils/ensure-project-id.ts src/cli/utils/ensure-project-id.test.ts
git commit -m "feat(cli): ensureProjectId — interactive TTY prompt (#288)"
```

---

## Task 11: Wire `ensureProjectId` into `grove init`

**Files:**
- Modify: `src/cli/commands/init.ts`
- Modify: `src/cli/commands/init.test.ts`

- [ ] **Step 1: Write the first failing test — UUIDv4 file is created**

Append to `src/cli/commands/init.test.ts`:

```ts
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { loadRegistry } from "../../core/project-registry.js";
import { isValidProjectId } from "../../core/project-id.js";

function initGitRepo(cwd: string, origin: string | null): void {
  const run = (args: string[]) =>
    spawnSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
  run(["init", "-q"]);
  run(["config", "user.email", "t@t"]);
  run(["config", "user.name", "t"]);
  if (origin) run(["remote", "add", "origin", origin]);
}

describe("grove init — project identity (#288)", () => {
  test("creates .grove/project-id with a valid UUIDv4 on a fresh repo", async () => {
    const cwd = await createTempDir();
    initGitRepo(cwd, null);
    const registryPath = join(cwd, "test-registry.yaml");
    await executeInit(
      makeOptions({ name: "one", cwd }),
      undefined,
      { registryPath },
    );
    const id = readFileSync(join(cwd, ".grove", "project-id"), "utf8").trim();
    expect(isValidProjectId(id)).toBe(true);
    await rm(cwd, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/cli/commands/init.test.ts -t "creates .grove/project-id"`
Expected: FAIL — `executeInit` does not yet accept an options-3 argument for registry injection, and does not write `project-id`.

- [ ] **Step 3: Extend `executeInit` signature + call `ensureProjectId`**

In `src/cli/commands/init.ts`:

a) Add two new options to `InitOptions` (immutable):

```ts
export interface InitOptions {
  // ... existing fields ...
  readonly unify?: boolean;
}
```

b) Extend `parseInitArgs` `options` table:

```ts
unify: { type: "boolean" },
"no-unify": { type: "boolean" },
```

c) Inside `parseInitArgs`, after existing validations:

```ts
const unifyFlag = values.unify as boolean | undefined;
const noUnifyFlag = values["no-unify"] as boolean | undefined;
if (unifyFlag && noUnifyFlag) {
  throw new Error("--unify and --no-unify are mutually exclusive.");
}
const unify = unifyFlag === true ? true : noUnifyFlag === true ? false : undefined;
```

And include `unify` in the returned object (omit when `undefined`):

```ts
return {
  // ... existing fields ...
  ...(unify === undefined ? {} : { unify }),
};
```

d) Add an optional test hook parameter to `executeInit`:

```ts
export interface ExecuteInitTestHooks {
  readonly registryPath?: string;
  readonly isTTY?: boolean;
  readonly stdin?: NodeJS.ReadableStream;
  readonly stdout?: NodeJS.WritableStream;
  readonly now?: () => Date;
}

export async function executeInit(
  options: InitOptions,
  onProgress?: InitProgressCallback,
  hooks?: ExecuteInitTestHooks,
): Promise<{ grovePath: string; projectId: string }> {
```

e) After the `await mkdir(workspacesPath, { recursive: true });` line (step 3 of the existing flow), before step 4's SQLite init, insert (no new `progress()` call — fold this work under the existing "Creating directory structure" step so the existing step-index sequence in `init.progress.test.ts` stays stable):

```ts
const { ensureProjectId } = await import("../utils/ensure-project-id.js");
const ensureResult = await ensureProjectId({
  groveDir: grovePath,
  cwd: options.cwd,
  unify: options.unify,
  registryPath: hooks?.registryPath,
  isTTY: hooks?.isTTY ?? Boolean(process.stdout.isTTY && process.stdin.isTTY),
  stdin: hooks?.stdin,
  stdout: hooks?.stdout,
  now: hooks?.now,
});
const projectId = ensureResult.id;
```

f) After the existing `console.log(`Initialized grove '${options.name}' at ${grovePath}`);` line, add a project-id log sourced from `ensureResult`:

Emit the progress log line. `ensureResult.registryName` (populated by Task 9) carries the registry entry name (e.g. `foo/bar`), which is what the log cites — **not** `options.name`:

```ts
switch (ensureResult.source) {
  case "local":
    console.log(`project id ${projectId} (existing)`);
    break;
  case "registry":
    console.log(`project id ${projectId} (unified with ${ensureResult.registryName})`);
    break;
  case "generated":
    if (ensureResult.origin && ensureResult.registered) {
      console.log(`project id ${projectId} (new, registered as ${ensureResult.registryName})`);
    } else if (ensureResult.origin) {
      console.log(`project id ${projectId} (new, origin already owned — not registered)`);
    } else {
      console.log(`project id ${projectId} (new, no origin — not registered)`);
    }
    break;
}
```

g) Update the return:

```ts
return { grovePath, projectId };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/cli/commands/init.test.ts -t "creates .grove/project-id"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/init.ts src/cli/commands/init.test.ts
git commit -m "feat(cli): grove init writes .grove/project-id via ensureProjectId (#288)"
```

---

## Task 12: Acceptance tests — distinct clones + --unify + idempotent

**Files:**
- Modify: `src/cli/commands/init.test.ts`

- [ ] **Step 1: Write the three remaining acceptance tests**

Append to `src/cli/commands/init.test.ts`:

```ts
describe("grove init — #288 acceptance", () => {
  test("two independent clones of same origin (non-TTY) get distinct UUIDs", async () => {
    const sharedRegistry = join(await createTempDir(), "projects.yaml");

    const cloneA = await createTempDir();
    initGitRepo(cloneA, "git@github.com:foo/bar.git");
    const a = await executeInit(
      makeOptions({ name: "a", cwd: cloneA }),
      undefined,
      { registryPath: sharedRegistry, isTTY: false },
    );

    const cloneB = await createTempDir();
    initGitRepo(cloneB, "https://github.com/foo/bar.git");
    const b = await executeInit(
      makeOptions({ name: "b", cwd: cloneB }),
      undefined,
      { registryPath: sharedRegistry, isTTY: false },
    );

    expect(a.projectId).not.toBe(b.projectId);
    const reg = loadRegistry(sharedRegistry);
    expect(Object.keys(reg.projects)).toEqual(["github.com/foo/bar"]);
    expect(reg.projects["github.com/foo/bar"]?.id).toBe(a.projectId);

    await rm(cloneA, { recursive: true, force: true });
    await rm(cloneB, { recursive: true, force: true });
  });

  test("--unify merges second clone into first's id; registry stays single-entry", async () => {
    const sharedRegistry = join(await createTempDir(), "projects.yaml");

    const cloneA = await createTempDir();
    initGitRepo(cloneA, "git@github.com:foo/bar.git");
    const a = await executeInit(
      makeOptions({ name: "a", cwd: cloneA }),
      undefined,
      { registryPath: sharedRegistry },
    );

    const cloneB = await createTempDir();
    initGitRepo(cloneB, "https://github.com/foo/bar.git");
    const b = await executeInit(
      makeOptions({ name: "b", cwd: cloneB, unify: true }),
      undefined,
      { registryPath: sharedRegistry },
    );

    expect(b.projectId).toBe(a.projectId);
    const reg = loadRegistry(sharedRegistry);
    expect(Object.keys(reg.projects)).toEqual(["github.com/foo/bar"]);

    await rm(cloneA, { recursive: true, force: true });
    await rm(cloneB, { recursive: true, force: true });
  });

  test("re-running grove init leaves the project id unchanged", async () => {
    const registryPath = join(await createTempDir(), "projects.yaml");
    const cwd = await createTempDir();
    initGitRepo(cwd, "git@github.com:foo/bar.git");
    const first = await executeInit(
      makeOptions({ name: "one", cwd }),
      undefined,
      { registryPath },
    );
    const second = await executeInit(
      makeOptions({ name: "one", cwd, force: true }),
      undefined,
      { registryPath },
    );
    expect(second.projectId).toBe(first.projectId);
    await rm(cwd, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `bun test src/cli/commands/init.test.ts -t "#288 acceptance"`
Expected: PASS — three new tests pass.

- [ ] **Step 3: Run the full init test file**

Run: `bun test src/cli/commands/init.test.ts`
Expected: PASS — all prior init tests still pass (the new code path is strictly additive; the `projectId` field added to the return type is additive).

- [ ] **Step 4: Run the full test suite**

Run: `bun test`
Expected: PASS — no regressions elsewhere.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/init.test.ts
git commit -m "test(cli): #288 acceptance — distinct clones, --unify, idempotent init"
```

---

## Task 13: CLI flag help text + `--unify` / `--no-unify` mutual-exclusion test

**Files:**
- Modify: `src/cli/commands/init.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/cli/commands/init.test.ts`:

```ts
describe("parseInitArgs — unify flags", () => {
  test("--unify sets unify: true", () => {
    const opts = parseInitArgs(["--unify"]);
    expect(opts.unify).toBe(true);
  });

  test("--no-unify sets unify: false", () => {
    const opts = parseInitArgs(["--no-unify"]);
    expect(opts.unify).toBe(false);
  });

  test("neither flag leaves unify undefined", () => {
    const opts = parseInitArgs([]);
    expect(opts.unify).toBeUndefined();
  });

  test("both --unify and --no-unify is an error", () => {
    expect(() => parseInitArgs(["--unify", "--no-unify"])).toThrow(
      /mutually exclusive/,
    );
  });
});
```

- [ ] **Step 2: Run test to verify**

Run: `bun test src/cli/commands/init.test.ts -t "parseInitArgs — unify"`
Expected: PASS — parseInitArgs already handles these cases from Task 11.

- [ ] **Step 3: Commit**

```bash
git add src/cli/commands/init.test.ts
git commit -m "test(cli): --unify/--no-unify flag parsing + mutual exclusion (#288)"
```

---

## Task 14: Final verification + typecheck + lint

- [ ] **Step 1: Run the full test suite**

Run: `bun test`
Expected: PASS — no failing tests.

- [ ] **Step 2: Run typecheck**

Run: `bun run typecheck` (or the project's equivalent — check `package.json` scripts).
Expected: PASS — no type errors.

- [ ] **Step 3: Run lint / format**

Run: `bun run biome` or `bun run lint` — whichever the project exposes.
Expected: PASS — no diagnostics.

- [ ] **Step 4: Inspect the `grove init` log line manually (manual smoke, not gated)**

From a fresh tmp git repo with origin set:

```bash
cd /tmp && mkdir smoke-$$  && cd smoke-$$
git init -q && git remote add origin git@github.com:smoke/test.git
bun /path/to/grove/bin/grove.js init smoke
cat .grove/project-id
```

Expected: valid UUIDv4 printed; stdout includes `project id <uuid> (new, registered as smoke/test)`.

(Skip this step in automated CI; it is for human verification.)

- [ ] **Step 5: No additional commit needed if all steps pass clean**

If typecheck / lint required trivial fixes, commit them:

```bash
git add -u
git commit -m "chore(core,cli): typecheck + lint cleanups for project identity (#288)"
```

---

## Coverage check (spec → task map)

| Spec section / acceptance | Task |
| --- | --- |
| `readProjectId`, `writeProjectId`, `generateProjectId`, `isValidProjectId` | Tasks 1–3 |
| Registry types, `defaultRegistryPath`, `loadRegistry`, `saveRegistry`, `lookupByOrigin`, `upsertEntry` | Tasks 4–6 |
| Origin normalization rules (Q1-A table) | Task 7 |
| `detectOriginUrl` | Task 8 |
| Derivation flow (local / no-origin / miss / hit + flags / non-TTY) | Task 9 |
| TTY prompt | Task 10 |
| `grove init` wiring + progress line + `--unify` / `--no-unify` flags | Tasks 11, 13 |
| Acceptance #1: fresh repo → `.grove/project-id` is UUIDv4 | Task 11 |
| Acceptance #2: two clones of same origin → distinct UUIDs | Task 12 |
| Acceptance #3: explicit unification merges | Task 12 |
| Acceptance #4: UUID format validated | Tasks 1, 11, 12 (checked in all init paths) |
| Idempotent re-init | Task 12 |
| Full-suite green + typecheck | Task 14 |

No spec section lacks a task. No task references a symbol not defined earlier in this plan.
