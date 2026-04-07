/**
 * TDD tests for the Grove config loader.
 *
 * Tests are written against the pure `mergeGroveConfig` function only —
 * no file I/O, no side effects.  These tests define the merge contract
 * before the implementation exists.
 */

import { describe, expect, test } from "bun:test";
import { EMPTY_CONFIG, mergeGroveConfig } from "./config-loader.js";

describe("mergeGroveConfig — merge semantics", () => {
  test("global-only returns global theme and keymap", () => {
    const result = mergeGroveConfig(
      { theme: { focus: "#ff0000" }, keymap: { quit: "Q" } },
      undefined,
    );
    expect(result.theme.focus).toBe("#ff0000");
    expect(result.keymap.quit).toBe("Q");
  });

  test("project-only returns project theme and keymap", () => {
    const result = mergeGroveConfig(undefined, {
      theme: { focus: "#00ff00" },
      keymap: { help: "F1" },
    });
    expect(result.theme.focus).toBe("#00ff00");
    expect(result.keymap.help).toBe("F1");
  });

  test("project theme token overrides global scalar", () => {
    const result = mergeGroveConfig(
      { theme: { focus: "#ff0000", border: "#111111" } },
      { theme: { focus: "#00ff00" } },
    );
    expect(result.theme.focus).toBe("#00ff00"); // project wins
    expect(result.theme.border).toBe("#111111"); // global preserved
  });

  test("project keymap extends global additively", () => {
    const result = mergeGroveConfig({ keymap: { quit: "Q" } }, { keymap: { help: "F1" } });
    expect(result.keymap.quit).toBe("Q"); // from global
    expect(result.keymap.help).toBe("F1"); // from project
  });

  test("project keymap entry wins over same global key", () => {
    const result = mergeGroveConfig({ keymap: { quit: "Q" } }, { keymap: { quit: "X" } });
    expect(result.keymap.quit).toBe("X");
  });

  test("empty project does not clobber global", () => {
    const result = mergeGroveConfig({ theme: { focus: "#ff0000" }, keymap: { quit: "Q" } }, {});
    expect(result.theme.focus).toBe("#ff0000");
    expect(result.keymap.quit).toBe("Q");
  });

  test("empty global is handled gracefully", () => {
    const result = mergeGroveConfig({}, { theme: { focus: "#00ff00" } });
    expect(result.theme.focus).toBe("#00ff00");
  });

  test("both undefined returns empty config", () => {
    const result = mergeGroveConfig(undefined, undefined);
    expect(result.theme).toEqual({});
    expect(result.keymap).toEqual({});
  });

  test("EMPTY_CONFIG has empty theme and keymap", () => {
    expect(EMPTY_CONFIG.theme).toEqual({});
    expect(EMPTY_CONFIG.keymap).toEqual({});
  });

  test("merge is non-destructive to inputs", () => {
    const global = { theme: { focus: "#ff0000" }, keymap: { quit: "Q" } };
    const project = { theme: { focus: "#00ff00" } };
    mergeGroveConfig(global, project);
    expect(global.theme.focus).toBe("#ff0000"); // not mutated
    expect(project.theme.focus).toBe("#00ff00"); // not mutated
  });
});
