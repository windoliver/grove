import { describe, expect, test } from "bun:test";
import { ensureTmuxPassthrough } from "./tmux-compat.js";

describe("ensureTmuxPassthrough", () => {
  test("returns not-in-tmux when TMUX env is unset", () => {
    const env = { ...process.env };
    delete env.TMUX;
    const result = ensureTmuxPassthrough({ env });
    expect(result.applied).toBe(false);
    if (!result.applied) {
      expect(result.reason).toBe("not-in-tmux");
    }
  });

  test("returns not-in-tmux when TMUX env is empty string", () => {
    const result = ensureTmuxPassthrough({ env: { TMUX: "" } });
    expect(result.applied).toBe(false);
  });

  test("attempts the tmux call when TMUX env is set", () => {
    // Real tmux is available on the dev box; spawn the actual command.
    // If tmux is missing or the call fails, we expect a structured
    // failure result rather than a thrown error.
    const result = ensureTmuxPassthrough({
      env: { TMUX: "/tmp/fake-tmux-socket,12345,0" },
    });
    // Either it applied successfully (real tmux on PATH and the call
    // succeeded against whatever default server it picked) or it
    // returned a tmux-failed result. Both are non-throwing.
    if (!result.applied && result.reason === "tmux-failed") {
      expect(typeof result.stderr).toBe("string");
    } else if (!result.applied) {
      throw new Error(`unexpected reason: ${result.reason}`);
    }
  });
});
