import { describe, expect, test } from "bun:test";
import { resolveMcpHttpBindPolicy } from "./http-bind-policy.js";

describe("resolveMcpHttpBindPolicy", () => {
  test("defaults to localhost when no host is configured", () => {
    const result = resolveMcpHttpBindPolicy({
      host: undefined,
      authToken: undefined,
      allowRemote: undefined,
    });

    expect(result).toEqual({ host: "localhost", remote: false, allowed: true });
  });

  test("allows explicit localhost addresses without auth", () => {
    for (const host of ["localhost", "127.0.0.1", "::1"]) {
      const result = resolveMcpHttpBindPolicy({
        host,
        authToken: undefined,
        allowRemote: undefined,
      });

      expect(result.allowed).toBe(true);
      expect(result.remote).toBe(false);
    }
  });

  test("refuses remote binding without explicit opt-in and auth", () => {
    const result = resolveMcpHttpBindPolicy({
      host: "0.0.0.0",
      authToken: undefined,
      allowRemote: undefined,
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("GROVE_MCP_ALLOW_REMOTE");
  });

  test("refuses remote binding with opt-in but no auth token", () => {
    const result = resolveMcpHttpBindPolicy({
      host: "0.0.0.0",
      authToken: undefined,
      allowRemote: "true",
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("GROVE_MCP_AUTH_TOKEN");
  });

  test("refuses remote binding with opt-in and an empty auth token", () => {
    const result = resolveMcpHttpBindPolicy({
      host: "0.0.0.0",
      authToken: "",
      allowRemote: "true",
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("GROVE_MCP_AUTH_TOKEN");
  });

  test("allows remote binding only with explicit opt-in and auth token", () => {
    const result = resolveMcpHttpBindPolicy({
      host: "0.0.0.0",
      authToken: "secret",
      allowRemote: "true",
    });

    expect(result).toEqual({ host: "0.0.0.0", remote: true, allowed: true });
  });
});
