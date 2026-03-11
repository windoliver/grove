# Grove — Agent Guidance

## What is this project?

Grove is a protocol and platform for asynchronous, massively collaborative
agent work. It provides a contribution graph where any agent can build on
anyone else's work — no merging, no master branch, no barriers.

## Toolchain

- **Runtime**: Bun 1.3.x (NOT Node.js)
- **Test runner**: `bun test` (bun:test, NOT Jest/Vitest)
- **Build**: tsup (ESM-only)
- **Lint/Format**: Biome (NOT ESLint/Prettier)
- **TypeScript**: Strict mode, all flags on

## Commands

```bash
bun install              # Install dependencies
bun run build            # Build with tsup
bun run typecheck        # Type check
bun run check            # Lint (Biome)
bun test                 # Run tests
bun run format           # Format code
bun run start:server     # Start HTTP server (port 4515)
```

## Architecture

```
src/
├── core/         # Protocol interfaces and domain models (no I/O)
│   ├── models.ts    # Contribution, Relation, Artifact, Claim
│   ├── store.ts     # ContributionStore, ClaimStore protocols
│   ├── cas.ts       # ContentStore protocol
│   ├── frontier.ts  # Frontier calculator
│   ├── constants.ts # Shared defaults (lease, gossip)
│   └── gossip/      # Gossip protocol types and errors
├── gossip/       # Gossip implementation (CYCLON, transport, protocol)
│   ├── cyclon.ts    # CYCLON peer sampling
│   ├── protocol.ts  # DefaultGossipService orchestrator
│   ├── http-transport.ts  # HTTP-based GossipTransport
│   └── cached-frontier.ts # TTL-cached frontier calculator
├── local/        # Local standalone adapter (SQLite + filesystem)
│   ├── sqlite-store.ts
│   └── fs-cas.ts
├── server/       # HTTP API server (Hono)
│   ├── app.ts       # createApp(deps) factory
│   ├── serve.ts     # Bun.serve() entry point
│   └── routes/      # Route handlers per domain
├── tui/          # Operator TUI dashboard (Ink/React)
│   ├── app.tsx      # Root app with tab navigation
│   ├── main.ts      # Entry point (grove tui)
│   ├── provider.ts  # TuiDataProvider interface
│   ├── local-provider.ts   # Local SQLite provider
│   ├── remote-provider.ts  # HTTP client provider
│   ├── hooks/       # React hooks (polling, navigation, keybindings)
│   ├── views/       # Tab views (dashboard, dag, claims, activity, detail)
│   └── components/  # Shared components (table, tab-bar, status-bar)
├── shared/       # Pure utilities shared across CLI, TUI, server
│   ├── format.ts    # CID truncation, timestamp, score formatting
│   └── duration.ts  # Duration parsing and formatting
└── cli/          # CLI commands
    └── main.ts
```

## TypeScript Rules

- `as const` objects instead of enums
- `import type` for type-only imports
- Explicit return types on exported functions
- `.js` extensions in all import paths
- No `any`, no `!`, no `@ts-ignore`
- Frozen/readonly interfaces for immutable data

## Key Concepts

- **Contribution**: Immutable unit of work in the DAG
- **Relation**: Typed edge (derives_from, reviews, adopts, etc.)
- **Artifact**: Content-addressed blob (BLAKE3 hash)
- **Claim**: Mutable coordination object (lease-based)
- **Frontier**: Multi-signal ranking (by metric, adoption, recency, review)
- **Adopt ≠ Merge**: Adoption marks something as valuable without merging
- **Gossip**: Server-to-server protocol for peer discovery and frontier propagation

## Gossip Protocol (Server Federation)

Grove servers can federate via a gossip protocol. This is a **server-side
feature** — agents interact with their local grove-server as usual; gossip
happens transparently between servers.

### What gossip does

- **Peer discovery**: CYCLON peer sampling maintains a partial view of the
  network. Each round, the oldest peer is selected for a shuffle exchange.
- **Frontier propagation**: Push-pull anti-entropy exchanges compact frontier
  digests (~2-5 KB) so servers converge on a shared view of the best work.
- **Failure detection**: Liveness tracking (Alive → Suspected → Failed) feeds
  into the reconciler to expire claims held by failed peers.

### Configuration

Set `GOSSIP_SEEDS` env var on the server to enable federation:

```bash
GOSSIP_SEEDS=peer-id1@http://server1:4515,peer-id2@http://server2:4515
```

Gossip parameters can also be configured in GROVE.md (V2 contracts):

```yaml
gossip:
  interval_seconds: 30
  fan_out: 3
  partial_view_size: 10
  suspicion_timeout_seconds: 90
  failure_timeout_seconds: 150
```

### API endpoints

- `POST /api/gossip/exchange` — Push-pull frontier exchange
- `POST /api/gossip/shuffle` — CYCLON peer sampling shuffle
- `GET /api/gossip/peers` — List known peers
- `GET /api/gossip/frontier` — Merged frontier from gossip
- `GET /api/grove` — Includes gossip status in metadata
