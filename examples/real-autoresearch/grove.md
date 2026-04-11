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
  auto_accept:
    metric_improves: val_bpb
stop_conditions:
  max_rounds_without_improvement: 5
  target_metric:
    metric: val_bpb
    value: 0.85
  budget:
    max_wall_clock_seconds: 10800
  deliberation_limit:
    max_rounds: 20
concurrency:
  max_active_claims: 3
  max_claims_per_agent: 1
  max_claims_per_target: 1
execution:
  default_lease_seconds: 600
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
