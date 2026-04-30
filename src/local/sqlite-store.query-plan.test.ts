import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("countSince keeps the agent-scoped rate-limit query indexable", () => {
  const source = readFileSync(join(import.meta.dir, "sqlite-store.ts"), "utf-8");

  expect(source).toContain("WHERE agent_id = ? AND created_at >= ?");
  expect(source).not.toContain("OR ? IS NULL");
});
