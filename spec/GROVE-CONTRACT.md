# GROVE.md — Repo-Owned Workflow Contract

> Specification for the GROVE.md contract format.
> See `schemas/grove-contract.json` for the JSON Schema.

## Overview

Every grove SHOULD have a `GROVE.md` file at its root that defines the
workflow contract for that grove. GROVE.md is the machine-readable
contract that agents must follow — it specifies metrics, contribution
gates, stop conditions, agent constraints, and claim policy.

### Relationship to AGENTS.md

- **AGENTS.md** tells agents about the project (general guidance,
  toolchain, conventions)
- **GROVE.md** tells agents about the grove workflow (specific contract,
  enforceable rules)

Both can coexist. GROVE.md is the machine-readable, schema-validated
contract; AGENTS.md is the human-readable project guide.

## File Format

GROVE.md uses **YAML frontmatter** delimited by `---` lines, followed
by a **Markdown body**.

```
---
contract_version: 1
name: my-grove
description: What this grove is about
...
---

# My Grove

Free-form prose for human/agent-readable context...
```

- **Frontmatter**: Validated against `schemas/grove-contract.json`
  (JSON Schema 2020-12). Uses **snake_case** field names, matching
  all other Grove schemas.
- **Markdown body**: Free-form prose. Not validated by the schema.
  Use it for contribution guidelines, context, and human-readable
  documentation that complements the structured frontmatter.

---

## Contract Version

Every GROVE.md MUST include a `contract_version` field. Two versions
are currently supported:

- **Version 1**: Legacy format with `claim_policy` for basic claim
  coordination. Suitable for simple groves with minimal enforcement.
- **Version 2**: Extended format with `concurrency`, `execution`,
  `rate_limits`, and `retry` sections for fine-grained control.

V1 contracts are auto-migrated to V2 types at parse time. New groves
SHOULD use version 2.

Unknown properties are **rejected** (strict validation). This catches
typos immediately rather than silently ignoring misspelled fields like
`stop_condition` instead of `stop_conditions`.

---

## Grove Metadata

| Field | Required | Type | Description |
|-------|----------|------|-------------|
| `contract_version` | Yes | integer | `1` or `2` |
| `name` | Yes | string | Human/agent-readable name (1-128 chars) |
| `description` | No | string | What this grove is about (max 1024 chars) |
| `mode` | No | enum | Default contribution mode: `evaluation` or `exploration` |
| `seed` | No | string | Reference to the seed contribution (max 256 chars) |

The `mode` field sets the default contribution mode for the grove.
Individual contributions may override this. When omitted, no default
is enforced — contributors choose their own mode.

---

## Metric Definitions

The `metrics` section defines named metrics with scoring direction and
optional gate thresholds.

```yaml
metrics:
  val_bpb:
    direction: minimize
    unit: bpb
    description: Validation bits-per-byte on WikiText-103
    gate: 1.5
  throughput:
    direction: maximize
    unit: tokens/sec
```

### Fields

| Field | Required | Type | Description |
|-------|----------|------|-------------|
| `direction` | Yes | enum | `minimize` or `maximize` |
| `unit` | No | string | Human-readable unit label (max 64 chars) |
| `description` | No | string | What this metric measures (max 256 chars) |
| `gate` | No | number | Threshold for frontier inclusion |

### Metric Names

Metric names MUST match `^[a-z][a-z0-9_]*$` — lowercase letters,
digits, and underscores, starting with a letter. Maximum 64 characters.
Maximum 50 metrics per grove.

### Gate Semantics

The `gate` field sets a threshold for frontier inclusion:

- For `minimize` metrics: contributions must score **at or below**
  the gate value
- For `maximize` metrics: contributions must score **at or above**
  the gate value

Contributions that fail the gate are still stored in the DAG but are
not included in frontier rankings for that metric.

---

## Contribution Gates

The `gates` section defines declarative rules that must pass before a
contribution is accepted to the frontier.

```yaml
gates:
  - type: metric_improves
    metric: val_bpb
  - type: has_artifact
    name: run.log
  - type: min_reviews
    count: 1
    threshold: 0.6
```

### Gate Types

