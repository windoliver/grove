# Grove Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `grove diagnostics`, a local CLI command that creates a self-contained ZIP archive with redacted Grove config, logs, SQLite summaries, optional raw DB, system snapshots, and operator-primitive availability metadata for issue #277.

**Architecture:** Implement the feature as a local-only diagnostics pipeline: CLI argument parsing resolves the `.grove` directory, diagnostics collectors produce in-memory bundle entries, text entries pass through a scrubber, and a dependency-free stored-entry ZIP writer emits the archive. Keep collection modules independent and testable with temp groves and injected clock/env/system runners.

**Tech Stack:** Bun 1.3.x, TypeScript strict mode, `bun:test`, Bun SQLite (`bun:sqlite`), Node-compatible `node:fs`, `node:path`, `node:os`, `node:child_process`, no new runtime dependencies and no external `zip` command.

**Spec:** `docs/superpowers/specs/2026-05-01-grove-diagnostics-design.md`

**Issue:** [#277](https://github.com/windoliver/grove/issues/277)

---

## File Map

**Create:**
- `src/shared/zip.ts` — deterministic ZIP writer for method-0 stored entries plus CRC32.
- `src/shared/zip.test.ts` — round-trip tests by parsing local file headers.
- `src/diagnostics/redaction.ts` — text-entry detection and standard/aggressive/off redaction.
- `src/diagnostics/redaction.test.ts` — redaction behavior tests.
- `src/diagnostics/sqlite-export.ts` — table discovery, JSON table exports, recent contributions JSONL.
- `src/diagnostics/sqlite-export.test.ts` — temp SQLite tests for missing tables, row export, recent contribution ordering/cap.
- `src/diagnostics/system.ts` — best-effort process tree, disk usage, and open-FD probes.
- `src/diagnostics/system.test.ts` — injected command-runner tests for success and fallback text.
- `src/diagnostics/bundle.ts` — bundle assembly: metadata, config, logs, DB exports, operator availability, system snapshots, redaction, ZIP entry list.
- `src/diagnostics/bundle.test.ts` — temp `.grove` bundle entry tests.
- `src/cli/commands/diagnostics.ts` — CLI parser, command runner, help text.
- `src/cli/commands/diagnostics.test.ts` — parse tests and end-to-end command tests that inspect the ZIP.

**Modify:**
- `src/cli/main.ts` — register `diagnostics` command and add help text.
- `src/cli/registry.ts` — add command metadata and flags for completions.
- `src/cli/registry.test.ts` — add expected `diagnostics` flags.
- `docs/parity-matrix.md` — record CLI-only diagnostics command in parity table.

---

## Task 1: Stored ZIP Writer

**Files:**
- Create: `src/shared/zip.ts`
- Test: `src/shared/zip.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/shared/zip.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { createStoredZip, crc32 } from "./zip.js";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

interface ParsedEntry {
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly crc: number;
}

function readUInt32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] ?? 0) |
    ((bytes[offset + 1] ?? 0) << 8) |
    ((bytes[offset + 2] ?? 0) << 16) |
    ((bytes[offset + 3] ?? 0) << 24)
  ) >>> 0;
}

function readUInt16(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8)) >>> 0;
}

function parseStoredZip(bytes: Uint8Array): readonly ParsedEntry[] {
  const entries: ParsedEntry[] = [];
  let offset = 0;
  while (readUInt32(bytes, offset) === 0x04034b50) {
    const crc = readUInt32(bytes, offset + 14);
    const size = readUInt32(bytes, offset + 18);
    const nameLength = readUInt16(bytes, offset + 26);
    const extraLength = readUInt16(bytes, offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = textDecoder.decode(bytes.slice(nameStart, nameStart + nameLength));
    const data = bytes.slice(dataStart, dataStart + size);
    entries.push({ name, bytes: data, crc });
    offset = dataStart + size;
  }
  return entries;
}

describe("crc32", () => {
  test("matches the standard check value", () => {
    expect(crc32(textEncoder.encode("123456789"))).toBe(0xcbf43926);
  });
});

describe("createStoredZip", () => {
  test("round-trips multiple stored entries", () => {
    const zip = createStoredZip([
      { path: "meta.json", bytes: textEncoder.encode('{"ok":true}') },
      { path: "logs/runtime.log", bytes: textEncoder.encode("line one\nline two\n") },
    ]);

    const entries = parseStoredZip(zip);

    expect(entries.map((entry) => entry.name)).toEqual(["meta.json", "logs/runtime.log"]);
    expect(textDecoder.decode(entries[0]?.bytes)).toBe('{"ok":true}');
    expect(textDecoder.decode(entries[1]?.bytes)).toBe("line one\nline two\n");
    expect(entries[0]?.crc).toBe(crc32(textEncoder.encode('{"ok":true}')));
  });

  test("rejects duplicate paths", () => {
    expect(() =>
      createStoredZip([
        { path: "same.txt", bytes: textEncoder.encode("a") },
        { path: "same.txt", bytes: textEncoder.encode("b") },
      ]),
    ).toThrow(/duplicate zip entry/i);
  });

  test("rejects absolute and parent-relative paths", () => {
    expect(() => createStoredZip([{ path: "/abs.txt", bytes: new Uint8Array() }])).toThrow(
      /unsafe zip entry/i,
    );
    expect(() => createStoredZip([{ path: "../up.txt", bytes: new Uint8Array() }])).toThrow(
      /unsafe zip entry/i,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
/Users/tafeng/.bun/bin/bun test src/shared/zip.test.ts
```

Expected: FAIL with `Cannot find module './zip.js'`.

- [ ] **Step 3: Implement minimal ZIP writer**

Create `src/shared/zip.ts`:

```typescript
/**
 * Tiny ZIP writer for diagnostics bundles.
 *
 * Uses method 0 (stored) so Grove does not need a runtime compression
 * dependency or the external `zip` binary. Supports classic ZIP limits only.
 */

const textEncoder = new TextEncoder();
const DOS_DATE = 0x0021;
const DOS_TIME = 0x0000;
const MAX_ZIP32 = 0xffffffff;
const MAX_UINT16 = 0xffff;

export interface ZipEntryInput {
  readonly path: string;
  readonly bytes: Uint8Array;
}

interface CentralDirectoryRecord {
  readonly pathBytes: Uint8Array;
  readonly crc: number;
  readonly size: number;
  readonly localOffset: number;
}

const CRC_TABLE: readonly number[] = (() => {
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table.push(c >>> 0);
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function createStoredZip(entries: readonly ZipEntryInput[]): Uint8Array {
  const seen = new Set<string>();
  const chunks: Uint8Array[] = [];
  const centralRecords: CentralDirectoryRecord[] = [];
  let offset = 0;

  for (const entry of entries) {
    validateEntryPath(entry.path);
    if (seen.has(entry.path)) {
      throw new Error(`duplicate zip entry path: ${entry.path}`);
    }
    seen.add(entry.path);

    const pathBytes = textEncoder.encode(entry.path);
    if (pathBytes.length > MAX_UINT16) {
      throw new Error(`zip entry path is too long: ${entry.path}`);
    }
    if (entry.bytes.length > MAX_ZIP32) {
      throw new Error(`zip entry exceeds ZIP32 size limit: ${entry.path}`);
    }
    if (offset > MAX_ZIP32) {
      throw new Error("zip archive exceeds ZIP32 offset limit; retry with --exclude-db");
    }

    const crc = crc32(entry.bytes);
    const local = new Uint8Array(30 + pathBytes.length);
    const view = new DataView(local.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 0x0800, true);
    view.setUint16(8, 0, true);
    view.setUint16(10, DOS_TIME, true);
    view.setUint16(12, DOS_DATE, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, entry.bytes.length, true);
    view.setUint32(22, entry.bytes.length, true);
    view.setUint16(26, pathBytes.length, true);
    view.setUint16(28, 0, true);
    local.set(pathBytes, 30);

    chunks.push(local, entry.bytes);
    centralRecords.push({ pathBytes, crc, size: entry.bytes.length, localOffset: offset });
    offset += local.length + entry.bytes.length;
  }

  const centralStart = offset;
  for (const record of centralRecords) {
    const central = new Uint8Array(46 + record.pathBytes.length);
    const view = new DataView(central.buffer);
    view.setUint32(0, 0x02014b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 20, true);
    view.setUint16(8, 0x0800, true);
    view.setUint16(10, 0, true);
    view.setUint16(12, DOS_TIME, true);
    view.setUint16(14, DOS_DATE, true);
    view.setUint32(16, record.crc, true);
    view.setUint32(20, record.size, true);
    view.setUint32(24, record.size, true);
    view.setUint16(28, record.pathBytes.length, true);
    view.setUint16(30, 0, true);
    view.setUint16(32, 0, true);
    view.setUint16(34, 0, true);
    view.setUint16(36, 0, true);
    view.setUint32(38, 0, true);
    view.setUint32(42, record.localOffset, true);
    central.set(record.pathBytes, 46);
    chunks.push(central);
    offset += central.length;
  }

  const centralSize = offset - centralStart;
  if (centralRecords.length > MAX_UINT16 || centralStart > MAX_ZIP32 || centralSize > MAX_ZIP32) {
    throw new Error("zip archive exceeds ZIP32 central directory limit; retry with --exclude-db");
  }

  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(4, 0, true);
  eocdView.setUint16(6, 0, true);
  eocdView.setUint16(8, centralRecords.length, true);
  eocdView.setUint16(10, centralRecords.length, true);
  eocdView.setUint32(12, centralSize, true);
  eocdView.setUint32(16, centralStart, true);
  eocdView.setUint16(20, 0, true);
  chunks.push(eocd);
  offset += eocd.length;

  const out = new Uint8Array(offset);
  let cursor = 0;
  for (const chunk of chunks) {
    out.set(chunk, cursor);
    cursor += chunk.length;
  }
  return out;
}

function validateEntryPath(path: string): void {
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.startsWith("\\") ||
    path.includes("..") ||
    path.includes("\\")
  ) {
    throw new Error(`unsafe zip entry path: ${path}`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
/Users/tafeng/.bun/bin/bun test src/shared/zip.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/zip.ts src/shared/zip.test.ts
git commit -m "feat(shared): add dependency-free diagnostics zip writer"
```

---

## Task 2: Text Redaction

**Files:**
- Create: `src/diagnostics/redaction.ts`
- Test: `src/diagnostics/redaction.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/diagnostics/redaction.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { isTextEntryPath, redactText } from "./redaction.js";

describe("isTextEntryPath", () => {
  test("classifies diagnostics text files", () => {
    expect(isTextEntryPath("meta.json")).toBe(true);
    expect(isTextEntryPath("db/contributions-recent.jsonl")).toBe(true);
    expect(isTextEntryPath("logs/grove-runtime.log")).toBe(true);
    expect(isTextEntryPath("system/open-fds.txt")).toBe(true);
    expect(isTextEntryPath("README.md")).toBe(true);
    expect(isTextEntryPath("db/grove.db")).toBe(false);
  });
});

describe("redactText", () => {
  test("standard mode scrubs API keys, home paths, emails, and sensitive query values", () => {
    const input = [
      "OPENAI_API_KEY=sk-test-1234567890abcdef",
      "path=/Users/tafeng/project/.grove",
      "email=user@example.com",
      "url=https://example.test/callback?token=secret&ok=1&key=abc",
    ].join("\n");

    const redacted = redactText(input, {
      mode: "standard",
      homeDir: "/Users/tafeng",
      secretEnvKeys: ["OPENAI_API_KEY"],
    });

    expect(redacted).toContain("OPENAI_API_KEY=<redacted>");
    expect(redacted).toContain("path=~/project/.grove");
    expect(redacted).toContain("email=<redacted>");
    expect(redacted).toContain("token=<redacted>");
    expect(redacted).toContain("key=<redacted>");
    expect(redacted).toContain("ok=1");
  });

  test("aggressive mode scrubs bearer-like tokens, non-home paths, and private key blocks", () => {
    const input = [
      "Authorization: Bearer abcdef1234567890abcdef1234567890",
      "other=/private/tmp/grove-test",
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "abcdef",
      "-----END OPENSSH PRIVATE KEY-----",
    ].join("\n");

    const redacted = redactText(input, {
      mode: "aggressive",
      homeDir: "/Users/tafeng",
      secretEnvKeys: [],
    });

    expect(redacted).toContain("Authorization: Bearer <redacted>");
    expect(redacted).toContain("other=<redacted-path>");
    expect(redacted).toContain("-----BEGIN OPENSSH PRIVATE KEY-----");
    expect(redacted).toContain("<redacted-private-key>");
    expect(redacted).toContain("-----END OPENSSH PRIVATE KEY-----");
  });

  test("off mode preserves text", () => {
    const input = "EMAIL=user@example.com\nTOKEN=secret";
    expect(redactText(input, { mode: "off", homeDir: "/Users/tafeng", secretEnvKeys: [] })).toBe(
      input,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
/Users/tafeng/.bun/bin/bun test src/diagnostics/redaction.test.ts
```

Expected: FAIL with `Cannot find module './redaction.js'`.

- [ ] **Step 3: Implement redaction**

Create `src/diagnostics/redaction.ts`:

```typescript
export type ScrubMode = "standard" | "aggressive" | "off";

export interface RedactOptions {
  readonly mode: ScrubMode;
  readonly homeDir: string;
  readonly secretEnvKeys: readonly string[];
}

const TEXT_EXTENSIONS = new Set([".json", ".jsonl", ".md", ".txt", ".log", ".yaml", ".yml"]);

export function isTextEntryPath(path: string): boolean {
  if (path === "README.md") return true;
  const dot = path.lastIndexOf(".");
  if (dot === -1) return !path.startsWith("db/");
  return TEXT_EXTENSIONS.has(path.slice(dot));
}

export function redactText(input: string, options: RedactOptions): string {
  if (options.mode === "off") return input;

  let out = input;
  out = redactSecretAssignments(out, options.secretEnvKeys);
  out = redactApiKeyAssignments(out);
  out = redactHomeDir(out, options.homeDir);
  out = redactEmails(out);
  out = redactSensitiveQueryParams(out);

  if (options.mode === "aggressive") {
    out = redactPrivateKeys(out);
    out = out.replace(/(Authorization:\s*Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, "$1<redacted>");
    out = out.replace(/(?<==)\/(?:private|tmp|var|opt|Users)\/[^\s"']+/g, "<redacted-path>");
  }

  return out;
}

function redactSecretAssignments(input: string, keys: readonly string[]): string {
  let out = input;
  for (const key of keys) {
    const escaped = escapeRegExp(key);
    out = out.replace(new RegExp(`(${escaped}\\s*[=:]\\s*)[^\\s,}"']+`, "g"), "$1<redacted>");
  }
  return out;
}

