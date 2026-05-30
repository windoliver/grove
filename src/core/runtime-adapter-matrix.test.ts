import { describe } from "bun:test";
import { AcpRuntime } from "./acp-runtime.js";
import { AcpxSupervisor } from "./acpx-supervisor.js";
import { makeInProcessLaunchOverride } from "./acpx-test-support.js";
import { MockRuntime } from "./mock-runtime.js";
import { runRuntimeAdapterMatrix } from "./runtime-adapter-matrix.js";

describe("runtime adapter matrix", () => {
  runRuntimeAdapterMatrix("MockRuntime", () => new MockRuntime());
  runRuntimeAdapterMatrix(
    "AcpRuntime",
    () => new AcpRuntime({ launchOverride: makeInProcessLaunchOverride() }),
  );
  runRuntimeAdapterMatrix(
    "AcpxSupervisor",
    () =>
      new AcpxSupervisor({
        runtimeFactory: () => new AcpRuntime({ launchOverride: makeInProcessLaunchOverride() }),
      }),
  );
});
