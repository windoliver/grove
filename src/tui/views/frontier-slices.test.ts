import { describe, expect, test } from "bun:test";
import type { Frontier } from "../../core/frontier.js";
import { slicesEqual, toSlices } from "./frontier-slices.js";

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

describe("slicesEqual", () => {
  function fixture() {
    return makeFrontier({
      byAdoption: [{ cid: "a", value: 5, summary: "s" }],
      byMetric: { acc: [{ cid: "m", value: 0.9, summary: "ms" }] },
    });
  }

  test("same array reference → true", () => {
    const slices = toSlices(fixture());
    expect(slicesEqual(slices, slices)).toBe(true);
  });

  test("equal content, different references → true", () => {
    expect(slicesEqual(toSlices(fixture()), toSlices(fixture()))).toBe(true);
  });

  test("different lengths → false", () => {
    const a = toSlices(fixture());
    const b = toSlices(makeFrontier({ byAdoption: [{ cid: "a", value: 5, summary: "s" }] }));
    expect(slicesEqual(a, b)).toBe(false);
  });

  test("different value → false", () => {
    const a = toSlices(makeFrontier({ byAdoption: [{ cid: "a", value: 5, summary: "" }] }));
    const b = toSlices(makeFrontier({ byAdoption: [{ cid: "a", value: 6, summary: "" }] }));
    expect(slicesEqual(a, b)).toBe(false);
  });

  test("different cid → false", () => {
    const a = toSlices(makeFrontier({ byAdoption: [{ cid: "a", value: 5, summary: "" }] }));
    const b = toSlices(makeFrontier({ byAdoption: [{ cid: "b", value: 5, summary: "" }] }));
    expect(slicesEqual(a, b)).toBe(false);
  });

  test("different slice key → false", () => {
    const a = toSlices(makeFrontier({ byAdoption: [{ cid: "x", value: 1, summary: "" }] }));
    const b = toSlices(makeFrontier({ byRecency: [{ cid: "x", value: 1, summary: "" }] }));
    expect(slicesEqual(a, b)).toBe(false);
  });

  test("different entry order → false", () => {
    const a = toSlices(
      makeFrontier({
        byAdoption: [
          { cid: "x", value: 5, summary: "" },
          { cid: "y", value: 4, summary: "" },
        ],
      }),
    );
    const b = toSlices(
      makeFrontier({
        byAdoption: [
          { cid: "y", value: 4, summary: "" },
          { cid: "x", value: 5, summary: "" },
        ],
      }),
    );
    expect(slicesEqual(a, b)).toBe(false);
  });

  test("different summary → false (summary feeds adopt context)", () => {
    const a = toSlices(makeFrontier({ byAdoption: [{ cid: "x", value: 5, summary: "old" }] }));
    const b = toSlices(makeFrontier({ byAdoption: [{ cid: "x", value: 5, summary: "new" }] }));
    expect(slicesEqual(a, b)).toBe(false);
  });
});