function redactApiKeyAssignments(input: string): string {
  return input.replace(
    /((?:API[_-]?KEY|ACCESS[_-]?TOKEN|SECRET|PASSWORD|TOKEN)\s*[=:]\s*)[^\s,}"']+/gi,
    "$1<redacted>",
  );
}

function redactHomeDir(input: string, homeDir: string): string {
  if (homeDir.length === 0) return input;
  return input.replaceAll(homeDir, "~");
}

function redactEmails(input: string): string {
  return input.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "<redacted>");
}

function redactSensitiveQueryParams(input: string): string {
  return input.replace(/([?&](?:token|key|api_key|access_token)=)[^&#\s"']+/gi, "$1<redacted>");
}

function redactPrivateKeys(input: string): string {
  return input.replace(
    /(-----BEGIN [A-Z ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----)/g,
    "$1\n<redacted-private-key>\n$2",
  );
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
/Users/tafeng/.bun/bin/bun test src/diagnostics/redaction.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/diagnostics/redaction.ts src/diagnostics/redaction.test.ts
git commit -m "feat(diagnostics): add bundle text redaction"
```

---

## Task 3: SQLite Summary Export

**Files:**
- Create: `src/diagnostics/sqlite-export.ts`
- Test: `src/diagnostics/sqlite-export.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/diagnostics/sqlite-export.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeContribution } from "../core/test-helpers.js";
import { initSqliteDb, SqliteContributionStore } from "../local/sqlite-store.js";
import { exportSqliteSummaries } from "./sqlite-export.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "grove-diagnostics-db-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("exportSqliteSummaries", () => {
  test("exports newest contributions first and caps at requested limit", async () => {
    const dbPath = join(dir, "grove.db");
    const db = initSqliteDb(dbPath);
    const store = new SqliteContributionStore(db);
    try {
      for (let i = 0; i < 3; i++) {
        await store.put(
          makeContribution({
            summary: `item-${i}`,
            createdAt: `2026-05-0${i + 1}T00:00:00.000Z`,
          }),
        );
      }
    } finally {
      store.close();
    }

    const result = exportSqliteSummaries(dbPath, { recentContributionLimit: 2 });
    const jsonl = new TextDecoder().decode(
      result.entries.find((entry) => entry.path === "db/contributions-recent.jsonl")?.bytes,
    );

    const lines = jsonl.trim().split("\n").map((line) => JSON.parse(line) as { summary: string });
    expect(lines.map((line) => line.summary)).toEqual(["item-2", "item-1"]);
    expect(result.manifest.tables.contributions?.rowCount).toBe(3);
  });

  test("records missing optional tables without throwing", async () => {
    const dbPath = join(dir, "minimal.db");
    const db = initSqliteDb(dbPath);
    db.run("DROP TABLE IF EXISTS outcomes");
    db.close();

    const result = exportSqliteSummaries(dbPath, { recentContributionLimit: 500 });

    expect(result.manifest.tables.outcomes?.present).toBe(false);
    expect(result.entries.some((entry) => entry.path === "db/table-manifest.json")).toBe(true);
  });

  test("redacts idempotency result payload to table-level metadata only", () => {
    const dbPath = join(dir, "keys.db");
    const db = initSqliteDb(dbPath);
    db.run(
      "INSERT INTO idempotency_keys (cache_key, fingerprint, result_json, status, stored_at) VALUES (?, ?, ?, ?, ?)",
      ["key-1", "fp-secret", '{"token":"secret"}', "committed", 123],
    );
    db.close();

    const result = exportSqliteSummaries(dbPath, { recentContributionLimit: 500 });
    const idempotency = new TextDecoder().decode(
      result.entries.find((entry) => entry.path === "db/idempotency.json")?.bytes,
    );

    expect(idempotency).toContain("key-1");
    expect(idempotency).toContain("committed");
    expect(idempotency).not.toContain("fp-secret");
    expect(idempotency).not.toContain("secret");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
/Users/tafeng/.bun/bin/bun test src/diagnostics/sqlite-export.test.ts
```

Expected: FAIL with `Cannot find module './sqlite-export.js'`.

- [ ] **Step 3: Implement SQLite export**

Create `src/diagnostics/sqlite-export.ts` with these exported types and functions:

```typescript
import { Database } from "bun:sqlite";

export interface DiagnosticEntry {
  readonly path: string;
  readonly bytes: Uint8Array;
}

export interface TableManifestEntry {
  readonly present: boolean;
  readonly rowCount: number;
  readonly exportedPath?: string | undefined;
  readonly warning?: string | undefined;
}

export interface SqliteExportManifest {
  readonly tables: Readonly<Record<string, TableManifestEntry>>;
}

export interface SqliteExportOptions {
  readonly recentContributionLimit: number;
}

export interface SqliteExportResult {
  readonly entries: readonly DiagnosticEntry[];
  readonly manifest: SqliteExportManifest;
}

const textEncoder = new TextEncoder();

const TABLE_EXPORTS: Readonly<Record<string, readonly string[] | "*">> = {
  sessions: "*",
  claims: "*",
  handoffs: "*",
  outcomes: "*",
  bounties: "*",
  rewards: "*",
  workspaces: "*",
  idempotency_keys: ["cache_key", "status", "stored_at"],
  project_settings: "*",
};

const TABLE_PATHS: Readonly<Record<string, string>> = {
  sessions: "db/sessions.json",
  claims: "db/claims.json",
  handoffs: "db/handoffs.json",
  outcomes: "db/outcomes.json",
  bounties: "db/bounties.json",
  rewards: "db/rewards.json",
  workspaces: "db/workspaces.json",
  idempotency_keys: "db/idempotency.json",
  project_settings: "config/grove-settings.json",
};
```

Implement `exportSqliteSummaries(dbPath, options)` so it:

- opens `new Database(dbPath, { readonly: true })`
- exports `db/contributions-recent.jsonl` by selecting `manifest_json` from
  `contributions ORDER BY created_at DESC LIMIT ?`
- discovers each table with `sqlite_master`
- counts rows with `SELECT COUNT(*) as count FROM ${table}`
- exports rows as pretty JSON arrays using selected columns
- writes `db/table-manifest.json`
- always closes the DB in `finally`

Use exact helper names:

```typescript
export function exportSqliteSummaries(
  dbPath: string,
  options: SqliteExportOptions,
): SqliteExportResult;

function tableExists(db: Database, tableName: string): boolean;

function countRows(db: Database, tableName: string): number;

function exportTableRows(
  db: Database,
  tableName: string,
  columns: readonly string[] | "*",
): readonly Record<string, unknown>[];
```

Keep identifier interpolation safe by using only constant table names from
`TABLE_EXPORTS`; do not accept user-provided table names.

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
/Users/tafeng/.bun/bin/bun test src/diagnostics/sqlite-export.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/diagnostics/sqlite-export.ts src/diagnostics/sqlite-export.test.ts
git commit -m "feat(diagnostics): export sqlite summary files"
```

---

## Task 4: System Probe Collector

**Files:**
- Create: `src/diagnostics/system.ts`
- Test: `src/diagnostics/system.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/diagnostics/system.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { collectSystemSnapshots } from "./system.js";

describe("collectSystemSnapshots", () => {
  test("uses runner output for process, disk, and fd snapshots", async () => {
    const commands: string[] = [];
    const entries = await collectSystemSnapshots({
      projectRoot: "/Users/tafeng/project",
      groveDir: "/Users/tafeng/project/.grove",
      runner: async (cmd) => {
        commands.push(cmd);
        return { ok: true, stdout: `out:${cmd}`, stderr: "" };
      },
    });

    expect(entries.map((entry) => entry.path)).toEqual([
      "system/process-tree.txt",
      "system/disk-usage.txt",
      "system/open-fds.txt",
    ]);
    expect(new TextDecoder().decode(entries[0]?.bytes)).toContain("out:");
    expect(commands.length).toBe(3);
  });

  test("writes fallback text when a probe fails", async () => {
    const entries = await collectSystemSnapshots({
      projectRoot: "/project",
      groveDir: "/project/.grove",
      runner: async () => ({ ok: false, stdout: "", stderr: "missing command" }),
    });

    const text = new TextDecoder().decode(entries[0]?.bytes);
    expect(text).toContain("Probe failed");
    expect(text).toContain("missing command");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
/Users/tafeng/.bun/bin/bun test src/diagnostics/system.test.ts
```

Expected: FAIL with `Cannot find module './system.js'`.

- [ ] **Step 3: Implement system probes**

Create `src/diagnostics/system.ts`:

```typescript
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DiagnosticEntry } from "./sqlite-export.js";

const execFileAsync = promisify(execFile);
const textEncoder = new TextEncoder();

export interface ProbeResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

export type ProbeRunner = (command: string) => Promise<ProbeResult>;

export interface SystemSnapshotOptions {
  readonly projectRoot: string;
  readonly groveDir: string;
  readonly runner?: ProbeRunner | undefined;
}

export async function collectSystemSnapshots(
  options: SystemSnapshotOptions,
): Promise<readonly DiagnosticEntry[]> {
  const runner = options.runner ?? defaultRunner;
  const specs = [
    { path: "system/process-tree.txt", command: "ps -axo pid,ppid,comm,args" },
    { path: "system/disk-usage.txt", command: `du -sh ${shellQuote(options.groveDir)} ${shellQuote(options.projectRoot)}` },
    { path: "system/open-fds.txt", command: "lsof -nP | grep -E 'grove|bun|codex|claude|nexus' || true" },
  ] as const;

  const entries: DiagnosticEntry[] = [];
  for (const spec of specs) {
    const result = await runner(spec.command);
    const content = result.ok
      ? result.stdout
      : `Probe failed\nCommand: ${spec.command}\nError: ${result.stderr || "unknown error"}\n`;
    entries.push({ path: spec.path, bytes: textEncoder.encode(content) });
  }
  return entries;
}

async function defaultRunner(command: string): Promise<ProbeResult> {
  try {
    const { stdout, stderr } = await execFileAsync("/bin/sh", ["-lc", command], {
      maxBuffer: 1024 * 1024,
    });
    return { ok: true, stdout, stderr };
  } catch (err) {
    const error = err as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? error.message ?? String(err),
    };
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
/Users/tafeng/.bun/bin/bun test src/diagnostics/system.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/diagnostics/system.ts src/diagnostics/system.test.ts
git commit -m "feat(diagnostics): collect system snapshots"
```

---

## Task 5: Bundle Assembly

**Files:**
- Create: `src/diagnostics/bundle.ts`
- Test: `src/diagnostics/bundle.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/diagnostics/bundle.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeContribution } from "../core/test-helpers.js";
import { initSqliteDb, SqliteContributionStore } from "../local/sqlite-store.js";
import { buildDiagnosticsEntries } from "./bundle.js";

let projectRoot: string;
let groveDir: string;

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), "grove-diagnostics-bundle-"));
  groveDir = join(projectRoot, ".grove");
  await mkdir(join(groveDir, "agent-logs", "sess-1"), { recursive: true });
  await writeFile(join(projectRoot, "GROVE.md"), "# Test Grove\n");
  await writeFile(join(groveDir, "agent-logs", "sess-1", "coder.jsonl"), "user@example.com\n");

  const db = initSqliteDb(join(groveDir, "grove.db"));
  const store = new SqliteContributionStore(db);
  await store.put(makeContribution({ summary: "bundle contribution" }));
  store.close();
});

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true });
});

describe("buildDiagnosticsEntries", () => {
  test("builds metadata, config, logs, db summaries, availability, and system entries", async () => {
    const result = await buildDiagnosticsEntries({
      projectRoot,
      groveDir,
      packageVersion: "0.1.0",
      generatedAt: "2026-05-02T00:00:00.000Z",
      scrubMode: "standard",
      excludeDb: true,
      env: { GROVE_AGENT_ID: "agent-1", HOME: "/Users/tafeng" },
      homeDir: "/Users/tafeng",
      systemRunner: async () => ({ ok: true, stdout: "system ok\n", stderr: "" }),
    });

    const paths = result.entries.map((entry) => entry.path).sort();
    expect(paths).toContain("meta.json");
    expect(paths).toContain("README.md");
    expect(paths).toContain("config/GROVE.md");
    expect(paths).toContain("config/env.redacted.json");
    expect(paths).toContain("logs/manifest.json");
    expect(paths).toContain("logs/agent-logs/sess-1/coder.jsonl");
    expect(paths).toContain("db/contributions-recent.jsonl");
    expect(paths).toContain("operator-primitives/availability.json");
    expect(paths).toContain("system/process-tree.txt");
    expect(paths).not.toContain("db/grove.db");

    const logText = new TextDecoder().decode(
      result.entries.find((entry) => entry.path === "logs/agent-logs/sess-1/coder.jsonl")?.bytes,
    );
    expect(logText).toContain("<redacted>");
  });

  test("includes raw database when excludeDb is false", async () => {
    const result = await buildDiagnosticsEntries({
      projectRoot,
      groveDir,
      packageVersion: "0.1.0",
      generatedAt: "2026-05-02T00:00:00.000Z",
      scrubMode: "standard",
      excludeDb: false,
      env: {},
      homeDir: "/Users/tafeng",
      systemRunner: async () => ({ ok: true, stdout: "system ok\n", stderr: "" }),
    });

    expect(result.entries.some((entry) => entry.path === "db/grove.db")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
/Users/tafeng/.bun/bin/bun test src/diagnostics/bundle.test.ts
```

Expected: FAIL with `Cannot find module './bundle.js'`.

- [ ] **Step 3: Implement bundle assembly**

Create `src/diagnostics/bundle.ts` with:

```typescript
import { existsSync } from "node:fs";
import { cp, readdir, readFile, stat } from "node:fs/promises";
import { arch, cpus, freemem, homedir, platform, release, totalmem } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { collectSystemSnapshots, type ProbeRunner } from "./system.js";
import { isTextEntryPath, redactText, type ScrubMode } from "./redaction.js";
import {
  exportSqliteSummaries,
  type DiagnosticEntry,
  type SqliteExportManifest,
} from "./sqlite-export.js";

const textEncoder = new TextEncoder();

export interface BuildDiagnosticsEntriesOptions {
  readonly projectRoot: string;
  readonly groveDir: string;
  readonly packageVersion: string;
  readonly generatedAt: string;
  readonly scrubMode: ScrubMode;
  readonly excludeDb: boolean;
  readonly slot?: string | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homeDir?: string | undefined;
  readonly systemRunner?: ProbeRunner | undefined;
}

export interface DiagnosticsEntriesResult {
  readonly entries: readonly DiagnosticEntry[];
  readonly warnings: readonly string[];
  readonly sqliteManifest: SqliteExportManifest;
}
```

Implement `buildDiagnosticsEntries(options)` so it:

- collects warnings in an array
- adds `config/GROVE.md` from `projectRoot/GROVE.md` when it exists
- adds redacted `config/env.redacted.json` through an `allowedEnv` helper
- adds log files from `.grove/agent-logs`, preserving relative path under
  `logs/agent-logs`
- adds `logs/manifest.json` with included, skipped, missing, and warnings arrays
- adds SQLite summaries from `exportSqliteSummaries`
- adds `db/grove.db` bytes when `excludeDb` is false
- adds `operator-primitives/availability.json` with the statuses from the design
- adds system entries from `collectSystemSnapshots`
- adds `meta.json` and `README.md`
- redacts text entries with `redactText` unless the path is `db/grove.db`
- returns entries sorted by `path`

Use these helper names:

```typescript
function jsonEntry(path: string, value: unknown): DiagnosticEntry;

function textEntry(path: string, value: string): DiagnosticEntry;

async function collectLogEntries(
  groveDir: string,
  slot: string | undefined,
): Promise<{ readonly entries: readonly DiagnosticEntry[]; readonly manifest: unknown }>;

function operatorAvailability(): readonly Record<string, unknown>[];

function buildReadme(scrubMode: ScrubMode, excludeDb: boolean): string;
```

For `allowedEnv`, include keys when:

- key starts with `GROVE_`
- key starts with `BUN_`
- key is one of `PATH`, `SHELL`, `TERM`, `HOME`, `USER`, `TMPDIR`, `CI`, `GITHUB_ACTIONS`

Set `secretEnvKeys` for redaction to keys matching
`/(TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY|PRIVATE_KEY)/i`.

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
/Users/tafeng/.bun/bin/bun test src/diagnostics/bundle.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/diagnostics/bundle.ts src/diagnostics/bundle.test.ts
git commit -m "feat(diagnostics): assemble diagnostics bundle entries"
```

---

## Task 6: CLI Command

**Files:**
- Create: `src/cli/commands/diagnostics.ts`
- Test: `src/cli/commands/diagnostics.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/cli/commands/diagnostics.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initSqliteDb } from "../../local/sqlite-store.js";
import { parseDiagnosticsArgs, runDiagnostics } from "./diagnostics.js";

let projectRoot: string;
let groveDir: string;

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), "grove-diagnostics-cli-"));
  groveDir = join(projectRoot, ".grove");
  await mkdir(groveDir, { recursive: true });
  const db = initSqliteDb(join(groveDir, "grove.db"));
  db.close();
});

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true });
});

