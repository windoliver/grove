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
│   └── frontier.ts  # Frontier calculator
├── local/        # Local standalone adapter (SQLite + filesystem)
│   ├── sqlite-store.ts
│   └── fs-cas.ts
├── server/       # HTTP API server (Hono)
│   ├── app.ts       # createApp(deps) factory
│   ├── serve.ts     # Bun.serve() entry point
│   └── routes/      # Route handlers per domain
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
