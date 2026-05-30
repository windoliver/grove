import { describe, expect, test } from "bun:test";
import { AcpRuntime } from "./acp-runtime.js";
import { AcpxSupervisor } from "./acpx-supervisor.js";
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

describe("selectRuntime GROVE_SUPERVISOR flag", () => {
  test("GROVE_SUPERVISOR=1 wraps the runtime in AcpxSupervisor", () => {
    const rt = selectRuntime({
      env: { GROVE_RUNTIME: "acp" },
      supervisorEnv: { GROVE_SUPERVISOR: "1" },
    });
    expect(rt).toBeInstanceOf(AcpxSupervisor);
  });

  test("flag unset returns a bare AcpRuntime", () => {
    const rt = selectRuntime({ env: { GROVE_RUNTIME: "acp" }, supervisorEnv: {} });
    expect(rt).toBeInstanceOf(AcpRuntime);
    expect(rt).not.toBeInstanceOf(AcpxSupervisor);
  });

  test("GROVE_SUPERVISOR other-than-1 returns a bare AcpRuntime", () => {
    const rt = selectRuntime({
      env: { GROVE_RUNTIME: "acp" },
      supervisorEnv: { GROVE_SUPERVISOR: "0" },
    });
    expect(rt).toBeInstanceOf(AcpRuntime);
    expect(rt).not.toBeInstanceOf(AcpxSupervisor);
  });
});