describe("parseDiagnosticsArgs", () => {
  test("parses defaults", () => {
    const opts = parseDiagnosticsArgs([]);
    expect(opts.excludeDb).toBe(false);
    expect(opts.scrubMode).toBe("standard");
    expect(opts.slot).toBeUndefined();
    expect(opts.out).toBeUndefined();
  });

  test("parses all flags", () => {
    const opts = parseDiagnosticsArgs([
      "--exclude-db",
      "--scrub",
      "aggressive",
      "--slot",
      "slot-1",
      "--out",
      "bundle.zip",
    ]);
    expect(opts.excludeDb).toBe(true);
    expect(opts.scrubMode).toBe("aggressive");
    expect(opts.slot).toBe("slot-1");
    expect(opts.out).toBe("bundle.zip");
  });

  test("rejects invalid scrub mode", () => {
    expect(() => parseDiagnosticsArgs(["--scrub", "maximum"])).toThrow(/Invalid scrub mode/);
  });
});

describe("runDiagnostics", () => {
  test("writes a diagnostics zip to explicit output path", async () => {
    const out = join(projectRoot, "diag.zip");
    const logs: string[] = [];

    await runDiagnostics(
      { excludeDb: true, scrubMode: "standard", out },
      {
        cwd: projectRoot,
        groveOverride: undefined,
        env: { HOME: "/Users/tafeng" },
        stdout: (line) => logs.push(line),
        generatedAt: "2026-05-02T00:00:00.000Z",
        systemRunner: async () => ({ ok: true, stdout: "system ok\n", stderr: "" }),
      },
    );

    expect(existsSync(out)).toBe(true);
    expect(logs.join("\n")).toContain(out);
  });

  test("default output path uses timestamp in cwd", async () => {
    const logs: string[] = [];
    await runDiagnostics(
      { excludeDb: true, scrubMode: "standard" },
      {
        cwd: projectRoot,
        env: {},
        stdout: (line) => logs.push(line),
        generatedAt: "2026-05-02T12:30:00.000Z",
        systemRunner: async () => ({ ok: true, stdout: "system ok\n", stderr: "" }),
      },
    );

    expect(existsSync(join(projectRoot, "grove-diagnostics-2026-05-02T12-30-00Z.zip"))).toBe(
      true,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
/Users/tafeng/.bun/bin/bun test src/cli/commands/diagnostics.test.ts
```

Expected: FAIL with `Cannot find module './diagnostics.js'`.

- [ ] **Step 3: Implement command**

Create `src/cli/commands/diagnostics.ts` with:

```typescript
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { buildDiagnosticsEntries } from "../../diagnostics/bundle.js";
import type { ProbeRunner } from "../../diagnostics/system.js";
import type { ScrubMode } from "../../diagnostics/redaction.js";
import { createStoredZip } from "../../shared/zip.js";
import { UsageError } from "../errors.js";
import { findGroveDir, resolveGroveDir } from "../utils/grove-dir.js";

export interface DiagnosticsOptions {
  readonly excludeDb: boolean;
  readonly scrubMode: ScrubMode;
  readonly slot?: string | undefined;
  readonly out?: string | undefined;
}

export interface RunDiagnosticsDeps {
  readonly cwd: string;
  readonly groveOverride?: string | undefined;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  readonly stdout?: (line: string) => void;
  readonly generatedAt?: string | undefined;
  readonly systemRunner?: ProbeRunner | undefined;
}
```

Implement:

```typescript
export function parseDiagnosticsArgs(argv: readonly string[]): DiagnosticsOptions;

export async function handleDiagnostics(
  args: readonly string[],
  groveOverride?: string,
): Promise<void>;

export async function runDiagnostics(
  options: DiagnosticsOptions,
  deps: RunDiagnosticsDeps,
): Promise<void>;
```

Behavior:

- `parseDiagnosticsArgs` supports `--exclude-db`, `--scrub`, `--slot`, `--out`,
  `--help`, and `-h`.
- invalid `--scrub` throws `UsageError("Invalid scrub mode: '<value>'. Must be one of: standard, aggressive, off.")`
- `handleDiagnostics` parses args then calls `runDiagnostics` with
  `process.cwd()`, `process.env`, `console.log`, and the global grove override.
- `runDiagnostics` resolves the grove via `groveOverride` or `findGroveDir(cwd)`.
  The project root is `resolve(groveDir, "..")`.
- default output is
  `join(cwd, "grove-diagnostics-<timestamp>.zip")`, where colons and
  milliseconds are removed: `2026-05-02T12-30-00Z`.
- writes parent directories with `mkdir(dirname(out), { recursive: true })`.
- writes ZIP bytes from `createStoredZip(result.entries)`.
- prints:

```text
Diagnostics bundle written: /absolute/path/bundle.zip
Entries: <count>
Warnings: <count>
```

Help text:

```text
grove diagnostics — create a diagnostics ZIP for bug reports

Usage:
  grove diagnostics [--exclude-db] [--scrub standard|aggressive|off] [--slot <id>] [--out <path>]
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
/Users/tafeng/.bun/bin/bun test src/cli/commands/diagnostics.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/diagnostics.ts src/cli/commands/diagnostics.test.ts
git commit -m "feat(cli): add grove diagnostics command"
```

---

## Task 7: CLI Registration, Completions, And Parity Docs

**Files:**
- Modify: `src/cli/main.ts`
- Modify: `src/cli/registry.ts`
- Modify: `src/cli/registry.test.ts`
- Modify: `docs/parity-matrix.md`

- [ ] **Step 1: Write the failing registry test**

Modify `src/cli/registry.test.ts` in the `expectedFlags` object:

```typescript
      diagnostics: ["exclude-db", "scrub", "slot", "out", "help"],
```

Run:

```bash
/Users/tafeng/.bun/bin/bun test src/cli/registry.test.ts
```

Expected: FAIL because `diagnostics` is missing from `COMMANDS` and `main.ts`.

- [ ] **Step 2: Register command metadata**

Add to `COMMANDS` in `src/cli/registry.ts` near other operator commands:

```typescript
  {
    name: "diagnostics",
    description: "Create a diagnostics ZIP for bug reports",
    flags: ["exclude-db", "scrub", "slot", "out", "help"],
  },
```

- [ ] **Step 3: Register dispatcher**

Add to `buildCommands` in `src/cli/main.ts` near `status` and `completions`:

```typescript
    {
      name: "diagnostics",
      description: "Create a diagnostics ZIP for bug reports",
      needsStore: false,
      handler: async (args) => {
        const { handleDiagnostics } = await import("./commands/diagnostics.js");
        await handleDiagnostics(args, groveOverride);
      },
    },
```

- [ ] **Step 4: Add help text**

Add to the `Advanced:` section in `printUsage()`:

```text
  grove diagnostics [--out <path>]    Create a diagnostics ZIP for bug reports
```

- [ ] **Step 5: Update parity docs**

In `docs/parity-matrix.md`, add a row to the CLI command matrix:

```markdown
| diagnostics | Y | N | N | N | local CLI snapshot bundle |
```

Use the same column count and ordering already present in the file.

- [ ] **Step 6: Run registry and completions tests**

Run:

```bash
/Users/tafeng/.bun/bin/bun test src/cli/registry.test.ts src/cli/commands/completions.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/cli/main.ts src/cli/registry.ts src/cli/registry.test.ts docs/parity-matrix.md
git commit -m "feat(cli): register diagnostics command"
```

---

## Task 8: End-To-End Diagnostics Bundle Test

**Files:**
- Modify: `src/cli/commands/diagnostics.test.ts`

- [ ] **Step 1: Add failing ZIP content test**

Append to `src/cli/commands/diagnostics.test.ts`:

```typescript
function readUInt32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] ?? 0) |
    ((bytes[offset + 1] ?? 0) << 8) |
    ((bytes[offset + 2] ?? 0) << 16) |
    ((bytes[offset + 3] ?? 0) << 24)
  ) >>> 0;
}

function readUInt16(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8)) >>> 0;
}

