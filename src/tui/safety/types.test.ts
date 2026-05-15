/**
 * Type-level proof that the DangerousToken brand prevents caller-bypass.
 *
 * Each `// @ts-expect-error` consumes a real type error. If any stops failing
 * (e.g., the brand weakens), tsc reports "Unused '@ts-expect-error' directive"
 * and this file fails to compile.
 *
 * Not a runtime test — bun:test won't execute it; `bun tsc --noEmit` does.
 * CI enforces tsc, so this file IS the lint rule from issue #304.
 */

import type { TuiGoalProvider, TuiSessionProvider } from "../provider.js";
import type { DangerousToken } from "./index.js";

declare const sessionProvider: TuiSessionProvider;
declare const goalProvider: TuiGoalProvider;
declare const validSessionToken: DangerousToken<"AgentSession">;
declare const validGoalToken: DangerousToken<"Goal">;

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
