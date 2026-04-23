import { describe, expect, test } from "bun:test";
import { AcpRuntime } from "./acp-runtime.js";
import { selectRuntime } from "./select-runtime.js";

describe("selectRuntime", () => {
  test("defaults to AcpRuntime when GROVE_RUNTIME is unset", () => {
    const rt = selectRuntime({ env: {} });
    expect(rt).toBeInstanceOf(AcpRuntime);
  });

  test("returns AcpRuntime when GROVE_RUNTIME=acp", () => {
    const rt = selectRuntime({ env: { GROVE_RUNTIME: "acp" } });
    expect(rt).toBeInstanceOf(AcpRuntime);
  });

  test("throws on GROVE_RUNTIME=acpx (no longer supported)", () => {
    expect(() => selectRuntime({ env: { GROVE_RUNTIME: "acpx" } })).toThrow(/no longer supported/);
  });

  test("throws on unknown values", () => {
    expect(() => selectRuntime({ env: { GROVE_RUNTIME: "tmux" } })).toThrow(/no longer supported/);
  });

  test("forwards options to the chosen runtime", () => {
    const rt = selectRuntime({ env: { GROVE_RUNTIME: "acp" }, acp: { logDir: "/tmp/x" } });
    expect(rt).toBeInstanceOf(AcpRuntime);
  });
});