function zipEntryNames(bytes: Uint8Array): readonly string[] {
  const names: string[] = [];
  const decoder = new TextDecoder();
  let offset = 0;
  while (readUInt32(bytes, offset) === 0x04034b50) {
    const size = readUInt32(bytes, offset + 18);
    const nameLength = readUInt16(bytes, offset + 26);
    const extraLength = readUInt16(bytes, offset + 28);
    const nameStart = offset + 30;
    names.push(decoder.decode(bytes.slice(nameStart, nameStart + nameLength)));
    offset = nameStart + nameLength + extraLength + size;
  }
  return names;
}

test("written zip contains expected diagnostics entries", async () => {
  const out = join(projectRoot, "diag-full.zip");
  await runDiagnostics(
    { excludeDb: false, scrubMode: "standard", out },
    {
      cwd: projectRoot,
      env: { HOME: "/Users/tafeng", GROVE_AGENT_ID: "agent-1" },
      generatedAt: "2026-05-02T00:00:00.000Z",
      systemRunner: async () => ({ ok: true, stdout: "system ok\n", stderr: "" }),
    },
  );

  const bytes = new Uint8Array(await Bun.file(out).arrayBuffer());
  const names = zipEntryNames(bytes);

  expect(names).toContain("meta.json");
  expect(names).toContain("README.md");
  expect(names).toContain("db/grove.db");
  expect(names).toContain("db/contributions-recent.jsonl");
  expect(names).toContain("operator-primitives/availability.json");
  expect(names).toContain("system/process-tree.txt");
});
```

- [ ] **Step 2: Run test to verify it fails if bundle entries are incomplete**

Run:

```bash
/Users/tafeng/.bun/bin/bun test src/cli/commands/diagnostics.test.ts
```

Expected: FAIL if any required entry is missing. If it passes immediately
because previous tasks already satisfy it, keep the test and continue.

- [ ] **Step 3: Fix missing entries in the narrowest module**

If entries are missing:

- Missing ZIP path: fix `src/diagnostics/bundle.ts`.
- Missing raw DB only: fix `runDiagnostics` option forwarding or
  `buildDiagnosticsEntries` raw DB branch.
- ZIP parser mismatch only: fix `src/shared/zip.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
/Users/tafeng/.bun/bin/bun test src/cli/commands/diagnostics.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/diagnostics.test.ts src/diagnostics/bundle.ts src/shared/zip.ts src/cli/commands/diagnostics.ts
git commit -m "test(cli): verify diagnostics zip contents"
```

---

## Task 9: Full Verification

**Files:**
- No planned code changes.

- [ ] **Step 1: Run focused diagnostics tests**

Run:

```bash
/Users/tafeng/.bun/bin/bun test \
  src/shared/zip.test.ts \
  src/diagnostics/redaction.test.ts \
  src/diagnostics/sqlite-export.test.ts \
  src/diagnostics/system.test.ts \
  src/diagnostics/bundle.test.ts \
  src/cli/commands/diagnostics.test.ts \
  src/cli/registry.test.ts \
  src/cli/commands/completions.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run typecheck**

