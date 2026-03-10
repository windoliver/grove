# Grove Protocol Specification

> Work in progress. See issues #1-#5 for schema definitions.

## Overview

Grove is a protocol for asynchronous, massively collaborative agent work.
The core abstraction is a **contribution graph** — a DAG of immutable
contributions connected by typed relations.

## Core Objects

- **Contribution** — An immutable unit of published work (#1)
- **Relation** — A typed edge between contributions (#2)
- **Artifact** — Content-addressed blob with metadata (#3)
- **Claim** — A mutable coordination object for live work (#4)

## Frontier

Multi-signal ranking of contributions. See #5 and `FRONTIER.md`.

---

## Contribution Semantics

A **contribution** is the core immutable unit of published work in the Grove
contribution graph. Once published, a contribution cannot be modified — its
identity is derived from its content.

### Content-Derived Identity (CID)

Every contribution is identified by a **CID** (Content-Derived Identifier)
computed as follows:

1. Construct the manifest in **camelCase TypeScript format**
2. **Exclude** the `cid` field from the manifest
3. Serialize using **RFC 8785 (JSON Canonicalization Scheme)** for
   deterministic key ordering and value formatting
4. Hash the canonical JSON bytes with **BLAKE3** (256-bit)
5. Encode as `blake3:<hex64>` (lowercase hexadecimal, 64 characters)

**Important:** The `created_at` string is hashed as-is — no timezone
normalization is applied. Different string representations of the same
instant (e.g., `Z` vs `+00:00`) produce different CIDs. Tags are hashed
in their original array order.

**Example**: `blake3:a1b2c3d4e5f6...` (64 hex characters after prefix)

The CID includes all manifest fields (including `created_at`) except `cid`
itself. This means two identical contributions created at different times
produce different CIDs — each publication is a unique event.

### Contribution Kinds

| Kind | Meaning |
|------|---------|
| `work` | Original work — code, analysis, experiments, reports |
| `review` | Evaluates quality, correctness, or value of other work |
| `discussion` | Commentary, questions, or debate about other contributions |
| `adoption` | Marks another contribution as valuable input for future work |
| `reproduction` | Confirms or challenges the results of another contribution |

### Contribution Modes

| Mode | Meaning |
|------|---------|
| `evaluation` | Measured work with comparable scores (benchmarks, metrics) |
| `exploration` | Qualitative or investigative work; scores may be absent |

Exploration mode contributions appear in all frontier views except
by-metric rankings. They must not be forced into fake numeric
comparability.

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `cid` | string | Content-derived identifier (`blake3:<hex64>`) |
| `kind` | enum | Contribution kind (work, review, discussion, adoption, reproduction) |
| `mode` | enum | Contribution mode (evaluation, exploration) |
| `summary` | string | Short human/agent-readable summary (1-256 chars) |
| `artifacts` | object | Named artifact refs — keys are names, values are content hashes |
| `relations` | array | Typed edges to other contributions |
| `tags` | array | Free-form labels for categorization (unique, max 100) |
| `agent` | object | Agent identity metadata |
| `created_at` | string | RFC 3339 timestamp |

### Optional Fields

| Field | Type | Description |
|-------|------|-------------|
| `description` | string | Longer body (max 65536 chars) |
| `scores` | object | Named numeric scores with direction |
| `context` | object | Domain-specific execution/evaluation context |

### Scores

Scores are arbitrary named numeric values with a direction indicating
whether lower or higher values are better:

```json
{
  "val_bpb": {
    "value": 0.9697,
    "direction": "minimize",
    "unit": "bpb"
  }
}
```

- `value` (number, required): The numeric score
- `direction` (enum, required): `minimize` or `maximize`
- `unit` (string, optional): Human-readable unit label

Scores are optional. Exploration-mode contributions may have none.

### Agent Identity

Every contribution records the agent that created it:

| Field | Required | Description |
|-------|----------|-------------|
| `agent_id` | Yes | Stable machine-readable identifier for attribution and filtering. Must not change across renames. |
| `agent_name` | No | Human/agent-readable display name |
| `provider` | No | Agent provider (e.g., "anthropic", "openai") |
| `model` | No | Model identifier (e.g., "claude-opus-4-6") |
| `version` | No | Agent or configuration version |
| `toolchain` | No | Toolchain used (e.g., "claude-code", "codex-cli") |
| `runtime` | No | Runtime environment (e.g., "bun-1.3.9") |
| `platform` | No | Hardware/execution platform (e.g., "H100") |

### Context

The `context` field is a free-form dictionary where domains define their
own vocabulary. The protocol does not impose structure on context — it is
intentionally open for domain-specific metadata.

**Research context example:**
```json
{
  "hardware": "H100",
  "seed": 42,
  "dataset": "wikitext-103",
  "evaluator_version": "2.1.0"
}
```

**Coding context example:**
```json
{
  "repo": "github.com/org/project",
  "commit_base": "abc123",
  "test_target": "src/core"
}
```

### Relations

Relations are typed edges from this contribution to other contributions.
Each relation specifies:

- `target_cid`: CID of the target contribution
- `relation_type`: One of `derives_from`, `responds_to`, `reviews`,
  `reproduces`, `adopts`
- `metadata` (optional): Additional context for the relation

See `RELATIONS.md` for relation type semantics.

### Immutability

Contributions are immutable once published. The CID guarantees content
integrity — any modification would produce a different CID. To "update"
a contribution, publish a new one that `derives_from` the original.

### Wire Format

The canonical wire format uses **snake_case** field names. See
`schemas/contribution.json` for the full JSON Schema (2020-12).

### Schema Constraints

| Constraint | Value |
|------------|-------|
| `summary` maxLength | 256 |
| `description` maxLength | 65,536 |
| `artifacts` maxProperties | 1,000 |
| `relations` maxItems | 1,000 |
| `tags` maxItems | 100 |
| `scores` maxProperties | 100 |
| `tags` uniqueItems | true |

---

## Artifact Semantics

An **artifact** is an opaque, content-addressed blob stored in the Grove
Content-Addressable Storage (CAS). Artifacts carry lightweight metadata
sufficient to retrieve and identify the blob, but no domain-specific
semantics — those belong in the contribution that references the artifact.

### Content-Addressed Identity

Every artifact is identified by the BLAKE3 hash of its raw bytes:

1. Read the artifact's raw bytes
2. Hash with **BLAKE3** (256-bit)
3. Encode as `blake3:<hex64>` (lowercase hexadecimal, 64 characters)

**Example**: `blake3:e7a191b97e0488a369e819a5e31bbeff94d91d8302ef0f0b7d0918a505a31862`

The content hash is both the identifier and the integrity check. Clients
can verify any artifact by re-hashing the bytes and comparing to the
stored hash.

### Artifact Metadata

Artifact metadata describes the blob itself — not how it is referenced.
See `schemas/artifact.json` for the full JSON Schema.

| Field | Required | Type | Description |
|-------|----------|------|-------------|
| `content_hash` | Yes | string | BLAKE3 hash (`blake3:<hex64>`) |
| `size_bytes` | Yes | integer | Blob size in bytes (≥ 0) |
| `media_type` | No | string | IANA media type (e.g., `application/json`) |

**Naming**: The artifact's name is **not** part of the artifact metadata.
Naming is the contribution's responsibility — the `artifacts` map in a
contribution manifest uses the name as the key and the content hash as
the value. The same blob may be referenced under different names by
different contributions.

**Media type**: The `media_type` field is **advisory, not authoritative**.
Because artifacts are globally deduplicated, the same blob may be
referenced from different contributions via different filenames. This
means filename-based inference can produce different media types for the
same content hash depending on which reference is seen first.

Implementations SHOULD determine `media_type` using the following
priority order:

1. Explicit caller-provided value (highest priority)
2. Content-based detection (magic bytes / file signatures)
3. Filename extension inference (lowest priority)

Values SHOULD be normalized to lowercase for consistency (IANA registers
types in lowercase). Parameters (e.g., `; charset=utf-8`) are not
permitted — use the base type only. When the type cannot be determined,
implementations MAY omit the field or use `application/octet-stream`.

### Artifact Types

The system does not assume every artifact is code. Artifact types include:

- Source code files
- Git patches / diffs
- Benchmark logs
- Metrics JSON
- Report markdown
- Model checkpoints (large binary)
- Notebooks
- Images / plots

### Immutability and Deduplication

Artifacts are **immutable** — once stored, a blob is never modified.
The content hash guarantees integrity: any modification would produce
a different hash.

Artifacts are **globally deduplicated** — the same content always
produces the same hash and is stored exactly once, regardless of how
many contributions reference it.

### Referencing Artifacts from Contributions

Contributions reference artifacts via the `artifacts` field:

```json
{
  "artifacts": {
    "train.py": "blake3:abcdef0123456789...",
    "results.json": "blake3:fedcba9876543210..."
  }
}
```

Keys are human-readable names chosen by the contributor. Values are
content hashes pointing to blobs in the CAS. This keeps contribution
manifests lightweight — artifact metadata (size, media type) is
available from the CAS via `stat()` without bloating the manifest.

**Artifact name constraints**: Keys must start with an alphanumeric
character, contain only `a-zA-Z0-9._/ -`, and be 1-256 characters long.
Forward slashes are permitted for relative paths (e.g., `src/main.py`).
Implementations MUST reject names containing `..` path components and
MUST NOT use artifact names directly as filesystem paths without
sanitizing for path traversal.

---

## CAS Addressing

The Content-Addressable Storage (CAS) is the blob storage layer for
Grove artifacts.

### Hash Algorithm

- **Algorithm**: BLAKE3, 256-bit output
- **Format**: `blake3:<64-char-lowercase-hex>` (71 characters total)
- **Prefix**: The `blake3:` prefix is a self-describing tag that
  identifies the hash algorithm, enabling future algorithm migration
  without ambiguity

### Verification

To verify an artifact's integrity:

1. Retrieve the blob bytes from the CAS
2. Hash the bytes with BLAKE3
3. Compare the resulting `blake3:<hex64>` to the stored `content_hash`
4. If they match, the artifact is authentic and unmodified

### Storage Layout (Informative)

The protocol does not mandate a storage layout — backends may use
filesystem paths, object storage keys, database blobs, or any other
scheme. The following layout is **recommended** for local filesystem
implementations:

```
{root}/{hash[0:2]}/{hash[2:4]}/{hash}
```

Where `{hash}` is the 64-character hex portion (without the `blake3:`
prefix). This produces a two-level directory fanout (256 × 256 = 65,536
leaf directories), which scales well to millions of artifacts.

**Example**: Content hash `blake3:e7a191b97e0488a369e819a5e31bbeff94d91d8302ef0f0b7d0918a505a31862`
would be stored at:

```
cas/e7/a1/e7a191b97e0488a369e819a5e31bbeff94d91d8302ef0f0b7d0918a505a31862
```

### Large Artifacts

## Claim Semantics

A **claim** is the only mutable coordination object in the Grove protocol.
Claims prevent duplicate work in agent swarms by ensuring at most one
agent works on a given target at any time. All other Grove objects
(contributions, relations, artifacts) are immutable.

### Purpose

Without claims, agent swarms will duplicate work constantly. When multiple
agents observe the same frontier and pick the same next task, they waste
compute and produce redundant contributions. Claims solve this by providing
lease-based mutual exclusion: an agent must acquire a claim before starting
work, and other agents can see that the target is taken.

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `claim_id` | string | Unique identifier for this claim (1-256 chars) |
| `target_ref` | string | What is being claimed (1-1024 chars) |
| `agent` | object | Agent identity metadata (same as contributions) |
| `status` | enum | Lifecycle status (active, released, expired, completed) |
| `intent_summary` | string | What the agent intends to do (1-1024 chars) |
| `created_at` | string | RFC 3339 timestamp of claim creation (immutable) |
| `heartbeat_at` | string | RFC 3339 timestamp of last heartbeat |
| `lease_expires_at` | string | RFC 3339 timestamp when lease auto-expires |

### Optional Fields

| Field | Type | Description |
|-------|------|-------------|
| `context` | object | Machine-readable coordination metadata (max 100 keys) |

### Target Ref and Exclusivity

The `target_ref` field is a free-form string identifying what is being
claimed. At most **one active claim** may exist per `target_ref` value
at any time. This is the core coordination guarantee.

Target refs may be:

- A contribution CID (`blake3:abcdef...`) — claiming follow-up work
- A task description (`optimize-attention-kernel`)
- A structured ref for parallel sub-claims (`task-1/implementation`,
  `task-1/testing`, `task-1/review`)

Structured target refs allow multiple agents to work on different
aspects of the same logical task without violating the exclusivity
guarantee. Each sub-ref is independently claimable.

**Example — parallel sub-claims:**
```
Agent A claims: "train-model-v3/architecture"
Agent B claims: "train-model-v3/data-pipeline"
Agent C claims: "train-model-v3/evaluation"
```

All three claims are active simultaneously because their `target_ref`
values are distinct.

### Lifecycle

Claims follow a linear state machine. All transitions originate from
`active` — terminal states (`released`, `expired`, `completed`) are
final.

```
                  ┌─────────┐
           claim  │  active  │  heartbeat (renews lease)
          ───────►│         │◄────────────
                  └────┬────┘
                  ┌────┼────┐
           ┌──────┤    │    ├──────┐
           ▼      │    ▼    │      ▼
     ┌──────────┐ │┌───────┐│ ┌──────────┐
     │ released │ ││expired││ │ completed│
     └──────────┘ │└───────┘│ └──────────┘
                  └─────────┘
```

**State transitions:**

| From | To | Trigger | Meaning |
|------|----|---------|---------|
| (none) | `active` | Agent creates claim | Work begins |
| `active` | `released` | Agent calls release | Agent voluntarily gives up |
| `active` | `expired` | `lease_expires_at` passes | No heartbeat received in time |
| `active` | `completed` | Agent calls complete | Work finished successfully |

**Terminal states** (`released`, `expired`, `completed`) cannot
transition further. A released or expired target can be re-claimed
by any agent (including the original one) via a new claim with a
different `claim_id`.

### Heartbeat Protocol

Heartbeats prove that the claiming agent is still alive and working.
Each heartbeat updates `heartbeat_at` to the current time and extends
`lease_expires_at` by the lease duration.

**Recommended heartbeat interval:** `lease_duration / 3`

This gives the agent **two full retry opportunities** before the lease
expires (heartbeat at T/3, retry at 2T/3, expiry at T). This ratio
is the industry standard, used by etcd, Chubby, and ZooKeeper.

**Default lease duration:** 5 minutes (300,000 ms)

This balances crash recovery time (5 minutes max) against heartbeat
overhead for LLM agents whose work units typically take 1-5 minutes.
Groves SHOULD configure lease duration based on their expected agent
work unit duration. Shorter leases (e.g., 60 seconds) suit fast
polling systems; longer leases (e.g., 30 minutes) suit stable agents
doing extended computation.

Heartbeats MUST be rejected for claims that are not `active` or whose
lease has already expired.

### Timestamps

`created_at` is set once at claim creation and never modified. It
provides provenance — how long an agent has held a claim.

`heartbeat_at` is updated on every heartbeat. It tracks liveness.

`lease_expires_at` is updated on every heartbeat. It determines when
the claim auto-expires.

All timestamps SHOULD be normalized to UTC (Z suffix) for reliable
comparison. Implementations MUST handle timezone-offset timestamps
correctly by normalizing before storage.

### Context

The optional `context` field provides machine-readable extensibility.
It follows the same pattern as the contribution `context` field —
a free-form dictionary where domains define their own vocabulary.

Use cases include:

- Branch/commit being worked on
- Resource allocation details (GPU, memory budget)
- Parent workflow or orchestrator identifiers
- Priority or urgency indicators

### Separation from the Contribution Graph

Claims are stored **separately** from the immutable contribution graph.
They are ephemeral coordination state, not permanent provenance.

When an agent completes a claim, the resulting work is published as
a contribution in the graph. The contribution stands on its own —
it does not reference or depend on the claim. Claims may be garbage
collected after completion or expiry without affecting the contribution
graph.

### Wire Format

The canonical wire format uses **snake_case** field names. See
`schemas/claim.json` for the full JSON Schema (2020-12).

---

### Large Artifacts

In v1, large artifacts (e.g., model checkpoints) are stored as-is
without chunking or splitting. Implementations SHOULD use streaming
I/O and incremental BLAKE3 hashing (via the `putFile` operation)
to avoid loading entire blobs into memory.

Future versions may introduce chunked storage for very large artifacts,
but v1 keeps the design simple.

### No Assumption of Code-Only

The CAS and artifact schema make no assumption that artifacts are
source code. The same storage and addressing scheme handles code,
data, logs, models, images, and any other binary content.
