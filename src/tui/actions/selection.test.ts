import { describe, expect, test } from "bun:test";
import { Panel } from "../hooks/use-panel-focus.js";
import { resolveSelectedCid } from "./selection.js";

const entries = [{ cid: "bafyFRONT0" }, { cid: "bafyFRONT1" }];

describe("resolveSelectedCid", () => {
  test("Frontier focused → highlighted Frontier row cid", () => {
    expect(
      resolveSelectedCid({
        focusedPanel: Panel.Frontier,
        cursor: 1,
        frontierEntries: entries,
        detailCid: "bafyDETAIL",
      }),
    ).toBe("bafyFRONT1");
  });

  test("Frontier focused with cursor miss → undefined (no detail fallback)", () => {
    // Out of range
    expect(
      resolveSelectedCid({
        focusedPanel: Panel.Frontier,
        cursor: 9,
        frontierEntries: entries,
        detailCid: "bafyDETAIL",
      }),
    ).toBeUndefined();
    // Empty/stale slice
    expect(
      resolveSelectedCid({
        focusedPanel: Panel.Frontier,
        cursor: 0,
        frontierEntries: [],
        detailCid: "bafyDETAIL",
      }),
    ).toBeUndefined();
  });

  test("Detail focused → the open detail cid", () => {
    expect(
      resolveSelectedCid({
        focusedPanel: Panel.Detail,
        cursor: 0,
        frontierEntries: entries,
        detailCid: "bafyDETAIL",
      }),
    ).toBe("bafyDETAIL");
  });

  test("non-contribution panels → undefined even when a detail is open", () => {
    for (const p of [Panel.Activity, Panel.Terminal, Panel.Dag, Panel.Claims, Panel.Search]) {
      expect(
        resolveSelectedCid({
          focusedPanel: p,
          cursor: 0,
          frontierEntries: entries,
          detailCid: "bafyDETAIL",
        }),
        `panel ${p}`,
      ).toBeUndefined();
    }
  });
});
