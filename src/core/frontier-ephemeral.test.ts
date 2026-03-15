import { describe, expect, test } from "bun:test";

import { DefaultFrontierCalculator } from "./frontier.js";
import { ContributionMode, ScoreDirection } from "./models.js";
import { makeContribution, makeScore } from "./test-helpers.js";
import { InMemoryContributionStore } from "./testing.js";

// ---------------------------------------------------------------------------
// Ephemeral contribution exclusion from frontier
// ---------------------------------------------------------------------------

describe("frontier ephemeral exclusion", () => {
  test("ephemeral contributions are excluded from byRecency", async () => {
    const store = new InMemoryContributionStore();
    const calculator = new DefaultFrontierCalculator(store);

    const regular = makeContribution({
      summary: "regular-work",
      createdAt: "2026-01-01T00:00:00Z",
    });
    const ephemeral = makeContribution({
      summary: "ephemeral-message",
      context: { ephemeral: true, message_body: "hi" },
      createdAt: "2026-01-02T00:00:00Z",
    });

    await store.putMany([regular, ephemeral]);
    const frontier = await calculator.compute();

    expect(frontier.byRecency).toHaveLength(1);
    expect(frontier.byRecency[0]?.cid).toBe(regular.cid);
  });

  test("ephemeral contributions are excluded from byMetric", async () => {
    const store = new InMemoryContributionStore();
    const calculator = new DefaultFrontierCalculator(store);

    const regular = makeContribution({
      summary: "evaluated-work",
      mode: ContributionMode.Evaluation,
      scores: { loss: makeScore({ value: 0.5, direction: ScoreDirection.Minimize }) },
      createdAt: "2026-01-01T00:00:00Z",
    });
    const ephemeral = makeContribution({
      summary: "ephemeral-with-score",
      mode: ContributionMode.Evaluation,
      scores: { loss: makeScore({ value: 0.1, direction: ScoreDirection.Minimize }) },
      context: { ephemeral: true },
      createdAt: "2026-01-02T00:00:00Z",
    });

    await store.putMany([regular, ephemeral]);
    const frontier = await calculator.compute();

    // The ephemeral contribution has a better score but should be excluded
    expect(frontier.byMetric.loss).toHaveLength(1);
    expect(frontier.byMetric.loss?.[0]?.cid).toBe(regular.cid);
  });

  test("non-ephemeral contributions are still included normally", async () => {
    const store = new InMemoryContributionStore();
    const calculator = new DefaultFrontierCalculator(store);

    const c1 = makeContribution({
      summary: "work-a",
      createdAt: "2026-01-01T00:00:00Z",
    });
    const c2 = makeContribution({
      summary: "work-b",
      createdAt: "2026-01-02T00:00:00Z",
    });
    const c3 = makeContribution({
      summary: "work-c",
      context: { someKey: "value" }, // has context but NOT ephemeral
      createdAt: "2026-01-03T00:00:00Z",
    });

    await store.putMany([c1, c2, c3]);
    const frontier = await calculator.compute();

    expect(frontier.byRecency).toHaveLength(3);
  });

  test("ephemeral contributions with scores are excluded from metric ranking", async () => {
    const store = new InMemoryContributionStore();
    const calculator = new DefaultFrontierCalculator(store);

    const regular1 = makeContribution({
      summary: "regular-eval-1",
      mode: ContributionMode.Evaluation,
      scores: {
        acc: makeScore({ value: 0.8, direction: ScoreDirection.Maximize }),
        loss: makeScore({ value: 0.3, direction: ScoreDirection.Minimize }),
      },
      createdAt: "2026-01-01T00:00:00Z",
    });
    const regular2 = makeContribution({
      summary: "regular-eval-2",
      mode: ContributionMode.Evaluation,
      scores: {
        acc: makeScore({ value: 0.9, direction: ScoreDirection.Maximize }),
        loss: makeScore({ value: 0.2, direction: ScoreDirection.Minimize }),
      },
      createdAt: "2026-01-02T00:00:00Z",
    });
    const ephemeral = makeContribution({
      summary: "ephemeral-eval",
      mode: ContributionMode.Evaluation,
      scores: {
        acc: makeScore({ value: 0.99, direction: ScoreDirection.Maximize }),
        loss: makeScore({ value: 0.01, direction: ScoreDirection.Minimize }),
      },
      context: { ephemeral: true, usage_report: { input_tokens: 100, output_tokens: 50 } },
      createdAt: "2026-01-03T00:00:00Z",
    });

    await store.putMany([regular1, regular2, ephemeral]);
    const frontier = await calculator.compute();

    // Ephemeral should be completely excluded from metric rankings
    expect(frontier.byMetric.acc).toHaveLength(2);
    expect(frontier.byMetric.acc?.[0]?.cid).toBe(regular2.cid);
    expect(frontier.byMetric.acc?.[1]?.cid).toBe(regular1.cid);

    expect(frontier.byMetric.loss).toHaveLength(2);
    expect(frontier.byMetric.loss?.[0]?.cid).toBe(regular2.cid);
    expect(frontier.byMetric.loss?.[1]?.cid).toBe(regular1.cid);

    // Ephemeral also excluded from recency
    expect(frontier.byRecency).toHaveLength(2);
    const recencyCids = frontier.byRecency.map((e) => e.cid);
    expect(recencyCids).not.toContain(ephemeral.cid);
  });
});