describe("toSlices — metric bounds + sanitization", () => {
  test("caps metric:* slices at MAX_METRIC_SLICES", () => {
    const byMetric: Record<string, readonly { cid: string; value: number; summary: string }[]> = {};
    for (let i = 0; i < 50; i++) {
      byMetric[`m${String(i).padStart(3, "0")}`] = [{ cid: `cid-${i}`, value: i, summary: "" }];
    }
    const slices = toSlices(makeFrontier({ byMetric }));
    const metricSlices = slices.filter((s) => s.key.startsWith("metric:"));
    // Cap is 16 per src/tui/views/frontier-slices.ts MAX_METRIC_SLICES.
    expect(metricSlices.length).toBe(16);
  });

  test("strips control characters from metric names", () => {
    const slices = toSlices(
      makeFrontier({
        byMetric: { "\x07bell\x1bescape": [{ cid: "c", value: 1, summary: "" }] },
      }),
    );
    expect(slices[0]?.label).toBe("bellescape");
    expect(slices[0]?.key).toBe("metric:bellescape");
  });

  test("truncates very long metric names", () => {
    const longName = "x".repeat(200);
    const slices = toSlices(
      makeFrontier({ byMetric: { [longName]: [{ cid: "c", value: 1, summary: "" }] } }),
    );
    // MAX_METRIC_LABEL_LEN = 32 → truncated to 31 chars + "…"
    expect(slices[0]?.label.length).toBeLessThanOrEqual(32);
    expect(slices[0]?.label.endsWith("…")).toBe(true);
  });

  test("metric name that becomes empty after sanitization is dropped", () => {
    const slices = toSlices(
      makeFrontier({ byMetric: { "\x00\x01\x02": [{ cid: "c", value: 1, summary: "" }] } }),
    );
    expect(slices.filter((s) => s.key.startsWith("metric:")).length).toBe(0);
  });

  test("control-only names do NOT consume the metric cap", () => {
    // 16 control-only names (each a distinct single control char, all sort
    // before printable ASCII) must be sanitized AND dropped BEFORE the cap,
    // so a valid name that sorts later still renders.
    const byMetric: Record<string, readonly { cid: string; value: number; summary: string }[]> = {};
    for (let i = 1; i <= 16; i++) {
      // \\x01..\\x10 — each sanitizes to "" so all should be skipped.
      byMetric[String.fromCharCode(i).repeat(3)] = [{ cid: `bad-${i}`, value: i, summary: "" }];
    }
    byMetric.valid_metric = [{ cid: "ok", value: 1, summary: "" }];
    const slices = toSlices(makeFrontier({ byMetric }));
    const labels = slices.filter((s) => s.key.startsWith("metric:")).map((s) => s.label);
    expect(labels).toContain("valid_metric");
  });

  test("hard-caps the raw keyspace before sorting (large-cardinality DoS guard)", () => {
    // Generate 5000 distinct metric names. Without MAX_RAW_METRIC_KEYS the
    // sort would scan all 5000; with the cap the projection still completes
    // quickly and produces some valid slices. We assert the projection
    // returns the expected slice count and runs in < 200ms (sort + sanitize
    // bounded by MAX_RAW_METRIC_KEYS=1024).
    const byMetric: Record<string, readonly { cid: string; value: number; summary: string }[]> = {};
    for (let i = 0; i < 5000; i++) {
      byMetric[`metric_${String(i).padStart(5, "0")}`] = [{ cid: `c-${i}`, value: i, summary: "" }];
    }
    const start = Date.now();
    const slices = toSlices(makeFrontier({ byMetric }));
    const elapsed = Date.now() - start;
    expect(slices.filter((s) => s.key.startsWith("metric:")).length).toBe(16);
    expect(elapsed).toBeLessThan(200);
  });

  test("metric cap takes alphabetically-first valid metrics, not enumeration order", () => {
    // Insert 16 'zzz_' metrics first (V8 iteration order), then a single
    // 'aaa_' metric. Pre-fix: cap fills on the 16 zzz before reaching aaa
    // and aaa is hidden. Post-fix: collect all valid, sort, then cap →
    // aaa_important is included.
    const byMetric: Record<string, readonly { cid: string; value: number; summary: string }[]> = {};
    for (let i = 0; i < 16; i++) {
      byMetric[`zzz_filler_${String(i).padStart(2, "0")}`] = [
        { cid: `f-${i}`, value: i, summary: "" },
      ];
    }
    byMetric.aaa_important = [{ cid: "ok", value: 99, summary: "" }];
    const slices = toSlices(makeFrontier({ byMetric }));
    const labels = slices.filter((s) => s.key.startsWith("metric:")).map((s) => s.label);
    expect(labels[0]).toBe("aaa_important");
    expect(labels.length).toBe(16);
  });

  test("two raw names that sanitize to the same string both render with ordinal suffix", () => {
    // "rouge" and "rouge\\x07" both sanitize to "rouge". The second must get
    // "rouge#2" so neither slice shadows the other.
    const byMetric = {
      rouge: [{ cid: "a", value: 1, summary: "" }],
      "rouge\x07": [{ cid: "b", value: 2, summary: "" }],
    };
    const slices = toSlices(makeFrontier({ byMetric }));
    const labels = slices.filter((s) => s.key.startsWith("metric:")).map((s) => s.label);
    expect(labels).toEqual(["rouge", "rouge#2"]);
  });
});
