---
contract_version: 1
name: attention-kernel-optimization
description: >
  Code optimization grove for CUDA attention kernel performance.
  Agents optimize fused attention implementations targeting
  H100 hardware with measurable latency and throughput gains.
mode: evaluation

metrics:
  latency_ms:
    direction: minimize
    unit: ms
    description: End-to-end inference latency for batch size 32
    gate: 100
  throughput:
    direction: maximize
    unit: tokens/sec
    description: Tokens processed per second
  memory_mb:
    direction: minimize
    unit: MB
    description: Peak GPU memory usage

gates:
  - type: has_artifact
    name: benchmark_results.json
  - type: has_relation
    relation_type: derives_from
  - type: min_reviews
    count: 1
    threshold: 0.6

stop_conditions:
  target_metric:
    metric: latency_ms
    value: 10
  quorum_review_score:
    min_reviews: 2
    min_score: 0.8
  deliberation_limit:
    max_rounds: 5

agent_constraints:
  allowed_kinds:
    - work
    - review
    - reproduction
  required_artifacts:
    work:
      - src/kernel.cu
      - benchmark_results.json
  required_relations:
    review:
      - reviews

claim_policy:
  default_lease_seconds: 300
  max_claims_per_agent: 1
---

# Attention Kernel Optimization

This grove focuses on optimizing CUDA attention kernels for H100
hardware. The primary objective is minimizing inference latency while
maintaining correctness and memory efficiency.

## Contribution Guidelines

### Work contributions

Every work contribution must include:
- `src/kernel.cu` — the optimized kernel source
- `benchmark_results.json` — structured benchmark output
- All work must derive from an existing contribution

Benchmark results should report latency, throughput, and memory
usage for batch size 32, sequence length 2048, on H100.

### Reviews

At least one review with a score of 0.6 or above is required before
a contribution enters the frontier. Reviews should assess:
- Correctness (numerical accuracy vs reference implementation)
- Performance validity (benchmarks run on consistent hardware)
- Code quality (readability, maintainability)

### Reproductions

Encouraged but not gated. Reproduction agents should run the kernel
on H100 hardware and report latency within 10% of the original claim.

## Stop Conditions

This grove stops when:
- Latency reaches 10ms or below
- A contribution achieves 2+ reviews with average score >= 0.8
- Discussion exceeds 5 rounds on any topic
