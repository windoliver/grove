import { describe, expect, test } from "bun:test";
import { createActionRegistry } from "./registry.js";
import type { Action, ActionContext } from "./types.js";

const ctx = {} as ActionContext;
const action = (over: Partial<Action> & Pick<Action, "id">): Action => ({
  label: over.id,
  detail: "",
  group: "View",
  run: () => {},
  ...over,
});

describe("ActionRegistry", () => {
  test("list returns registered static actions", () => {
    const r = createActionRegistry();
    r.register(action({ id: "a", group: "View" }));
    r.register(action({ id: "b", group: "Navigation" }));
    expect(r.list(ctx).map((x) => x.id)).toEqual(["b", "a"]); // Navigation before View
  });

  test("suggested actions sort first within the no-query list", () => {
    const r = createActionRegistry();
    r.register(action({ id: "plain", group: "View" }));
    r.register(action({ id: "star", group: "View", suggested: true }));
    expect(r.list(ctx).map((x) => x.id)).toEqual(["star", "plain"]);
  });

  test("available=false hides an action from list", () => {
    const r = createActionRegistry();
    r.register(action({ id: "hidden", available: () => false }));
    r.register(action({ id: "shown" }));
    expect(r.list(ctx).map((x) => x.id)).toEqual(["shown"]);
  });

  test("dynamic sources expand at list time", () => {
    const r = createActionRegistry();
    r.registerDynamic("kill.", (_c) =>
      (["s1", "s2"] as const).map((s) => action({ id: `kill.${s}`, group: "Agents" })),
    );
    expect(r.list(ctx).map((x) => x.id)).toEqual(["kill.s1", "kill.s2"]);
  });

  test("byId resolves static and dynamic-by-prefix", () => {
    const r = createActionRegistry();
    r.register(action({ id: "static.one" }));
    r.registerDynamic("kill.", () => [action({ id: "kill.s1", group: "Agents" })]);
    expect(r.byId("static.one", ctx)?.id).toBe("static.one");
    expect(r.byId("kill.s1", ctx)?.id).toBe("kill.s1");
    expect(r.byId("kill.absent", ctx)).toBeUndefined();
  });

  test("setBindings annotates keybind on list/byId results", () => {
    const r = createActionRegistry();
    r.register(action({ id: "view.quit", group: "View" }));
    r.setBindings(new Map([["view.quit", "q"]]));
    expect(r.byId("view.quit", ctx)?.keybind).toBe("q");
    expect(r.list(ctx)[0]?.keybind).toBe("q");
  });

  test("search fuzzy-matches label and slash", () => {
    const r = createActionRegistry();
    r.register(action({ id: "view.quit", label: "Quit grove", group: "View" }));
    r.register(action({ id: "view.refresh", label: "Refresh", slash: "/reload", group: "View" }));
    expect(r.search("quit", ctx).map((x) => x.id)).toEqual(["view.quit"]);
    expect(r.search("reload", ctx).map((x) => x.id)).toEqual(["view.refresh"]);
  });
});
