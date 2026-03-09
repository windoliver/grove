# Frontier Algorithm

> Work in progress. See issue #5.

## Multi-Signal Ranking

The frontier is not a single leaderboard. It is a family of filtered,
queryable rankings along multiple dimensions:

- **By metric** — best score per named metric
- **By adoption** — most-adopted contributions
- **By recency** — most recent contributions
- **By review score** — highest average review scores

## Exploration Mode

Contributions with `mode: "exploration"` may have no scores.
They appear in all frontier dimensions except by-metric.