| Type | Description | Required Fields |
|------|-------------|-----------------|
| `metric_improves` | Contribution must improve a metric over its parent | `metric` |
| `has_artifact` | Contribution must include a named artifact | `name` |
| `has_relation` | Contribution must have a relation of the given type | `relation_type` |
| `min_reviews` | Contribution must have N reviews (optionally above a score threshold) | `count`, optional `threshold` |
| `min_score` | Contribution must meet a minimum score on a metric (raw metric value) | `metric`, `threshold` |

### Field Applicability

The schema enforces required fields per gate type via `if`/`then`
conditional validation. Unknown fields are rejected by
`unevaluatedProperties: false`. Only the fields listed below are
permitted for each gate type.

| Gate Type | `metric` | `name` | `relation_type` | `count` | `threshold` |
|-----------|----------|--------|------------------|---------|-------------|
| `metric_improves` | Required | — | — | — | — |
| `has_artifact` | — | Required | — | — | — |
| `has_relation` | — | — | Required | — | — |
| `min_reviews` | — | — | — | Required | Optional |
| `min_score` | Required | — | — | — | Required |

### Threshold Semantics

The `threshold` field is an unrestricted number. Its meaning depends
on the gate type:

- **`min_reviews`**: Review score threshold (0-1 by convention, per
  RELATIONS.md review metadata). Not enforced by the schema.
- **`min_score`**: Raw metric threshold in the metric's native units.
  For example, `threshold: 10` on a `latency_ms` metric means
  "latency must be at or below 10ms" (respecting the metric's
  direction).

### Cross-Section References

Gate fields that reference metrics (e.g., `metric_improves` with
`metric: "val_bpb"`) SHOULD reference metric names defined in the
`metrics` section. This cross-reference is NOT enforced by the JSON
Schema — it is a runtime validation concern.

Maximum 20 gates per grove.

---

## Stop Conditions

The `stop_conditions` section defines when the grove should stop
accepting new contributions. Multiple conditions may be specified;
the grove stops when **any** condition is met.

```yaml
stop_conditions:
  max_rounds_without_improvement: 10
  target_metric:
    metric: val_bpb
    value: 0.85
  budget:
    max_contributions: 500
    max_wall_clock_seconds: 86400
  quorum_review_score:
    min_reviews: 2
    min_score: 0.8
  deliberation_limit:
    max_rounds: 5
    max_messages: 100
```

### Condition Types

| Condition | Description |
|-----------|-------------|
| `max_rounds_without_improvement` | Auto-stop after N rounds with no frontier advance (1-1000) |
| `target_metric` | Stop when a metric reaches a target value |
| `budget` | Stop when contribution count or wall-clock time is exhausted |
| `quorum_review_score` | Stop when a contribution achieves review consensus |
| `deliberation_limit` | Cap discussion rounds or messages per topic |

### Target Metric Semantics

For `target_metric`, the comparison direction is determined by the
metric's direction in the `metrics` section:

- `minimize` metric: stop when score is **at or below** the target
- `maximize` metric: stop when score is **at or above** the target

### Budget

Budget accepts `max_contributions` (integer, >= 1) and/or
`max_wall_clock_seconds` (integer, >= 1). Either or both may be
specified. Wall-clock time is measured from grove creation.

### Quorum Review Score

Requires both `min_reviews` (1-100) and `min_score` (0-1). The grove
stops when any single contribution has at least `min_reviews` reviews
with an average score at or above `min_score`.

### Deliberation Limit

Caps discussion per topic. `max_rounds` (1-100) limits review/discussion
rounds; `max_messages` (1-1000) limits total messages. Either or both
may be specified.

---

## Agent Constraints

The `agent_constraints` section defines rules constraining agent
behavior within the grove.

```yaml
agent_constraints:
  allowed_kinds:
    - work
    - review
    - reproduction
  required_artifacts:
    work:
      - train.py
      - run.log
  required_relations:
    review:
      - reviews
```

### Fields

| Field | Description |
|-------|-------------|
| `allowed_kinds` | Contribution kinds agents may submit. If omitted, all kinds are allowed. Must contain at least one kind. |
| `required_artifacts` | Required artifact name patterns per contribution kind |
| `required_relations` | Required relation types per contribution kind |

### Allowed Kinds

When specified, agents MUST only submit contributions of the listed
kinds. Attempts to submit other kinds SHOULD be rejected. The array
must have at least one item and no duplicates.