Run:

```bash
/Users/tafeng/.bun/bin/bun run typecheck
```

Expected: PASS. If it fails with missing `node_modules/.bin/tsc`, run
`/Users/tafeng/.bun/bin/bun install` first, then repeat the typecheck.

- [ ] **Step 3: Run Biome check**

Run:

```bash
/Users/tafeng/.bun/bin/bun run check
```

Expected: PASS. If it fails with missing `node_modules/.bin/biome`, run
`/Users/tafeng/.bun/bin/bun install` first, then repeat the check.

- [ ] **Step 4: Manual smoke command**

From a temp or existing grove, run:

```bash
/Users/tafeng/.bun/bin/bun run src/cli/main.ts diagnostics --exclude-db --out /tmp/grove-diagnostics-smoke.zip
```

Expected:

```text
Diagnostics bundle written: /tmp/grove-diagnostics-smoke.zip
Entries: <number greater than 5>
Warnings: <number>
```

Then inspect names:

```bash
unzip -l /tmp/grove-diagnostics-smoke.zip | sed -n '1,40p'
```

Expected: output lists `meta.json`, `README.md`, `db/contributions-recent.jsonl`,
`operator-primitives/availability.json`, and `system/process-tree.txt`.

- [ ] **Step 5: Final status**

Run:

