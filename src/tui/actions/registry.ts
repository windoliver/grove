import { fuzzyMatch } from "./fuzzy.js";
import { computeVisibleActions } from "./visibility.js";
import type { Action, ActionContext, DynamicSource } from "./types.js";

export interface ActionRegistry {
  register(action: Action): void;
  registerDynamic(idPrefix: string, source: DynamicSource): void;
  setBindings(bindings: ReadonlyMap<string, string>): void;
  list(ctx: ActionContext): readonly Action[];
  byId(id: string, ctx: ActionContext): Action | undefined;
  search(query: string, ctx: ActionContext): readonly Action[];
}

export function createActionRegistry(): ActionRegistry {
  const statics: Action[] = [];
  const dynamics: { prefix: string; source: DynamicSource }[] = [];
  let bindings: ReadonlyMap<string, string> = new Map();

  const annotate = (a: Action): Action => {
    const keybind = bindings.get(a.id);
    return keybind === undefined ? a : { ...a, keybind };
  };

  const expand = (ctx: ActionContext): Action[] => {
    const out: Action[] = [...statics];
    for (const { source } of dynamics) out.push(...source(ctx));
    return out.map(annotate);
  };

  return {
    register(action) {
      statics.push(action);
    },
    registerDynamic(prefix, source) {
      dynamics.push({ prefix, source });
    },
    setBindings(next) {
      bindings = next;
    },
    list(ctx) {
      return computeVisibleActions(expand(ctx), ctx, "").map((v) => v.action);
    },
    byId(id, ctx) {
      const direct = statics.find((a) => a.id === id);
      if (direct !== undefined) return annotate(direct);
      const owner = dynamics.find((d) => id.startsWith(d.prefix));
      if (owner === undefined) return undefined;
      const found = owner.source(ctx).find((a) => a.id === id);
      return found === undefined ? undefined : annotate(found);
    },
    search(query, ctx) {
      return computeVisibleActions(expand(ctx), ctx, query).map((v) => v.action);
    },
  };
}

export { fuzzyMatch };
