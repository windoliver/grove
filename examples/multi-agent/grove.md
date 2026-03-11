---
contract_version: 2
name: multi-agent-validation
description: >
  End-to-end validation of multi-agent collaboration through grove.
  Agents self-coordinate via frontier, claims, and contributions.
mode: evaluation
metrics:
  throughput:
    direction: maximize
    unit: ops/sec
    description: Operations per second of the optimized code
  latency_p99:
    direction: minimize
    unit: ms
    description: P99 latency in milliseconds
stop_conditions:
  max_rounds_without_improvement: 5
  target_metric:
    metric: throughput
    value: 10000
  budget:
    max_contributions: 20
  quorum_review_score:
    min_reviews: 2
    min_score: 0.8
concurrency:
  max_active_claims: 3
  max_claims_per_agent: 1
  max_claims_per_target: 1
rate_limits:
  max_contributions_per_agent_per_hour: 50
  max_contributions_per_grove_per_hour: 150
---

# Multi-Agent Collaboration Validation

Three agents collaborate to optimize code throughput:

- **Agent A** (Claude Code): Implements optimizations
- **Agent B** (Codex): Reviews contributions and suggests improvements
- **Agent C** (Claude Code): Reproduces results and validates claims

Agents self-coordinate through grove's shared state — no central orchestrator.
