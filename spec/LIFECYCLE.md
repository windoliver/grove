# Contribution Lifecycle and Stop Conditions

> Derived lifecycle states and stop condition evaluation semantics.
> See `GROVE-CONTRACT.md` for the stop condition configuration format.

## Overview

Grove contributions have **derived lifecycle states** — states computed
from the graph structure rather than stored explicitly. This keeps the
core contribution model immutable while providing rich status information.

Stop conditions are configurable policies (defined in GROVE.md) that
signal when a grove or branch of work should pause or conclude.

---

## Lifecycle States

Every contribution has exactly one primary lifecycle state, determined
by examining its incoming relations. States are listed in **descending
precedence** — when multiple conditions apply, the highest-precedence
state wins.

| State | Precedence | Derived From |
|-------|-----------|--------------|
| `superseded` | 1 (highest) | Has incoming `derives_from` relation where the source explicitly supersedes this contribution (via `metadata.relationship === "supersedes"`) |
| `challenged` | 2 | Has incoming `reproduces` relation with `metadata.result === "challenged"` |
| `adopted` | 3 | Has incoming `adopts` relation |
| `reproduced` | 4 | Has incoming `reproduces` relation with `result !== "challenged"` (confirmed, partial, or absent) |
| `under_review` | 5 | Has incoming `reviews` relation but no `adopts`, confirmed `reproduces`, or superseding relation |
| `published` | 6 | Stored in the DAG with no incoming relations that trigger a higher state |
| `draft` | 7 (lowest) | Reserved for future use — contributions saved locally but not yet published to the DAG |

### Precedence Rules

1. `superseded` always wins. If a newer contribution explicitly
   supersedes this one, that is the strongest signal.
2. `challenged` beats `reproduced`. A conflicting reproduction result
   is a red flag that overrides confirmations.
3. `adopted` beats `reproduced`. Adoption is a stronger endorsement
   than reproduction alone.
4. `reproduced` beats `under_review`. A confirmed reproduction is a
   stronger signal than pending reviews.
5. `under_review` is the default when reviews exist but no other
   signals have arrived.
6. `published` is the base state for any contribution in the DAG.
7. `draft` is not currently implemented — reserved for local-only
   staging in future versions.

### State Derivation Algorithm

For a given contribution CID:

```
1. Query all incoming relations (contributions that reference this CID)
2. Check for superseding derives_from relations → superseded
3. Check for challenged reproduces relations → challenged
4. Check for adopts relations → adopted
5. Check for confirmed/partial reproduces relations → reproduced
6. Check for reviews relations → under_review
7. Default → published
```

Each check short-circuits: the first matching condition determines the
primary state.

### Batch Derivation

For efficiency when computing states for many contributions (e.g.,
`grove status`), implementations SHOULD load all contributions and
relations in a single query, then compute states in-memory. This avoids
O(N) individual queries.

---

## Stop Conditions

Stop conditions are defined in GROVE.md (see `GROVE-CONTRACT.md` §Stop
Conditions) and evaluated against the current grove state. Multiple
conditions may be defined; the grove stops when **any** condition is met.

### Evaluation Semantics

#### `max_rounds_without_improvement`

**Definition of "round":** One round equals one contribution. The round
counter increments with each contribution published to the grove.

**Evaluation:** Order all contributions by `created_at` ascending. For
each metric defined in the contract, check whether any of the last N
contributions set a new best score (where N is the configured limit).
If no metric has improved in the last N contributions, the condition
is met.

**Edge cases:**
- Fewer than N total contributions → condition not met (not enough data)
- No metrics defined → condition not met (nothing to improve)
- Exploration-mode contributions are counted as rounds but do not
  contribute to metric improvement (they have no comparable scores)

#### `target_metric`

**Evaluation:** Check whether the best score for the named metric has
reached the target value. "Best" respects the metric's direction:
- `minimize`: best score is at or below the target → condition met
- `maximize`: best score is at or above the target → condition met

**Edge cases:**
- Named metric has no scores yet → condition not met
- Named metric is not defined in the contract → condition not met
  (runtime validation warning)

#### `budget`

**`max_contributions`:** Count all contributions in the store. If the
count is at or above the limit, the condition is met.

**`max_wall_clock_seconds`:** Compute elapsed time as:
`now - min(created_at)` across all contributions. The grove's "start
time" is the `created_at` of its first contribution. If elapsed seconds
are at or above the limit, the condition is met.

**Edge cases:**
- Empty grove (no contributions) → neither budget condition is met
- Only one of `max_contributions` / `max_wall_clock_seconds` specified →
  only the specified condition is evaluated
- Both specified → the condition is met if **either** is exceeded

#### `quorum_review_score`

**Evaluation:** For each contribution in the grove, count its incoming
`reviews` relations and compute the average review score (from
`metadata.score`). If any contribution has at least `min_reviews`
reviews with an average score at or above `min_score`, the condition
is met.

**Edge cases:**
- Reviews without `metadata.score` are counted toward `min_reviews`
  but do not contribute to the average score calculation
- If a contribution has `min_reviews` reviews but none have scores,
  the average is undefined and the condition is not met
- Score values outside 0-1 are accepted (the schema convention is
  0-1 but this is not enforced)

#### `deliberation_limit`

**Definition of "topic":** A topic is any contribution that is the root
of a `responds_to` chain. A contribution is a topic root if no other
contribution in the chain has it as a `responds_to` target that itself
has a `responds_to` — in practice, the root is the original contribution
being discussed.

**Definition of "round":** One round is one level of `responds_to`
depth from the topic root. Direct responses to the root are round 1,
responses to those are round 2, etc.

**`max_rounds`:** If any topic has a `responds_to` chain depth at or
above the limit, the condition is met for that topic.

**`max_messages`:** If any topic has a total number of `responds_to`
descendants (at all depths) at or above the limit, the condition is met
for that topic.

**Scope:** Deliberation limits are evaluated **per topic**, not
globally. A topic exceeding the limit signals that further discussion
on that topic should stop. Other topics are unaffected.

**Edge cases:**
- A contribution with no `responds_to` chain has depth 0 and
  message count 0 → condition never met
- Only one of `max_rounds` / `max_messages` specified → only that
  condition is evaluated
- Both specified → the condition is met if **either** is exceeded

---

## Stop Condition Result

The evaluator returns a structured result for each condition:

| Field | Type | Description |
|-------|------|-------------|
| `met` | boolean | Whether the condition is satisfied |
| `reason` | string | Human-readable explanation |
| `details` | object | Machine-readable details (varies by condition type) |

The overall result includes:
- `stopped`: boolean — true if ANY condition is met
- `conditions`: map of condition name → result
- `evaluatedAt`: ISO 8601 timestamp of evaluation

---

## Grove Status

The `grove status` command (future CLI, issue #13) should display:
- Overall grove state: active or stopped (with reason)
- Per-metric frontier summary
- Active claims count
- Budget usage (contributions used / max, time elapsed / max)
- Per-topic deliberation status (rounds / max, messages / max)
- Lifecycle state distribution (how many contributions in each state)

This information is computed on-demand from the store and contract —
no persistent status tracking is needed.