```bash
git status --short --branch
git log --oneline -8
```

Expected: branch contains the diagnostics commits and no uncommitted changes.

---

## Self-Review Notes

Spec coverage:

- Command flags are covered by Tasks 6 and 8.
- ZIP archive creation is covered by Tasks 1, 5, 6, and 8.
- Redaction modes are covered by Task 2.
- SQLite summaries and optional raw DB are covered by Tasks 3, 5, 6, and 8.
- Logs, config, metadata, README, operator availability, and system probes are covered by Tasks 4 and 5.
- CLI registration, help, completions, and parity documentation are covered by Task 7.
- Verification commands are covered by Task 9.

Type consistency:

- `DiagnosticEntry` is defined in `src/diagnostics/sqlite-export.ts` and reused by bundle/system modules.
- `ScrubMode` is defined in `src/diagnostics/redaction.ts` and reused by bundle/CLI modules.
- `ProbeRunner` is defined in `src/diagnostics/system.ts` and injected through bundle/CLI tests.
- `createStoredZip` accepts `readonly ZipEntryInput[]` and returns `Uint8Array`, matching CLI file writing.

Scope check:

- This plan implements the first local snapshot bundle only. It does not add live server APIs, uploader behavior, `grove doctor`, or final schemas for still-open operator primitive issues.
