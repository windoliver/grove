import { describe, expect, test } from "bun:test";
import { resolveMcpHttpListenOptions } from "./http-listen.js";

describe("resolveMcpHttpListenOptions", () => {
  test("defaults HTTP MCP to loopback", () => {
    expect(resolveMcpHttpListenOptions({}).host).toBe("127.0.0.1");
  });

  test("rejects non-local binds without an auth token", () => {
    expect(() => resolveMcpHttpListenOptions({ host: "0.0.0.0" })).toThrow("GROVE_MCP_AUTH_TOKEN");
  });

  test("allows non-local binds when auth is configured", () => {
    expect(resolveMcpHttpListenOptions({ host: "0.0.0.0", authToken: "secret" })).toEqual({
      host: "0.0.0.0",
    });
  });
});