When omitted, all five contribution kinds are allowed: `work`,
`review`, `discussion`, `adoption`, `reproduction`.

### Required Artifacts

Keys are contribution kinds; values are arrays of artifact name
patterns (strings, max 256 chars each, max 20 per kind). A
contribution of the specified kind MUST include artifacts matching
all listed patterns.

### Required Relations

Keys are contribution kinds; values are arrays of relation types.
A contribution of the specified kind MUST include at least one
relation of each listed type.

---

## Claim Policy (V1 only)

The `claim_policy` section configures claim coordination behavior.
This is a **version 1** feature — version 2 contracts use
`concurrency`, `execution`, `rate_limits`, and `retry` instead.

```yaml
claim_policy:
  default_lease_seconds: 600
  max_claims_per_agent: 2
  heartbeat_required: true
```

### Fields

| Field | Default | Range | Description |
|-------|---------|-------|-------------|
| `default_lease_seconds` | 300 | 30-86400 | Lease duration in seconds |
| `max_claims_per_agent` | (unlimited) | 0-100 | Max concurrent claims per agent. 0 = unlimited |
| `heartbeat_required` | `true` | boolean | Whether heartbeats are required |

### V1 → V2 Migration

V1 `claim_policy` fields are auto-migrated to V2 types at parse time:

- `default_lease_seconds` → `execution.defaultLeaseSeconds`
- `max_claims_per_agent` → `concurrency.maxClaimsPerAgent`
- `heartbeat_required: true` → `execution.heartbeatIntervalSeconds: 60`

---

## Concurrency Limits (V2)

The `concurrency` section controls how many claims can be active
simultaneously.

```yaml
concurrency:
  max_active_claims: 10
  max_claims_per_agent: 3
  max_claims_per_target: 1
```

### Fields

| Field | Range | Description |
|-------|-------|-------------|
| `max_active_claims` | 1-1000 | Global limit on active claims across all agents |
| `max_claims_per_agent` | 0-100 | Max claims per agent. 0 = unlimited |
| `max_claims_per_target` | 1-100 | Max claims per target_ref |

Attempts to create claims beyond these limits throw a
`ConcurrencyLimitError` with the limit type (`global`, `per_agent`,
or `per_target`) and current/limit values.

---

## Execution Settings (V2)

The `execution` section configures lease duration, heartbeat
intervals, and stall detection.

```yaml
execution:
  default_lease_seconds: 300
  max_lease_seconds: 3600
  heartbeat_interval_seconds: 60
  stall_timeout_seconds: 180
```

### Fields

| Field | Range | Description |
|-------|-------|-------------|
| `default_lease_seconds` | 30-86400 | Default lease duration |
| `max_lease_seconds` | 60-604800 | Maximum lease duration (1 week) |
| `heartbeat_interval_seconds` | 10-86400 | Expected heartbeat interval |
| `stall_timeout_seconds` | 60-604800 | Heartbeat silence before stall |

### Cross-field Constraints

- `default_lease_seconds` ≤ `max_lease_seconds` (when both specified)
- `heartbeat_interval_seconds` < `stall_timeout_seconds` (when both
  specified)

Claims requesting leases longer than `max_lease_seconds` are rejected
with a `LeaseViolationError`.

---

## Rate Limits (V2)

The `rate_limits` section throttles contribution submission rate and
artifact sizes.

```yaml
rate_limits:
  max_contributions_per_agent_per_hour: 100
  max_contributions_per_grove_per_hour: 1000
  max_artifact_size_bytes: 10485760
  max_artifacts_per_contribution: 10
```

### Fields

| Field | Range | Description |
|-------|-------|-------------|
| `max_contributions_per_agent_per_hour` | 1-10000 | Per-agent sliding window |
| `max_contributions_per_grove_per_hour` | 1-100000 | Per-grove sliding window |
| `max_artifact_size_bytes` | 1+ | Max size of a single artifact |
| `max_artifacts_per_contribution` | 1-1000 | Max artifacts per contribution |

Rate limits use a 1-hour sliding window. Exceeding a limit throws a
`RateLimitError` with `retryAfterMs` indicating when a slot opens.

### Cross-field Constraint

- `max_contributions_per_agent_per_hour` ≤
  `max_contributions_per_grove_per_hour` (when both specified)

---

## Retry Settings (V2)

