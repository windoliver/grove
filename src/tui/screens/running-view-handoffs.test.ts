import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("RunningView handoff refresh wiring", () => {
  test("refetches handoffs when the contribution feed changes", () => {
    const source = readFileSync(resolve(import.meta.dir, "running-view.tsx"), "utf-8");

    expect(source).toContain("const refreshHandoffs = useCallback");
    expect(source).toContain("feedCidKey");
    expect(source).toContain("[feedCidKey, refreshHandoffs]");
    expect(source).toContain("healthSignalsFromAgentFailures");
    expect(source).toContain("healthSignalsFromAgentTasks");
    expect(source).toContain("handoffHealthSignals");
  });
});
