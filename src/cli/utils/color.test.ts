import { afterEach, describe, expect, test } from "bun:test";
import {
  colorize,
  formatNextCommandHint,
  isColorEnabled,
  setColorEnabled,
  shouldEnableColor,
} from "./color.js";

describe("CLI color controls", () => {
  afterEach(() => {
    setColorEnabled(true);
  });

  test("enables color by default", () => {
    expect(shouldEnableColor({}, [])).toBe(true);
  });

  test("NO_COLOR disables color when present", () => {
    expect(shouldEnableColor({ NO_COLOR: "" }, [])).toBe(false);
    expect(shouldEnableColor({ NO_COLOR: "1" }, [])).toBe(false);
  });

  test("TERM=dumb disables color", () => {
    expect(shouldEnableColor({ TERM: "dumb" }, [])).toBe(false);
  });

  test("--no-color disables color", () => {
    expect(shouldEnableColor({}, ["log", "--no-color"])).toBe(false);
  });

  test("setColorEnabled controls colorize output", () => {
    setColorEnabled(true);
    expect(isColorEnabled()).toBe(true);
    expect(colorize("text", "\x1b[2m")).toBe("\x1b[2mtext\x1b[0m");

    setColorEnabled(false);
    expect(isColorEnabled()).toBe(false);
    expect(colorize("text", "\x1b[2m")).toBe("text");
  });

  test("formatNextCommandHint uses the standard hint prefix", () => {
    setColorEnabled(false);
    expect(formatNextCommandHint("Run `grove frontier` to see updated frontier")).toBe(
      "hint: Run `grove frontier` to see updated frontier",
    );
  });
});