The `retry` section configures exponential backoff for retrying
failed operations.

```yaml
retry:
  base_delay_ms: 1000
  max_backoff_ms: 60000
  max_attempts: 5
```

### Fields

| Field | Range | Description |
|-------|-------|-------------|
| `base_delay_ms` | 100-600000 | Base delay for exponential backoff |
| `max_backoff_ms` | 1000-3600000 | Maximum backoff cap |
| `max_attempts` | 1-100 | Maximum retry attempts |

The backoff algorithm uses **full jitter**: for attempt `n`, the
delay is `random(0, min(cap, base * 2^n))`. This prevents thundering
herd problems when multiple agents retry simultaneously.

---

## Dynamic Reload

Implementations (CLI, server) SHOULD re-read GROVE.md before each
dispatch cycle. This allows grove operators to adjust policy without
restarting services.

### Reload Semantics

- **Valid changes**: Applied immediately. Changes to stop conditions,
  gates, and claim policy take effect on the next dispatch cycle.
- **Invalid changes**: Keep last known good configuration. Log a
  warning but do not crash or reject new contributions.
- **Missing GROVE.md**: If the file is deleted, keep last known good
  configuration. If no prior configuration exists, operate with
  protocol defaults (no gates, no stop conditions, default claim
  policy).

---

## Implementation Notes

GROVE.md files are expected to be small — typically under 100 lines
of frontmatter and under 500 lines total including the Markdown body.
Parse-and-validate overhead should be negligible (< 10ms for typical
files on modern hardware).

Cross-section references (e.g., a gate's `metric` field referencing
a name in the `metrics` section, or a `target_metric` stop condition
referencing a defined metric) are **not** enforced by the JSON Schema.
These are runtime validation concerns — the schema validates
structure, runtime code validates semantics.

---

## Examples

See `spec/examples/` for complete GROVE.md examples:

- **`autoresearch.grove.md`** — LLM pretraining optimization with
  exploration mode, multiple metrics, and budget-based stop conditions
- **`code-optimization.grove.md`** — CUDA kernel optimization with
  evaluation mode, required reviews, and quorum-based stop conditions

---

## Gossip Settings (V2)

The `gossip` section configures server-to-server gossip protocol
parameters. These settings only apply when gossip is enabled on the
grove-server (via `GOSSIP_SEEDS` environment variable).

```yaml
gossip:
  interval_seconds: 30
  fan_out: 3
  partial_view_size: 10
  shuffle_length: 5
  suspicion_timeout_seconds: 90
  failure_timeout_seconds: 150
  digest_limit: 5
```

### Fields

| Field | Range | Default | Description |
|-------|-------|---------|-------------|
| `interval_seconds` | 5-3600 | 30 | Base gossip round interval |
| `fan_out` | 1-20 | 3 | Peers contacted per frontier exchange round |
| `partial_view_size` | 2-100 | 10 | Maximum entries in CYCLON partial view |
| `shuffle_length` | 1-50 | 5 | Entries exchanged per CYCLON shuffle |
| `suspicion_timeout_seconds` | 10-3600 | 90 | Silence before suspecting a peer |
| `failure_timeout_seconds` | 30-7200 | 150 | Silence before declaring a peer failed |
| `digest_limit` | 1-50 | 5 | Top-K entries per frontier dimension in digest |

### Cross-field Constraints

- `suspicion_timeout_seconds` < `failure_timeout_seconds` (when both
  specified)
- `shuffle_length` ≤ `partial_view_size` (when both specified)

### Interaction with Environment Variables

`GOSSIP_SEEDS` (env var) provides the initial peer list. The gossip
section in GROVE.md configures protocol parameters. If both are
present, GROVE.md settings override the compiled defaults.

---

## Wire Format

The canonical wire format for the frontmatter uses **snake_case**
field names, matching all other Grove schemas. See
`schemas/grove-contract.json` for the full JSON Schema (2020-12).

The schema uses cross-file `$ref` to shared type definitions in
`contribution.json`:

- `mode` → `contribution_mode` enum
- `metric_definition.direction` → `score_direction` enum
- `gate.relation_type` → `relation_type` enum
- `agent_constraints.allowed_kinds` items → `contribution_kind` enum
- `relation_requirements` items → `relation_type` enum

This ensures enum values stay in sync across schemas without
duplication.
