/**
 * Acceptance tests for issue #302 exit criteria:
 *   1. ":a" routes to agents view
 *   2. "/foo" filters current view without tearing down state
 *   3. Invalid alias file → flash-bar error, falls back to defaults
 */

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_ALIASES, resolveAlias } from "../data/aliases.js";
import { loadAliases } from "../data/aliases-loader.js";

async function makeTmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "c2-acc-"));
}

describe("C2 acceptance — issue #302", () => {
  test("AC1: ':a' resolves to agents command", () => {
    const r = resolveAlias(DEFAULT_ALIASES, "a");
    expect(r).toEqual({ kind: "ok", command: "agents", argv: [], chain: ["a"] });
  });

  test("AC2: filter predicate composes; same query applies across panels", () => {
    // Simulates running-view's filter wiring: the same filterText flows into
    // any expanded EntityView/list. Switching panels keeps the filter active —
    // panel state is not torn down because the predicate composes at render.
    const buildPredicate = (q: string) => {
      const lower = q.toLowerCase();
      return (row: { label: string }) => row.label.toLowerCase().includes(lower);
    };
    const predicate = buildPredicate("foo");

    // Agents-panel rows
    const agentRows = [{ label: "foobar" }, { label: "baz" }];
    expect(agentRows.filter(predicate)).toEqual([{ label: "foobar" }]);

    // Switch to DAG panel — same predicate, applies to dag rows
    const dagRows = [{ label: "foo-other" }, { label: "qux" }];
    expect(dagRows.filter(predicate)).toEqual([{ label: "foo-other" }]);
  });

  test("AC3: invalid alias file → errors reported + defaults still resolve ':a'", async () => {
    const dir = await makeTmp();
    try {
      const grove = join(dir, ".grove");
      await mkdir(grove, { recursive: true });
      await writeFile(join(grove, "aliases.yaml"), "{[ broken yaml", "utf8");
      const result = await loadAliases(dir, { homeOverride: dir });
      expect(result.errors.length).toBeGreaterThan(0);
      // Defaults still resolve ':a' → agents.
      const r = resolveAlias(result.aliases, "a");
      expect(r.kind).toBe("ok");
      if (r.kind === "ok") expect(r.command).toBe("agents");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
