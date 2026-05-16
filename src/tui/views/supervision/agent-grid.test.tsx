import { describe, expect, test } from "bun:test";
import { moveCursor } from "./agent-grid.js";

describe("moveCursor", () => {
  test("right within row", () => {
    expect(moveCursor(0, 6, "right")).toBe(1);
  });
  test("right clamps at total - 1", () => {
    expect(moveCursor(5, 6, "right")).toBe(5);
  });
  test("left clamps at 0", () => {
    expect(moveCursor(0, 6, "left")).toBe(0);
  });
  test("down moves by GRID_COLS (3)", () => {
    expect(moveCursor(0, 9, "down")).toBe(3);
  });
  test("up moves by GRID_COLS", () => {
    expect(moveCursor(4, 9, "up")).toBe(1);
  });
  test("up at top stays at top", () => {
    expect(moveCursor(1, 9, "up")).toBe(0);
  });
  test("down past last row clamps", () => {
    expect(moveCursor(8, 9, "down")).toBe(8);
  });
  test("top → 0", () => {
    expect(moveCursor(5, 9, "top")).toBe(0);
  });
  test("bottom → total - 1", () => {
    expect(moveCursor(0, 9, "bottom")).toBe(8);
  });
  test("empty total stays at 0", () => {
    expect(moveCursor(0, 0, "right")).toBe(0);
  });
});
