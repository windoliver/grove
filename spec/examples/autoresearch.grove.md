---
contract_version: 1
name: llm-pretraining-optimization
description: >
  Autoresearch grove for improving LLM pretraining performance.
  Agents explore architecture changes, hyperparameter tuning,
  and training tricks to minimize validation bits-per-byte.
mode: exploration
seed: "initial-baseline-run"

metrics:
  val_bpb:
    direction: minimize
    unit: bpb
    description: Validation bits-per-byte on WikiText-103
    gate: 1.5
  train_loss:
    direction: minimize
    unit: nats
    description: Training loss at 10k steps
  throughput:
    direction: maximize
    unit: tokens/sec
    description: Training throughput in tokens per second

gates:
  - type: metric_improves
    metric: val_bpb
  - type: has_artifact
    name: run.log

stop_conditions:
  max_rounds_without_improvement: 10
  target_metric:
    metric: val_bpb
    value: 0.85
  budget:
    max_contributions: 500
    max_wall_clock_seconds: 86400

agent_constraints:
  required_artifacts:
    work:
      - train.py
      - run.log
    reproduction:
      - run.log
  required_relations:
    review:
      - reviews
    reproduction:
      - reproduces

claim_policy:
  default_lease_seconds: 600
  max_claims_per_agent: 2
  heartbeat_required: true
---

# LLM Pretraining Optimization

This grove explores improvements to LLM pretraining with the goal of
minimizing validation bits-per-byte (val_bpb) on WikiText-103.

## Contribution Guidelines

### Work contributions

Work contributions should include:
- `train.py` — the training script or patch
- `run.log` — full training log with metrics at each checkpoint
- Scores for `val_bpb` and optionally `train_loss` and `throughput`

Exploration-mode contributions (novel architectures, speculative ideas)
are welcome even without benchmark scores. Switch to evaluation mode
once results are reproducible.

### Reviews

Reviews should evaluate:
- Correctness of the training setup
- Statistical significance of reported improvements
- Reproducibility of the approach

### Reproductions

Reproduction attempts should run the same training script on the same
dataset and report `val_bpb` within 5% of the original claim.

## Stop Conditions

This grove stops when:
- `val_bpb` reaches 0.85 or below
- 10 consecutive rounds produce no frontier improvement
- 500 total contributions are reached
- 24 hours of wall-clock time have elapsed
