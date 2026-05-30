import { buildBuiltInActions } from "./builtin-actions.js";
import {
  delegateSource,
  killSource,
  promptSource,
  sessionNavSource,
  skillSource,
  spawnSource,
} from "./dynamic-sources.js";
import type { ActionRegistry } from "./registry.js";
import type { ActionContext } from "./types.js";

/**
 * Populate a registry with all built-in actions. Static actions are registered
 * once via a context-free snapshot (their run/enabled receive the LIVE ctx at
 * call time); per-entity actions are registered as dynamic sources.
 */
export function registerBuiltInActions(registry: ActionRegistry, emptyCtx: ActionContext): void {
  for (const action of buildBuiltInActions(emptyCtx)) registry.register(action);
  registry.registerDynamic("nav.session.", sessionNavSource);
  registry.registerDynamic("agent.spawn.", spawnSource);
  registry.registerDynamic("agent.kill.", killSource);
  registry.registerDynamic("agent.delegate.", delegateSource);
  registry.registerDynamic("prompt.", promptSource);
  registry.registerDynamic("skill.request.", skillSource);
}
