import { describe, expect, test } from "bun:test";
import type { Frontier } from "../../core/frontier.js";
import { toSlices } from "./frontier-slices.js";

function makeFrontier(partial: Partial<Frontier> = {}): Frontier {
  return {
    byMetric: {},
    byAdoption: [],
    byRecency: [],
    byReviewScore: [],
    byReproduction: [],
    ...partial,
  };
}

describe("toSlices — scalar dimensions", () => {
  test("empty frontier produces zero slices", () => {
    expect(toSlices(makeFrontier())).toEqual([]);
  });

  test("adoption slice present when entries exist", () => {
    const slices = toSlices(makeFrontier({ byAdoption: [{ cid: "a1", value: 5, summary: "s" }] }));
    expect(slices.length).toBe(1);
    expect(slices[0]?.key).toBe("adoption");
    expect(slices[0]?.label).toBe("adoption");
    expect(slices[0]?.entries.length).toBe(1);
    expect(slices[0]?.entries[0]?.cid).toBe("a1");
  });

  test("built-in slices ordered: adoption, recency, review, reproduction", () => {
    const slices = toSlices(
      makeFrontier({
        byReproduction: [{ cid: "rep", value: 1, summary: "" }],
        byReviewScore: [{ cid: "rv", value: 4, summary: "" }],
        byRecency: [{ cid: "rc", value: 100, summary: "" }],
        byAdoption: [{ cid: "ad", value: 2, summary: "" }],
      }),
    );
    expect(slices.map((s) => s.key)).toEqual(["adoption", "recency", "review", "reproduction"]);
  });

  test("empty scalar dimensions are omitted from slices", () => {
    const slices = toSlices(makeFrontier({ byAdoption: [{ cid: "a", value: 1, summary: "" }] }));
    expect(slices.map((s) => s.key)).toEqual(["adoption"]);
  });

  test("each slice carries a non-empty signalDescription", () => {
    const slices = toSlices(
      makeFrontier({
        byAdoption: [{ cid: "a", value: 1, summary: "" }],
        byRecency: [{ cid: "r", value: 1, summary: "" }],
        byReviewScore: [{ cid: "v", value: 4, summary: "" }],
        byReproduction: [{ cid: "p", value: 1, summary: "" }],
      }),
    );
    for (const s of slices) {
      expect(s.signalDescription.length).toBeGreaterThan(0);
    }
  });
});
