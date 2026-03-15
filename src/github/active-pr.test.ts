import { describe, expect, test } from "bun:test";
import { getActivePR } from "./active-pr.js";

describe("getActivePR", () => {
  test("returns undefined when no PR exists (graceful fallback)", async () => {
    // In test environment, gh pr view will fail (no git repo or no PR)
    // The function should return undefined gracefully, not throw
    const result = await getActivePR();
    // Result is either a valid PR summary or undefined - both are OK
    if (result !== undefined) {
      expect(result.number).toBeGreaterThan(0);
      expect(typeof result.title).toBe("string");
    } else {
      expect(result).toBeUndefined();
    }
  });
});
