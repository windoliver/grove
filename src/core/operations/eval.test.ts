/**
 * Tests for evalOperation.
 *
 * Covers the shipped GROVE_SCORE-line protocol (characterization) plus the
 * new contract.hooks.eval command resolution.
 */

import { describe, expect, test } from "bun:test";

import type { OperationDeps } from "./deps.js";
import { evalOperation } from "./eval.js";

const NO_DEPS: OperationDeps = {};

describe("evalOperation — contract.hooks.eval resolution", () => {
  test("resolves the command from contract.hooks.eval when no evalCommand input", async () => {
    const deps: OperationDeps = {
      contract: {
        contractVersion: 2,
        name: "eval-test",
        hooks: { eval: "echo GROVE_SCORE acc=0.9" },
      },
    };

    const result = await evalOperation(deps, { targetCid: "blake3:abc" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.exitCode).toBe(0);
    expect(result.value.scores).toContainEqual({ metric: "acc", value: 0.9 });
  });

  test("supports the { cmd, timeout } hook object form", async () => {
    const deps: OperationDeps = {
      contract: {
        contractVersion: 2,
        name: "eval-test",
        hooks: { eval: { cmd: "echo GROVE_SCORE acc=0.3", timeout: 60_000 } },
      },
    };

    const result = await evalOperation(deps, { targetCid: "blake3:abc" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.scores).toContainEqual({ metric: "acc", value: 0.3 });
  });

  test("explicit evalCommand input overrides the contract hook", async () => {
    const deps: OperationDeps = {
      contract: {
        contractVersion: 2,
        name: "eval-test",
        hooks: { eval: "echo GROVE_SCORE fromcontract=1" },
      },
    };

    const result = await evalOperation(deps, {
      targetCid: "blake3:abc",
      evalCommand: "echo GROVE_SCORE frominput=2",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.scores).toContainEqual({ metric: "frominput", value: 2 });
    expect(result.value.scores.find((s) => s.metric === "fromcontract")).toBeUndefined();
  });
});

describe("evalOperation — score parsing (GROVE_SCORE protocol)", () => {
  test("parses int, float, negative, and scientific notation from stdout", async () => {
    const cmd =
      "printf 'GROVE_SCORE acc=0.95\\nGROVE_SCORE latency_ms=42\\nGROVE_SCORE neg=-1.5\\nGROVE_SCORE sci=1e-3\\n'";

    const result = await evalOperation(NO_DEPS, { targetCid: "blake3:x", evalCommand: cmd });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.scores).toContainEqual({ metric: "acc", value: 0.95 });
    expect(result.value.scores).toContainEqual({ metric: "latency_ms", value: 42 });
    expect(result.value.scores).toContainEqual({ metric: "neg", value: -1.5 });
    expect(result.value.scores).toContainEqual({ metric: "sci", value: 0.001 });
  });

  test("parses score lines emitted on stderr", async () => {
    const result = await evalOperation(NO_DEPS, {
      targetCid: "blake3:x",
      evalCommand: ">&2 echo GROVE_SCORE acc=0.7",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.scores).toContainEqual({ metric: "acc", value: 0.7 });
  });

  test("tolerates non-score progress output", async () => {
    const cmd = "printf 'building...\\nrunning benchmark\\nGROVE_SCORE acc=0.5\\ndone\\n'";

    const result = await evalOperation(NO_DEPS, { targetCid: "blake3:x", evalCommand: cmd });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.scores).toEqual([{ metric: "acc", value: 0.5 }]);
  });

  test("flushes a final score line with no trailing newline", async () => {
    const result = await evalOperation(NO_DEPS, {
      targetCid: "blake3:x",
      evalCommand: "printf 'GROVE_SCORE acc=0.88'",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.scores).toContainEqual({ metric: "acc", value: 0.88 });
  });

  test("exitCode reflects a failing eval command", async () => {
    const result = await evalOperation(NO_DEPS, {
      targetCid: "blake3:x",
      evalCommand: "echo GROVE_SCORE acc=0.1; exit 3",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.exitCode).toBe(3);
    expect(result.value.scores).toContainEqual({ metric: "acc", value: 0.1 });
  });
});

describe("evalOperation — timeout and validation", () => {
  test("kills the subprocess on timeout and reports timedOut + exit 124", async () => {
    const result = await evalOperation(NO_DEPS, {
      targetCid: "blake3:x",
      evalCommand: "sleep 10",
      timeoutMs: 200,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.timedOut).toBe(true);
    expect(result.value.exitCode).toBe(124);
  });

  test("returns a validation error when no command is available", async () => {
    const result = await evalOperation(NO_DEPS, { targetCid: "blake3:x" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("evalCommand is required");
  });

  test("returns a validation error for an empty targetCid", async () => {
    const result = await evalOperation(NO_DEPS, {
      targetCid: "   ",
      evalCommand: "echo GROVE_SCORE acc=1",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("targetCid");
  });
});
