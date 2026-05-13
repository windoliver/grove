# Production Credits Service - Design

- **Issue**: [#253](https://github.com/windoliver/grove/issues/253)
- **Date**: 2026-05-12
- **Status**: Approved by user

## Goal

Add a durable `CreditsService` backend that survives process restart, is safe
across the HTTP server and MCP processes, restores escrowed bounty settlement
recovery, and records at least one automatic reward signal.

## Non-goals

- Implementing TigerBeetle or changing the Nexus `pay` brick in this change.
- Changing the public `CreditsService` interface.
- Adding external payment APIs to Grove.
- Replacing the existing `InMemoryCreditsService` in tests that need failure
  injection.

## Context

Grove already has the domain contract in `src/core/credits.ts`, in-memory test
behavior in `src/core/in-memory-credits.ts`, and shared conformance tests in
`src/core/credits.conformance.ts`. Bounty settlement already uses a saga pivot
state, but the runtime sweepers construct `SettlementSweep` without a credits
service, so escrowed `pending_settlement` bounties cannot be repaired.

The Nexus `pay` brick exists locally under `~/nexus/src/nexus/bricks/pay/`.
Its Python service has the right conceptual primitives, but the exposed REST
surface is admin-oriented and does not directly satisfy Grove's per-agent
`reserve`, `capture`, `void`, `transfer`, and `balance` interface. This design
therefore implements the durable backend inside Grove first and keeps the same
interface boundary for a later NexusPay adapter.

## Approach

Create `SqliteCreditsService` in `src/local/sqlite-credits-service.ts`. It uses
the same `bun:sqlite` database handle and WAL/busy-timeout configuration as the
local contribution, claim, bounty, and session stores. All mutating operations
run in immediate SQLite transactions so concurrent MCP agents and the HTTP
server observe one durable ledger.

`createLocalRuntime()` constructs one `SqliteCreditsService` and exposes it on
`LocalRuntime`. The server, stdio MCP runtime, and HTTP MCP runtime pass that
service into operation dependencies and into every `SettlementSweep`
registration. The in-memory service remains available for unit tests that need
synthetic failures.

## Ledger Schema

Add a local credits DDL block with these tables:

```text
credit_accounts(
  agent_id TEXT PRIMARY KEY,
  balance INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)

credit_reservations(
  reservation_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL,
  captured_to_agent_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)

credit_transfers(
  transfer_id TEXT PRIMARY KEY,
  from_agent_id TEXT NOT NULL,
  to_agent_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  transfer_type TEXT NOT NULL,
  created_at TEXT NOT NULL
)
```

`credit_accounts.balance` is total posted balance. Pending, unexpired
reservations are computed from `credit_reservations` and subtracted from total
to produce available balance. Captures deduct from the reserving account and
credit `captured_to_agent_id` when provided. Voids mark the reservation voided
without changing account balance.

## Service Semantics

The SQLite service must preserve the existing conformance contract:

- `reserve` is idempotent by `reservationId` and rejects mismatched agent or
  amount on retry.
- `capture` is idempotent after a successful capture and rejects mismatched
  `toAgentId` on retry.
- `void` is idempotent for missing, already-voided, or already-captured
  reservations.
- `transfer` is idempotent by `transferId` and rejects mismatched retry
  parameters.
- expired reservations do not reduce available balance and cannot be captured.

Validation remains strict: amounts must be positive integers, and insufficient
available balance raises the existing `InsufficientCreditsError`.

## Bootstrap Funding

Wiring a real credits service means escrowed bounty creation requires funds.
To keep evaluation mode usable without inventing an external payment flow, the
SQLite backend supports deterministic bootstrap grants:

- `GROVE_CREDITS_INITIAL_BALANCE` seeds a newly-seen agent account once. The
  default local value is `10000`.
- `GROVE_CREDITS_REWARD_TREASURY_BALANCE` seeds the system reward treasury
  account once. The default local value is `1000000`.
- Both grants are recorded through the ledger path, not hidden in memory.
- Setting either value to `0` disables that bootstrap.

These defaults preserve the current evaluation workflow by allowing agents to
create escrowed bounties immediately after runtime startup. A future NexusPay
adapter can use real wallet provisioning instead of these SQLite-only grants.

## Runtime Wiring

`src/local/runtime.ts` returns `creditsService` and closes it with the rest of
the runtime. `src/server/deps.ts` gets an optional `creditsService` field so
HTTP operation adapters can share the same dependency shape as MCP. The runtime
entry points wire the service as follows:

- `src/server/serve.ts`: pass `creditsService` into `ServerDeps` and
  `new SettlementSweep(serverBountyStore, creditsService)`.
- `src/mcp/serve.ts`: pass `creditsService` into `McpDeps`.
- `src/mcp/serve-http.ts`: pass `creditsService` into session-scoped `McpDeps`
  and zone-level `SettlementSweep`.

Nexus store mode continues to use Nexus contribution, claim, bounty, outcome,
and CAS stores. Credits remain SQLite-backed for this change unless a later
NexusPay adapter is configured behind the same `CreditsService` interface.

## Settlement Recovery

Escrowed bounty recovery uses the existing saga order:

```text
claimed -> pending_settlement -> capture -> completed -> settled
```

The sweep resumes `pending_settlement` by reusing the persisted
`reservationId`. Since `capture` is idempotent, a restart after payment capture
but before final state transition is safe. The sweep also keeps the current
completed-to-settled repair path for bounties that advanced past capture before
the process stopped.

## Frontier Reward

Implement frontier-advance as the first automatic reward signal. A focused
reward service compares metric-ranked frontier entries before and after a
non-ephemeral evaluation contribution is stored. When a contribution improves a
metric frontier, the service computes a deterministic reward ID from reward
type, metric, contribution CID, and recipient agent ID.

The reward transfer uses:

```text
fromAgentId = "system:frontier-rewards"
toAgentId = contribution.agent.agentId
transferId = "reward:" + rewardId
```

After a successful transfer, the service records a `RewardRecord` through
`BountyStore.recordReward`. Before transferring it checks `hasReward(rewardId)`
so retries and process restarts cannot duplicate payment. The first payout
formula is intentionally simple: one credit per absolute metric improvement
unit after applying the metric direction, rounded up to one credit for any
positive improvement.

## Testing

Add focused Bun tests:

- `src/local/sqlite-credits-service.test.ts` runs the existing credits
  conformance suite against SQLite.
- Persistence tests close and reopen the same database, then verify accounts,
  reservations, captures, and transfers survive.
- A cross-process-style test opens two service instances on the same database
  and verifies concurrent reservations cannot overdraw the account.
- Settlement recovery test creates an escrowed bounty, moves it to
  `pending_settlement`, closes/reopens the runtime, runs `SettlementSweep`, and
  verifies the bounty is settled and balances persist.
- Runtime wiring tests verify server, stdio MCP, and HTTP MCP deps include the
  service and sweeps receive it.
- Frontier reward tests verify one metric improvement transfers credits,
  records a reward, and does not pay again on retry.

## Risks

SQLite is a durable local ledger, not the final TigerBeetle production backend.
This is acceptable for #253 because the contract boundary remains
`CreditsService`, the implementation is cross-process safe within a Grove
workspace, and NexusPay can replace it later without changing bounty
operations.

The reward formula is intentionally conservative. It proves the reward path,
idempotency, and accounting without adding a complex economic policy in the
same change.
