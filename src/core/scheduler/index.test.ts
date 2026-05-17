import { describe, expect, test } from "bun:test";
import {
  Scheduler,
  SchedulerConfigSchema,
  loadSchedulerConfig,
  synthesizeFallbackProfile,
} from "./index.js";

describe("scheduler module re-exports", () => {
  test("Scheduler class is exported", () => {
    expect(typeof Scheduler).toBe("function");
  });
  test("SchedulerConfigSchema is exported", () => {
    expect(typeof SchedulerConfigSchema.parse).toBe("function");
  });
  test("loadSchedulerConfig is exported", () => {
    expect(typeof loadSchedulerConfig).toBe("function");
  });
  test("synthesizeFallbackProfile is exported", () => {
    expect(typeof synthesizeFallbackProfile).toBe("function");
  });
});
