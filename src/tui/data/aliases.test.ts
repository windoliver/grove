import { describe, expect, test } from "bun:test";
import { DEFAULT_ALIASES, MAX_ALIAS_DEPTH } from "./aliases.js";

describe("DEFAULT_ALIASES", () => {
  test("contains six built-in keys", () => {
    expect([...DEFAULT_ALIASES.keys()].sort()).toEqual(["a", "d", "q", "r", "s", "t"]);
  });

  test("maps to expected commands", () => {
    expect(DEFAULT_ALIASES.get("a")?.value).toBe("agents");
    expect(DEFAULT_ALIASES.get("s")?.value).toBe("sessions");
    expect(DEFAULT_ALIASES.get("t")?.value).toBe("tasks");
    expect(DEFAULT_ALIASES.get("d")?.value).toBe("dag");
    expect(DEFAULT_ALIASES.get("r")?.value).toBe("reviews");
    expect(DEFAULT_ALIASES.get("q")?.value).toBe("quit");
  });

  test("MAX_ALIAS_DEPTH is 8", () => {
    expect(MAX_ALIAS_DEPTH).toBe(8);
  });
});
