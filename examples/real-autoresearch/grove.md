---
contract_version: 2
name: real-autoresearch
description: >
  Full replication of karpathy/autoresearch using grove for multi-agent
  coordination. Agents optimize train.py for lower val_bpb within a
  fixed 5-minute training budget per experiment.
mode: evaluation
metrics:
  val_bpb:
    direction: minimize
    unit: bpb
    description: Validation bits per byte — primary optimization target
  peak_vram_gb:
    direction: minimize
    unit: GB
    description: Peak VRAM usage during training
outcome_policy:
  auto_evaluate: true
  accept_if:
    metric: val_bpb
    condition: improved_over_parent
stop_conditions:
  no_improvement_rounds: 5
  max_rounds: 20
  target_metric:
    metric: val_bpb
    threshold: 0.85
  wall_clock_budget: "3h"
enforcement:
  claim_policy:
    max_concurrent: 3
    lease_duration: "10m"
concurrency:
  max_active_claims: 3
  max_claims_per_agent: 1
  max_claims_per_target: 1
rate_limits:
  max_contributions_per_agent_per_hour: 100
  max_contributions_per_grove_per_hour: 300
---
# Optimize GPT Training

Improve val_bpb by modifying train.py. Each experiment is a 5-minute training run.

## Rules
- Only modify train.py
- Do not change the training time budget (5 min)
- Do not change the evaluation methodology
- Report val_bpb and peak_vram_gb from training output
