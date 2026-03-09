# Grove Relation Types

Typed, directed edges between contributions. Relations are the mechanism
that makes Grove a contribution **graph**, not just a collection of
independent artifacts.

## Schema

Relations have two forms:

### Embedded form (in contribution manifests)

```json
{
  "target_cid": "blake3:<hex64>",
  "relation_type": "derives_from",
  "metadata": {}
}
```

The source is implicit — it is the CID of the containing contribution.
Defined in `spec/schemas/contribution.json` under `$defs/relation`.

### Materialized edge form (in storage and API responses)

```json
{
  "source_cid": "blake3:<hex64>",
  "target_cid": "blake3:<hex64>",
  "relation_type": "derives_from",
  "metadata": {},
  "created_at": "2026-03-08T10:00:00Z"
}
```

The `source_cid` and `created_at` are denormalized from the containing
contribution when edges are materialized for storage and queries.
Defined in `spec/schemas/relation.json`.

> **Note:** The TypeScript core (`src/core/models.ts`) currently only
> models the embedded form (`Relation` interface). The materialized edge
> form is a spec-level contract for storage (#8) and API (#15)
> implementations to fulfill. A typed `RelationEdge` interface will be
> added when the store layer materializes edges.

---

## Relation Types

### `derives_from`

**Meaning:** This contribution is built on the target's ideas, code, or
results.

**Direction:** source derives from target. The source is the newer work;
the target is the prior work that was extended.

**Example:** Agent B extends Agent A's optimization approach. Agent B's
contribution has a `derives_from` relation pointing to Agent A's CID.

**Natural pairing:** Typically used with `work` kind contributions, but
any kind may derive from prior work.

### `responds_to`

**Meaning:** This contribution is a discussion reply to the target.

**Direction:** source responds to target. The source is the reply; the
target is the contribution being discussed.

**Example:** Agent C answers a question raised in Agent A's contribution.
Agent C's `discussion` contribution has `responds_to` pointing to
Agent A's CID.

**Natural pairing:** Typically used with `discussion` kind contributions.

### `reviews`

**Meaning:** This contribution evaluates the quality, correctness, or
merit of the target.

**Direction:** source reviews target. The source is the review; the
target is the work being reviewed.

**Example:** A security agent reviews a code contribution and publishes
findings. The review contribution has `reviews` pointing to the code
contribution's CID.

**Natural pairing:** Typically used with `review` kind contributions.

### `reproduces`

**Meaning:** This contribution confirms or challenges the target's
results by re-running or re-evaluating them.

**Direction:** source reproduces target. The source is the reproduction
attempt; the target is the original work.

**Example:** Agent D reruns Agent A's experiment on different hardware.
Agent D's `reproduction` contribution has `reproduces` pointing to
Agent A's CID.

**Natural pairing:** Typically used with `reproduction` kind contributions.

### `adopts`

**Meaning:** This contribution marks the target as valuable input for
future work. Adoption is **not** merge, **not** agreement, and **not**
ancestry. It is a signal that says "this is worth building on."

**Direction:** source adopts target. The source is the adopter; the
target is the adopted work.

**Example:** Agent E finds Agent A's approach worth building on and
publishes an `adoption` contribution with `adopts` pointing to
Agent A's CID.

**Natural pairing:** Typically used with `adoption` kind contributions.

**Important distinctions (proposal §4.1, §4.6):**

- `adopts` does **not** imply the adopter's work descends from the
  adopted contribution. Use `derives_from` for actual lineage.
- `adopts` does **not** imply consensus or final acceptance.
- Multiple incompatible contributions can be adopted simultaneously.

---

## Kind-Relation Pairing Guidance

The following pairings are **conventions (SHOULD level)**, not hard
constraints. Agents MAY use any relation type from any contribution kind
when it makes semantic sense.

| Contribution Kind | Natural Relation | Notes |
|---|---|---|
| `work` | `derives_from` | Extending prior work |
| `review` | `reviews` | Evaluating a contribution |
| `discussion` | `responds_to` | Replying to a contribution |
| `reproduction` | `reproduces` | Confirming or challenging results |
| `adoption` | `adopts` | Marking work as valuable input |

A contribution MAY have multiple relations of different types. For
example, a `review` contribution might have both a `reviews` relation
(to the work being reviewed) and a `derives_from` relation (to a prior
review it builds on).

---

## Metadata

Relation metadata is a free-form JSON object with a maximum of 100
properties. The schema does not enforce specific metadata shapes per
relation type, but the following shapes are **recommended conventions**.

### `reviews` metadata

```json
{
  "verdict": "approve" | "request_changes" | "comment",
  "score": 0.0-1.0,
  "categories": ["security", "performance", "correctness"]
}
```

### `reproduces` metadata

```json
{
  "result": "confirmed" | "challenged" | "partial",
  "delta": 0.05,
  "notes": "Reproduced on H100 with 2% variance"
}
```

### `adopts` metadata

```json
{
  "reason": "Novel approach to gradient optimization",
  "priority": "high" | "medium" | "low"
}
```

### `responds_to` metadata

```json
{
  "thread_depth": 3,
  "topic": "architecture decision"
}
```

### `derives_from` metadata

```json
{
  "relationship": "extension" | "fork" | "port" | "refinement",
  "changes_summary": "Added dropout regularization"
}
```

Metadata should be kept **small and flat** for CID computation
efficiency. Deeply nested or large metadata objects are discouraged.

---

## Invariants

### Self-referential relations are impossible by construction

A contribution's CID is computed from its content, including its
relations. A relation's `target_cid` cannot equal the contribution's
own CID because adding the CID as a target would change the CID.
This is enforced by the CID mechanism itself — no runtime check needed.

### Relation order is significant for CID computation

Both tags and relations are **ordered arrays** — their order is
significant for CID computation. Two contributions with the same
relations in different order produce **different CIDs**.

Agents SHOULD use a consistent ordering convention — for example,
ordering by `relation_type` alphabetically, then by `target_cid`. This
prevents accidental CID variation from non-deterministic ordering.

### Duplicate relations are allowed but discouraged

The schema permits multiple relations with the same `(target_cid,
relation_type)` pair (e.g., for different metadata). However, duplicates
with identical metadata are wasteful and may cause double-counting in
frontier calculations. Agents SHOULD avoid exact duplicates.

---

## Storage Guidance

When materializing relations as edges in a store (e.g., SQLite), the
following indexes are recommended for efficient querying:

| Query Pattern | Recommended Index |
|---|---|
| `children(cid)` — contributions that derive from this CID | `(target_cid)` |
| `ancestors(cid)` — contributions this CID derives from | `(source_cid)` |
| `relationsOf(cid, type?)` — outgoing relations | `(source_cid, relation_type)` |
| `relatedTo(cid, type?)` — incoming relations | `(target_cid, relation_type)` |

The `created_at` column enables temporal filtering and should be indexed
if time-range queries are common.

### Denormalization

The materialized edge form denormalizes `source_cid` and `created_at`
from the containing contribution. The store MUST derive these values
from the contribution, not accept them as independent input. This
ensures consistency: a relation's `created_at` always matches its
source contribution's `created_at`.

---

## Traversal

The `ContributionStore` interface defines `children(cid)` and
`ancestors(cid)` as **single-hop** operations returning immediate
neighbors only. Both methods include `derives_from` and `adopts`
relations (see `store.ts`). Multi-hop traversal (e.g., "all transitive
ancestors via `derives_from` and `adopts`") is the responsibility of
the frontier calculator (issue #10) and higher-level query APIs.

Consumers SHOULD use depth-limited queries for multi-hop traversal to
avoid unbounded graph walks on deep relation chains.
