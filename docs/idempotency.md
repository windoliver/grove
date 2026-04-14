# Idempotency

Grove contributions support explicit idempotency keys for retry-safe submissions. The semantics follow [RFC 8284](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/) and Stripe's `Idempotency-Key` convention.

## How to use

### MCP tools

Pass the optional `idempotencyKey` parameter to any contribution tool:

```json
{
  "summary": "Fix the parser bug",
  "artifacts": { "fix.ts": "blake3:..." },
  "agent": { "agentId": "coder-1", "role": "coder" },
  "idempotencyKey": "my-unique-key"
}
```

Available on: `grove_submit_work`, `grove_submit_review`, `grove_discuss`, `grove_reproduce`, `grove_adopt`.

### HTTP API

Pass the `Idempotency-Key` header on `POST /api/contributions`:

```http
POST /api/contributions
Content-Type: application/json
Idempotency-Key: my-unique-key

{ "kind": "work", "summary": "...", ... }
```

### CLI

Pass `--idempotency-key` to `grove contribute`:

```bash
grove contribute --summary "Fix parser" --idempotency-key my-unique-key
```

## Semantics

| Scenario | Behavior |
|----------|----------|
| Same key + same input | Returns cached result (retry) |
| Same key + different input | Returns `STATE_CONFLICT` error (HTTP 409) |
| Same key + in-flight request | Awaits the pending write (single-flight) |
| No key provided | No deduplication — each call creates a new contribution |

## Key details

- **Scope**: Keys are namespaced per agent (`agent.role` if set, otherwise `agent.agentId`). Two different agents can use the same key without colliding.
- **TTL**: Cached results expire after **5 minutes**. After expiry, the key can be reused.
- **Cache size**: Up to 1024 entries (LRU eviction when full).
- **Process-local**: The cache is in-memory and not shared across processes. Clients running multiple grove instances must coordinate keys externally.
- **Fingerprint coverage**: The conflict check hashes `kind`, `mode`, `summary`, `description`, `artifacts` (name + hash), `relations`, `scores`, `tags`, `context`, and agent scope. Any difference in these fields triggers `STATE_CONFLICT` on key reuse.

## Key format

Keys are opaque strings. UUIDv4 or UUIDv7 are recommended. The key itself is not stored in the contribution — it only controls deduplication during the cache TTL window.

## When to use

- **Agent retry loops**: Generate a key before the first attempt, reuse it on retries.
- **Network retries**: If a submission times out, replay with the same key to avoid duplicates.
- **Iterative work**: When an agent intentionally resubmits with updated artifacts under the same summary, use a **new key** (or no key) so the submission is not suppressed.

Idempotency keys are optional. Callers that don't need retry safety can omit the key entirely.
