import { describe, expect, test } from "bun:test";
import { mintDangerousToken } from "./token.js";

describe("DangerousToken", () => {
  test("mintDangerousToken stamps kind/id/ifMatch", () => {
    const token = mintDangerousToken("AgentSession", "sess-1", "rv-7");
    expect(token.kind).toBe("AgentSession");
    expect(token.id).toBe("sess-1");
    expect(token.ifMatch).toBe("rv-7");
  });

  test("token preserves the kind type parameter", () => {
    // Compile-time check: K narrows correctly. If the factory didn't
    // thread K through, `token.kind` would widen to `string` and
    // downstream `DangerousToken<"Claim">` parameters would refuse it.
    const token = mintDangerousToken("Claim", "c-1", "rv-3");
    const _typed: typeof token = token;
    expect(token.kind).toBe("Claim");
    expect(token.id).toBe("c-1");
    expect(token.ifMatch).toBe("rv-3");
  });
});
