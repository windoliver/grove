import { describe, expect, test } from "bun:test";
import { nextDrillTab } from "./drill-tabs.js";

describe("nextDrillTab", () => {
  test("feed → dag", () => { expect(nextDrillTab("feed")).toBe("dag"); });
  test("dag → term", () => { expect(nextDrillTab("dag")).toBe("term"); });
  test("term → feed (wrap)", () => { expect(nextDrillTab("term")).toBe("feed"); });
});
