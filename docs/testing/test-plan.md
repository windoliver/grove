# Grove Test Plan

This document defines a package-by-package test plan for Grove. It is intended
to do two things:

1. preserve confidence in the protocol, storage, and agent-facing surfaces that
   already have good coverage
2. close the biggest remaining gaps, especially around the TUI and Nexus-backed
   operator workflows

The plan is grouped by package/module and by test layer.

## Test Layers

Use these layers consistently:

- schema/spec tests: contract and JSON-schema validation
- unit tests: pure logic, parsing, mapping, ranking, error handling
- component/provider tests: adapters, views, hooks, and transport wrappers
- integration tests: multiple modules wired together with realistic stores
- scenario/e2e tests: complete user flows across CLI, MCP, server, or examples
- manual operator tests: required where TUI, tmux, Ghostty, or external systems
  are involved

## Current Coverage Snapshot

Automated test files currently present:

| Area | Test files |
| --- | ---: |
| `spec` | 4 |
| `packages/ask-user` | 8 |
| `src/core` | 17 |
| `src/local` | 16 |
| `src/cli` | 26 |
| `src/server` | 2 |
| `tests/server` | 11 |
| `src/mcp` | 9 |
| `src/github` | 6 |
| `src/gossip` | 4 |
| `tests/gossip` | 3 |
| `src/tui` | 7 |
| `tests/nexus` | 6 |
| `examples` | 3 |

Interpretation:

- strongest areas: protocol/core logic, local storage/workspaces, CLI, server,
  GitHub bridge, and gossip
- medium-confidence areas: MCP and Nexus adapter internals
- weakest areas: TUI app/view behavior, remote/Nexus operator workflows, and a
  few user-facing edges such as the server diff route and MCP outcomes tools

## Priority Order

### P0: highest-value gaps

- add direct tests for TUI app/view behavior
- add remote-provider and nexus-provider tests
- add Nexus-backed operator workflow tests
- add MCP outcome tool tests
- add server diff route tests

### P1: next confidence layer

- add end-to-end flows that connect CLI, MCP, server, and TUI
- add GitHub import/export scenario coverage
- add more gossip daemon and federation workflow coverage
- add manual TUI execution checklists to release criteria

### P2: maintenance and drift control

- keep example scenarios aligned with docs
- keep MCP docs aligned with registered tool list
- add regression coverage for any new contribution kinds, topology rules, or
  server routes as they land

## Package-By-Package Plan

### `spec/*`

Purpose:

- define protocol and contract shape
- validate JSON schemas and wire formats

Keep:

- schema validation tests for contribution, relation, artifact, claim, and
  grove-contract schemas

Add:

- golden fixtures for valid and invalid contract frontmatter
- compatibility tests between `spec/*` and CLI/server parsers
- regression tests for new contract fields before implementation ships

Exit criteria:

- every contract or schema change updates both schema tests and at least one
  higher-level integration test

### `packages/ask-user`

Purpose:

- answer clarification questions through `interactive`, `rules`, `llm`, or
  `agent` strategies
- register the `ask_user` MCP tool

Keep:

- config parsing/loading tests
- strategy tests for rules, interactive, llm, and agent strategies
- registration tests and stdio e2e

Add:

- fallback-chain tests for real config combinations used in Grove
- env-driven config tests that mirror CLI and MCP usage
- failure-injection tests for agent subprocess timeout, stderr noise, and
  malformed config files

Manual:

- run `grove ask` with and without `GROVE_ASK_USER_CONFIG`
- run `grove-ask-user` and confirm an MCP host can discover `ask_user`

### `src/core`

Purpose:

- immutable models, manifest/CID logic, contract parsing, frontier ranking,
  lifecycle/stop conditions, threads, backoff, errors, topology, hooks, and
  workspace/path-safety protocols

Keep:

- model immutability
- manifest determinism and CID verification
- frontier ranking and scale behavior
- lifecycle stop-condition evaluation
- contract parsing/validation
- thread traversal and hot-thread logic
- path-safety and subprocess behavior

Add:

- topology validation edge cases: duplicate roles, bad edges, invalid tree
  parents, spawn depth/child limits
- lifecycle + frontier combined regression tests for mixed evaluation and
  exploration contributions
- property-style tests for relation traversal invariants

Exit criteria:

- every protocol invariant is enforced in either unit or integration form

### `src/local`

Purpose:

- production local adapter layer: SQLite stores, filesystem CAS, workspace
  manager, reconciler, hook runner, local bounty/outcome/gossip stores

