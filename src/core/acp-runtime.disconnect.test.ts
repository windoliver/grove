import { describe, expect, test } from "bun:test";
import { AgentDisconnectedError } from "./agent-runtime.js";

describe("AgentDisconnectedError", () => {
  test("carries session/role/exit info and a readable message", () => {
    const err = new AgentDisconnectedError({
      sessionId: "grove-coder-0--abc",
      role: "coder",
      exitCode: null,
      signal: "SIGKILL",
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.info.sessionId).toBe("grove-coder-0--abc");
    expect(err.info.role).toBe("coder");
    expect(err.info.signal).toBe("SIGKILL");
    expect(err.message).toContain("coder");
    expect(err.message).toContain("grove-coder-0--abc");
  });
});
