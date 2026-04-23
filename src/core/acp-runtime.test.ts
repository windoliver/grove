import { describe, expect, test } from "bun:test";
import { AcpRuntime } from "./acp-runtime.js";
import { DENY_ALL_RESOLVER } from "./permission-resolver.js";

describe("AcpRuntime construction", () => {
  test("implements AgentRuntime interface (method shape)", () => {
    const rt = new AcpRuntime();
    expect(typeof rt.spawn).toBe("function");
    expect(typeof rt.send).toBe("function");
    expect(typeof rt.close).toBe("function");
    expect(typeof rt.onIdle).toBe("function");
    expect(typeof rt.listSessions).toBe("function");
    expect(typeof rt.isAvailable).toBe("function");
    expect(typeof rt.setPermissionResolver).toBe("function");
  });

  test("default resolver is DenyAll", () => {
    const rt = new AcpRuntime();
    expect(rt.currentResolver).toBe(DENY_ALL_RESOLVER);
  });

  test("setPermissionResolver swaps the resolver", () => {
    const rt = new AcpRuntime();
    const custom = {
      async resolve() {
        return { outcome: { outcome: "cancelled" as const } };
      },
    };
    rt.setPermissionResolver(custom);
    expect(rt.currentResolver).toBe(custom);
  });

  test("listSessions empty by default", async () => {
    const rt = new AcpRuntime();
    expect(await rt.listSessions()).toEqual([]);
  });

  test("isAvailable returns true when SDK importable", async () => {
    const rt = new AcpRuntime();
    expect(await rt.isAvailable()).toBe(true);
  });
});
