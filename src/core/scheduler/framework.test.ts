import { describe, expect, test } from "bun:test";
import type {
  BindPlugin,
  FilterPlugin,
  FilterRejection,
  FilterVerdict,
  PermitPlugin,
  PermitVerdict,
  SchedulerContext,
  SchedulingResult,
  ScorePlugin,
} from "./framework.js";

describe("framework exports", () => {
  test("FilterVerdict discriminates by admit", () => {
    const admit: FilterVerdict = { admit: true };
    const reject: FilterVerdict = { admit: false, reason: "x" };
    expect(admit.admit).toBe(true);
    expect(reject.admit).toBe(false);
  });

  test("PermitVerdict status union covers granted/denied/wait", () => {
    const grants: PermitVerdict[] = [
      { status: "granted" },
      { status: "denied", reason: "no" },
      { status: "wait", reason: "later" },
    ];
    expect(grants).toHaveLength(3);
  });

  test("SchedulingResult kind union covers four variants", () => {
    const kinds: SchedulingResult["kind"][] = ["bound", "unschedulable", "wait", "denied"];
    expect(kinds).toEqual(["bound", "unschedulable", "wait", "denied"]);
  });

  test("FilterRejection records plugin + reason", () => {
    const rejection: FilterRejection = { plugin: "test", reason: "x" };
    expect(rejection.plugin).toBe("test");
  });

  test("plugin interfaces have name field", () => {
    const filter: FilterPlugin = {
      name: "n",
      filter: async () => ({ admit: true }),
    };
    const score: ScorePlugin = { name: "n", score: async () => 0 };
    const permit: PermitPlugin = { name: "n", permit: async () => ({ status: "granted" }) };
    const bind: BindPlugin = {
      name: "n",
      bind: async () => ({ session: { id: "s", role: "r", status: "running" } }),
    };
    expect(filter.name).toBe("n");
    expect(score.name).toBe("n");
    expect(permit.name).toBe("n");
    expect(bind.name).toBe("n");
  });

  test("SchedulerContext shape compiles", () => {
    const _ctx: Pick<SchedulerContext, "now"> = { now: () => 0 };
    expect(typeof _ctx.now).toBe("function");
  });
});
