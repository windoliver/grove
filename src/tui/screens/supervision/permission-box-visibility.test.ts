import { describe, expect, test } from "bun:test";
import { permissionBoxVisible } from "./permission-box-visibility.js";

describe("permissionBoxVisible", () => {
  test("visible when supervision off and there are pending permissions", () => {
    expect(permissionBoxVisible(false, 1)).toBe(true);
    expect(permissionBoxVisible(false, 3)).toBe(true);
  });
  test("hidden when supervision on, even with pending permissions", () => {
    expect(permissionBoxVisible(true, 1)).toBe(false);
    expect(permissionBoxVisible(true, 5)).toBe(false);
  });
  test("hidden when no pending permissions regardless of flag", () => {
    expect(permissionBoxVisible(false, 0)).toBe(false);
    expect(permissionBoxVisible(true, 0)).toBe(false);
  });
});
