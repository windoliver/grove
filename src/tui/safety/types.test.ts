/**
 * Type-level proof that the DangerousToken brand prevents caller-bypass.
 *
 * Each `// @ts-expect-error` consumes a real type error. If any stops failing
 * (e.g., the brand weakens), tsc reports "Unused '@ts-expect-error' directive"
 * and this file fails to compile.
 *
 * This file is read by `bun tsc --noEmit` (gated by CI) — that is what enforces
 * the brand. The whole body is wrapped in a never-called function so bun:test
 * can pick the file up by suffix without invoking the dangling-method calls.
 */

import type { TuiGoalProvider, TuiSessionProvider } from "../provider.js";
import type { DangerousToken } from "./index.js";

// Wrapped: never executed at runtime. tsc still type-checks the body.
function _typeChecksOnly(
  sessionProvider: TuiSessionProvider,
  goalProvider: TuiGoalProvider,
  validSessionToken: DangerousToken<"AgentSession">,
  validGoalToken: DangerousToken<"Goal">,
): void {
  // 1. Calling a dangerous method without a token must not compile.

  // @ts-expect-error — archiveSession requires DangerousToken<"AgentSession">, not string
  void sessionProvider.archiveSession("sess-1");

  // @ts-expect-error — setGoal requires DangerousToken<"Goal"> as the first arg
  void goalProvider.setGoal("my goal", []);

  // 2. Calling with a valid token compiles.
  void sessionProvider.archiveSession(validSessionToken);
  void goalProvider.setGoal(validGoalToken, "my goal", []);

  // 3. Object-literal construction must not compile (brand uses unique symbol).

  // @ts-expect-error — DangerousToken<K> has a unique-symbol field unforgeable via object literal
  const fakeToken: DangerousToken<"AgentSession"> = {
    kind: "AgentSession",
    id: "sess-1",
    ifMatch: "1",
  };
  void fakeToken;

  // 4. Wrong-kind tokens must not compile.

  // @ts-expect-error — archiveSession needs DangerousToken<"AgentSession">, not <"Goal">
  void sessionProvider.archiveSession(validGoalToken);

  // @ts-expect-error — setGoal needs DangerousToken<"Goal">, not <"AgentSession">
  void goalProvider.setGoal(validSessionToken, "my goal", []);
}

// Stub bun:test entry so the runner doesn't error on a test-named file with no
// tests. The function above is the actual contract; tsc gates compile.
import { test } from "bun:test";

test("DangerousToken brand prevents bypass at compile time (see _typeChecksOnly)", () => {
  // No runtime assertion. The proof is that this file compiles.
});

void _typeChecksOnly;