Keep:

- SQLite store CRUD, FTS, migrations, and concurrency
- CAS reads/writes and concurrency
- workspace lifecycle and conformance
- reconciler behavior
- hook runner behavior
- local outcome and bounty store tests

Add:

- hook + workspace integration tests for checkout/contribute cleanup flow
- failure-injection around partial CAS writes and interrupted workspace cleanup
- reconciliation tests involving stale claims plus multiple agent workspaces

Manual:

- create a local grove, contribute files, checkout them, and clean workspaces

### `src/cli`

Purpose:

- human/operator command surface

Commands covered by the test plan:

- `init`
- `contribute`
- `discuss`
- `claim`, `release`, `claims`
- `checkout`
- `frontier`, `search`, `log`, `tree`
- `thread`, `threads`
- `ask`
- `bounty`
- `outcome`
- `import`, `export`
- `gossip`
- `tui` entry behavior

Keep:

- parsing and behavior tests for each command family
- CLI integration tests for end-to-end invocation
- formatting tests for list, table, and DAG output

Add:

- command crossovers: `contribute` -> `frontier` -> `checkout`
- agent identity propagation across CLI commands
- regression tests for grove-directory discovery and `--grove` overrides
- GitHub CLI error-path tests when `gh` is missing or unauthenticated
- `tui` argument parsing tests for all provider modes

Manual:

- run the full operator flow from the CLI only: init, claim, contribute, log,
  thread, outcome, bounty

### `src/server` plus `tests/server`

Purpose:

- HTTP API and remote control-plane surface

Keep:

- route tests for contributions, claims, frontier, search, DAG, threads,
  outcomes, grove metadata, and integration wiring
- middleware error handling tests
- full-server e2e in `src/server/e2e.test.ts`

Add:

- dedicated tests for `/api/diff/:parentCid/:childCid/:artifactName`
- artifact metadata and artifact download negative-path tests
- tests for optional behavior when outcome store or gossip is not configured
- topology route tests for missing vs configured topology
- multipart upload edge cases: empty artifacts, duplicate names, invalid CID

Manual:

- start `grove-server`, then exercise it from `grove tui --url ...` and from
  raw HTTP clients

### `src/mcp`

Purpose:

- agent-facing tool surface and transport bindings

Keep:

- agent identity tests
- server integration test asserting the full registered tool surface
- tool-family tests for contributions, claims, queries, workspace, stop, and
  bounties

Add:

- direct tests for `src/mcp/tools/outcomes.ts`
- transport tests for HTTP/SSE session lifecycle in `grove-mcp-http`
- negative-path tests for missing stores or missing workspace manager
- regression tests for token-saving trimmed responses in query tools
- tests ensuring `ask_user` remains registered in the combined server

Manual:

- connect Claude Code or Codex to `grove-mcp`
- connect an HTTP MCP client to `grove-mcp-http`

### `src/nexus` plus `tests/nexus`

Purpose:

- Nexus-backed CAS/store adapters and supporting client/cache/semaphore logic

Keep:

- unit and integration coverage for Nexus CAS and store behavior
- resilience and edge-case tests
- mock-client coverage

Add:

- end-to-end user workflows using Nexus-backed claims, contributions, outcomes,
  and TUI browsing
- concurrency/conflict tests across multiple logical agents
- VFS browsing tests tied to real TUI provider expectations
- explicit tests for zone scoping, revision conflict recovery, and retry
  backoff behavior under mixed read/write workloads

Critical gap:

- no full operator workflow currently ties Nexus to the TUI, MCP, and
  claim/workspace/session lifecycle together

Manual:

- run `grove tui --nexus ...`
- browse VFS
- inspect contributions, claims, frontier, and outcomes
- once Nexus execution lifecycle is complete, validate spawn/kill and cleanup

### `src/github`

Purpose:

- import/export bridge between Grove and GitHub Discussions/PRs

Keep:

- refs parsing
- mapper tests
- error mapping tests
- adapter unit/integration tests
- client conformance tests

Add:

- CLI-level import/export scenario tests with realistic contribution content
- artifact-heavy PR export fixtures
- discussion import/export round trips preserving thread context
- failure tests for missing `gh`, auth failure, and rate limiting

Manual:

- import a real PR into a scratch grove
- export a contribution to a test repo as both Discussion and PR

### `src/gossip` plus `tests/gossip`

Purpose:

- server federation via CYCLON peer sampling, frontier exchange, and liveness

Keep:

