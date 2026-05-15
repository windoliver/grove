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

describe("toSlices — metric:* dimensions", () => {
  test("a metric produces a 'metric:<name>' slice", () => {
    const slices = toSlices(
      makeFrontier({
        byMetric: { accuracy: [{ cid: "m1", value: 0.9, summary: "" }] },
      }),
    );
    expect(slices.length).toBe(1);
    expect(slices[0]?.key).toBe("metric:accuracy");
    expect(slices[0]?.label).toBe("accuracy");
  });

  test("metric slices follow built-ins and are alphabetical", () => {
    const slices = toSlices(
      makeFrontier({
        byAdoption: [{ cid: "a", value: 1, summary: "" }],
        byMetric: {
          zeta: [{ cid: "z", value: 1, summary: "" }],
          alpha: [{ cid: "al", value: 1, summary: "" }],
          mu: [{ cid: "m", value: 1, summary: "" }],
        },
      }),
    );
    expect(slices.map((s) => s.key)).toEqual([
      "adoption",
      "metric:alpha",
      "metric:mu",
      "metric:zeta",
    ]);
  });

  test("empty metric arrays are omitted", () => {
    const slices = toSlices(makeFrontier({ byMetric: { empty: [] } }));
    expect(slices).toEqual([]);
  });

  test("metric slice signalDescription mentions the metric name", () => {
    const slices = toSlices(
      makeFrontier({ byMetric: { rouge_l: [{ cid: "r", value: 0.8, summary: "" }] } }),
    );
    expect(slices[0]?.signalDescription).toContain("rouge_l");
  });
});

describe("toSlices — formatBadge per signal", () => {
  test("adoption: '×N adopters'", () => {
    const slices = toSlices(makeFrontier({ byAdoption: [{ cid: "a", value: 12, summary: "" }] }));
    expect(slices[0]?.formatBadge(slices[0].entries[0]!)).toBe("×12 adopters");
  });

  test("reproduction: '▲N confirmed'", () => {
    const slices = toSlices(
      makeFrontier({ byReproduction: [{ cid: "r", value: 3, summary: "" }] }),
    );
    expect(slices[0]?.formatBadge(slices[0].entries[0]!)).toBe("▲3 confirmed");
  });

  test("review: 'X.X⋆' rounded to one decimal", () => {
    const slices = toSlices(
      makeFrontier({ byReviewScore: [{ cid: "v", value: 4.73, summary: "" }] }),
    );
    expect(slices[0]?.formatBadge(slices[0].entries[0]!)).toBe("4.7⋆");
  });

  test("recency: relative time string", () => {
    const fiveMinAgo = Date.now() - 5 * 60 * 1000;
    const slices = toSlices(
      makeFrontier({ byRecency: [{ cid: "rc", value: fiveMinAgo, summary: "" }] }),
    );
    expect(slices[0]?.formatBadge(slices[0].entries[0]!)).toMatch(/^\d+m ago$/);
  });

  test("metric:*: '0.812 <name>' to 3 decimals", () => {
    const slices = toSlices(
      makeFrontier({ byMetric: { rouge_l: [{ cid: "m", value: 0.812345, summary: "" }] } }),
    );
    expect(slices[0]?.formatBadge(slices[0].entries[0]!)).toBe("0.812 rouge_l");
  });
});
