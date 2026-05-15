import { describe, expect, mock, test } from "bun:test";
import type { CasMutationResult } from "./cas.js";
import { withIfMatch } from "./with-if-match.js";

describe("withIfMatch", () => {
  test("succeeds on first try when RV matches", async () => {
    const read = mock(async () => ({ resourceVersion: "7" }));
    const patch = mock(
      async (opts: {
        readonly ifMatch: string;
      }): Promise<CasMutationResult<{ x: number; ifMatchUsed: string }>> => ({
        kind: "ok",
        view: { x: 1, ifMatchUsed: opts.ifMatch },
      }),
    );
    const result = await withIfMatch(read, patch);
    expect(result).toEqual({ x: 1, ifMatchUsed: "7" });
    expect(read).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenCalledTimes(1);
  });

  test("retries on rv-mismatch up to maxRetries", async () => {
    const reads = ["1", "2", "3"];
    const read = mock(async () => ({ resourceVersion: reads.shift() ?? "x" }));
    let attempt = 0;
    const patch = mock(async (): Promise<CasMutationResult<{ ok: true }>> => {
      attempt++;
      if (attempt < 3) {
        return { kind: "rv-mismatch", current: { resourceVersion: "x", generation: 0 } };
      }
      return { kind: "ok", view: { ok: true } };
    });
    const result = await withIfMatch(read, patch, { maxRetries: 5 });
    expect(result).toEqual({ ok: true });
    expect(read).toHaveBeenCalledTimes(3);
  });

  test("throws after exhausting retries", async () => {
    const read = mock(async () => ({ resourceVersion: "1" }));
    const patch = mock(
      async (): Promise<CasMutationResult<unknown>> => ({
        kind: "rv-mismatch",
        current: { resourceVersion: "x", generation: 0 },
      }),
    );
    await expect(withIfMatch(read, patch, { maxRetries: 2 })).rejects.toThrow(/retries/);
    // Verify the error message includes the last current RV per the
    // documented contract — protects the message format from drift.
    await expect(withIfMatch(read, patch, { maxRetries: 2 })).rejects.toThrow(/last current RV=x/);
  });

  test("uses default maxRetries of 3 when none supplied", async () => {
    const read = mock(async () => ({ resourceVersion: "1" }));
    const patch = mock(
      async (): Promise<CasMutationResult<unknown>> => ({
        kind: "rv-mismatch",
        current: { resourceVersion: "x", generation: 0 },
      }),
    );
    await expect(withIfMatch(read, patch)).rejects.toThrow(/retries/);
    // Default 3 = 4 attempts (initial + 3 retries) → read called 4 times
    expect(read).toHaveBeenCalledTimes(4);
  });
});