- CYCLON behavior
- HTTP transport coverage
- protocol behavior
- convergence, routes, and failure propagation tests

Add:

- daemon-mode integration tests with more than two peers
- restart/rejoin tests
- tests for stale peer expiry and liveness transitions across timeouts
- throughput/load reporting assertions if queue depth becomes meaningful

Manual:

- run two or more `grove-server` instances with `GOSSIP_SEEDS`
- confirm peer discovery and merged frontier convergence

### `src/tui`

Purpose:

- operator command center for DAG, detail, frontier, claims, agents, terminal,
  artifact preview, and Nexus VFS

Current automated coverage:

- panel-focus and navigation hooks
- graph layout and edge rendering
- tmux manager
- spawn validator
- local provider

Largest gaps:

- `src/tui/app.tsx` root behavior
- `src/tui/main.ts` provider-mode wiring
- all major views and most shared components
- `remote-provider.ts`
- `nexus-provider.ts`
- end-user spawn/kill/operator loops

Add next:

- view tests for dashboard, DAG, detail, frontier, claims, activity, artifact,
  terminal, agent list/graph, and VFS browser
- component tests for table, status bar, panel bar, command palette, and input
  handling
- provider tests for remote and Nexus providers
- app-level tests for:
  - panel toggling and focus
  - detail drill-in and back navigation
  - terminal input mode
  - command palette spawn/kill flow
  - topology-aware graph mode
  - artifact diff toggle
- Ghostty fallback tests for terminal rendering

Manual TUI checklist:

1. Local mode
   - launch `grove tui`
   - confirm DAG, Detail, Frontier, and Claims render with seed data
   - open Agent and Terminal panels with tmux available
   - spawn a session from the command palette
   - confirm claim/session visibility and terminal capture
   - kill the session and confirm cleanup
2. Remote mode
   - launch `grove-server`
   - connect with `grove tui --url http://localhost:4515`
   - confirm dashboard, detail, frontier, claims, artifacts, and outcomes work
3. Nexus mode
   - launch `grove tui --nexus <url>`
   - confirm VFS browsing works
   - confirm contribution/detail/frontier/outcome views use Nexus-backed data
   - document current spawn limitations until the Nexus lifecycle is complete
4. Topology mode
   - add topology to `GROVE.md`
   - confirm Agent panel renders graph view and command palette respects role
     capacity
5. Artifact mode
   - preview text artifacts
   - preview binary artifacts
   - diff parent vs child artifact content

Release gate:

- no release should claim TUI support without completing the manual TUI
  checklist on the supported provider modes

### `examples/*`

Purpose:

- scenario-level documentation and regression fixtures

Keep:

- autoresearch
- code exploration
- multi-agent collaboration

Add:

- GitHub import/export scenario
- bounty-driven scenario
- server-backed operator scenario
- Nexus-first operator scenario
- TUI-oriented walkthrough fixture or scripted smoke check

## Cross-Surface Scenarios to Add

These are the highest-value integration additions because they reflect how
people actually use Grove:

1. Local operator loop
   - `grove init`
   - `grove claim`
   - `grove contribute`
   - `grove outcome set`
   - inspect from `grove tui`
2. MCP multi-agent loop
   - two MCP clients connect
   - agent A contributes work
   - agent B claims and reviews
   - agent A derives from review
   - stop conditions evaluated
3. Server + TUI loop
   - `grove-server`
   - remote TUI connects
   - claims, contributions, artifacts, outcomes stay consistent
4. Nexus-backed collaboration loop
   - Nexus-backed contribution + claim + outcome flow
   - TUI reads the same shared state
   - manual or automated operator verification
5. GitHub bridge loop
   - import PR -> review/adopt/discuss in Grove -> export back out
6. Federated server loop
   - contributions created on one server
   - frontier converges across peers through gossip

## Release Checklist

Before a significant release:

- run `bun test`
- run `bun test --cwd packages/ask-user`
- run `bun run build`
- run `bun run typecheck`
- run `bun run check`
- run the example scenarios
- run the manual TUI checklist
- if GitHub or Nexus code changed, run their integration suites
- if server or MCP code changed, run at least one real transport smoke test

## Definition of Done for New Features

Every new user-visible feature should ship with:

- one unit test for the local logic
- one integration test at the public boundary that users actually touch
- a doc update in the user guide if it changes operator behavior
- a manual TUI checklist update if it affects the TUI

This is the standard needed to keep Grove coherent as a product rather than a
collection of partially connected subsystems.
