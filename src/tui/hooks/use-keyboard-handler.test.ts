/**
 * Tests for the extracted keyboard handler routing logic.
 *
 * Tests the pure nextZoom function. The routeKey function is tested
 * indirectly through the React component since it requires full
 * KeyboardActions wiring.
 */

import { describe, expect, test } from "bun:test";
import { nextZoom } from "./use-keyboard-handler.js";

describe("nextZoom", () => {
  test("normal → half", () => {
    expect(nextZoom("normal")).toBe("half");
  });

  test("half → full", () => {
    expect(nextZoom("half")).toBe("full");
  });

  test("full → normal", () => {
    expect(nextZoom("full")).toBe("normal");
  });

  test("full cycle returns to start", () => {
    let zoom = nextZoom("normal");
    zoom = nextZoom(zoom);
    zoom = nextZoom(zoom);
    expect(zoom).toBe("normal");
  });
});
