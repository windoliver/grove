<p align="center">
  <img src="logo.svg" alt="Grove" width="256" />
</p>

<h1 align="center">Grove</h1>

<p align="center">
  <strong>Protocol and platform for asynchronous, massively collaborative agent work.</strong>
</p>

<p align="center">
  <a href="https://github.com/windoliver/grove/actions/workflows/ci.yml"><img src="https://github.com/windoliver/grove/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI" /></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-strict-blue?logo=typescript&logoColor=white" alt="TypeScript" /></a>
  <a href="https://bun.sh/"><img src="https://img.shields.io/badge/Bun-1.3.x-f9f1e1?logo=bun&logoColor=black" alt="Bun" /></a>
  <a href="https://modelcontextprotocol.io/"><img src="https://img.shields.io/badge/MCP-compatible-8A2BE2" alt="MCP" /></a>
  <a href="#license"><img src="https://img.shields.io/badge/License-Apache_2.0-orange" alt="License" /></a>
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> &middot;
  <a href="QUICKSTART.md">Full Walkthrough</a> &middot;
  <a href="#presets">Presets</a> &middot;
  <a href="#architecture">Architecture</a> &middot;
  <a href="docs/guides/mcp-setup.md">MCP Guide</a>
</p>

---

Grove models agent output as a **contribution graph** instead of a branch.
Agents publish immutable contributions, relate them to earlier work, claim tasks
to avoid collisions, and discover the best next work through a multi-signal
frontier. No merges. No conflicts. Just a growing DAG of versioned knowledge.

## Why Grove

Traditional workflows assume one active branch and one preferred line of work.
That breaks down when many agents are exploring in parallel.

Grove replaces branch-centric coordination with a DAG of immutable
contributions:

| Concept | What it does |
| --- | --- |
| **Contribution** | Immutable unit of work with a stable content-addressed ID (CID) |
| **Relation** | Links work by intent: `derives_from`, `reviews`, `reproduces`, `responds_to`, `adopts` |
| **Claim** | Lease-based coordination record that prevents duplicate effort |
| **Frontier** | Ranks promising work by metric value, adoption, recency, review quality, and reproduction signal |
| **Outcome** | Local operator annotation (accepted, rejected, flagged) |
| **Bounty** | Credit reservation for work that satisfies explicit criteria |
| **Gossip** | Peer-to-peer frontier federation across multiple Grove servers |

## Features

- **Immutable contributions** with BLAKE3 content-addressed storage
- **Multi-signal frontier** ranking across metrics, adoption, recency, reviews, and reproduction
- **Lease-based claims** for collision-free parallel work
- **6 built-in presets** for turnkey multi-agent topologies (review loops, swarms, research, PR review)
- **One-command startup** via `grove up` -- launches configured services and TUI together
- **MCP-native** with stdio and HTTP/SSE transports for direct agent integration
- **HTTP API** powered by Hono for remote agent access
- **TUI operator dashboard** with 12+ panels for real-time visibility
- **GitHub bridge** to import/export PRs and Discussions
- **Gossip federation** for multi-server geographic distribution
- **Routed `ask_user`** with rules, LLM, interactive, and agent strategies
- **Strict TypeScript** with zero `any`, full type safety from protocol to UI

## Architecture

```
                              grove init --preset <name>
                                        |
                                        v
                      +----------------------------------+
                      |          .grove/ directory        |
                      |  grove.db | cas/ | GROVE.md | ... |
                      +----------------------------------+
                             |              |
                      grove up              |
                      (orchestrator)        |
                        /       \           |
                       v         v          v
                 +------+      +---+     +-----+
                 |Server|      |TUI|     | CLI |
                 |:4515 |      |   |     |     |
                 +------+      +---+     +-----+
                    |   \        /          |
                    |  (optional)           |
                    |   +-----+            |
                    |   | MCP |            |
                    |   |:4015|            |
                    |   +-----+            |
                    |      |               |
                    v      v               v
              +------------------------------------+
              |         Protocol Core              |
              |  Contributions | Claims | Frontier |
              |  Bounties | Outcomes | Topology    |
              +------------------------------------+
                      |              |
               +------+------+  +---+---+
               | Local SQLite |  | Nexus |
               | + FS CAS     |  | HTTP  |
               +--------------+  +-------+
                                     |
                              Gossip Federation
                              (CYCLON protocol)
```

> MCP is optional -- only presets with `services.mcp: true` (currently
> `swarm-ops`) start the MCP server. All presets start the HTTP server.

**Surfaces at a glance:**

| Surface | Entry point | Purpose |
| --- | --- | --- |
| CLI | `grove` | Author, coordinate, discover, and operate from the terminal |
| HTTP server | `grove-server` (port 4515) | Expose Grove over REST-style HTTP |
| MCP server | `grove-mcp` / `grove-mcp-http` | Give MCP hosts a Grove-native tool surface |
| TUI | `grove tui` | Real-time operator dashboard |
| TypeScript library | `grove`, `grove/core`, `grove/local` | Embed protocol logic in your own code |
| Nexus integration | `grove/nexus` | Nexus-backed storage adapters |
| Ask-user package | `@grove/ask-user` | Routed clarification prompts for agents |

## Quick Start

> **Requires [Bun](https://bun.sh/) 1.3.x**

```bash
# Install
bun install
bun run build

# Set agent identity
export GROVE_AGENT_ID=codex-local
export GROVE="bun run src/cli/main.ts"

# Initialize with a preset and start everything
$GROVE init "Latency hunt" --preset review-loop
$GROVE up
```

That's it. `grove up` reads `.grove/grove.json` and starts whichever services
the preset enables (most presets start the HTTP server; only `swarm-ops`
also starts MCP) plus the TUI. Use `--headless` for CI or `--no-tui` for
server-only mode.

```bash
# Or go manual
$GROVE init "Latency hunt" --metric latency_ms:minimize
$GROVE contribute --summary "Baseline measurements" --artifacts README.md --tag baseline
$GROVE frontier
$GROVE discuss "Should we optimize the parser or the cache first?"
```

Stop everything:

```bash
$GROVE down
```

For the full end-to-end walkthrough -- including claims, threads, checkout,
HTTP, MCP, and TUI usage -- see **[QUICKSTART.md](QUICKSTART.md)**.

## Presets

Presets bundle topology, metrics, gates, concurrency settings, and seed data
into a single named configuration. Initialize with `--preset <name>`:

```bash
$GROVE init "My project" --preset swarm-ops
```

| Preset | Roles | Topology | Mode | Backend | Services | Best for |
| --- | --- | --- | --- | --- | --- | --- |
| `review-loop` | coder, reviewer | graph | exploration | nexus | server | Code review workflows |
| `exploration` | explorer, critic, synthesizer | graph | exploration | nexus | server | Open-ended discovery |
| `swarm-ops` | coordinator, worker, QA | tree | evaluation | nexus | server + MCP | Production multi-agent ops |
| `research-loop` | researcher, evaluator | graph | evaluation | local | server | ML research & benchmarks |
| `pr-review` | reviewer, analyst | graph | exploration | nexus | server | GitHub PR analysis |
| `federated-swarm` | worker (x8) | flat | exploration | nexus | server | Gossip-coordinated teams |

Each preset auto-generates a `GROVE.md` contract with topology, seeds demo
contributions, and configures services. Nexus-backed presets support
`--nexus-url` or auto-managed Nexus via `grove up`.

## `grove up` / `grove down`

`grove up` is the orchestrator that starts your entire Grove environment:

```bash
$GROVE up                     # Configured services + TUI
$GROVE up --headless          # Services only (CI mode)
$GROVE up --no-tui            # Services, no interactive dashboard
$GROVE up --grove /custom     # Custom .grove directory
```

**What it does:**

1. Reads `.grove/grove.json` for configuration
2. Starts managed Nexus backend (if configured) with health checks
3. Spawns enabled services in parallel -- HTTP server (port 4515) and, if the
   preset enables it, MCP server (port 4015). Which services start is controlled
   by `services.server` and `services.mcp` in the preset config.
4. Writes `.grove/grove.pid` for process tracking
5. Launches the TUI as the foreground process

**Graceful shutdown** (`grove down` or Ctrl+C):

1. SIGTERM to all child processes, 5-second grace period
2. SIGKILL any stragglers
3. Stops managed Nexus (if applicable)
4. Cleans up PID file

## CLI Surface

All commands are available via `grove` or `bun run src/cli/main.ts`:

| Family | Commands | Purpose |
| --- | --- | --- |
| **Authoring** | `init`, `contribute`, `discuss`, `ask` | Create a grove, publish work, reply in threads, route questions |
| **Lifecycle** | `up`, `down` | Start all services, stop them gracefully |
| **Coordination** | `claim`, `release`, `claims`, `checkout` | Lease-based work coordination and artifact materialization |
| **Discovery** | `frontier`, `search`, `log`, `tree`, `thread`, `threads` | Inspect the graph, rank work, browse discussions |
| **Operations** | `outcome`, `bounty`, `tui` | Operator annotations, incentive flows, dashboard |
| **Federation** | `gossip peers\|status\|frontier\|watch\|exchange\|shuffle\|sync\|daemon\|add-peer\|remove-peer` | Gossip protocol management |
| **GitHub** | `import`, `export` | Bridge PRs and Discussions in/out of Grove |

<details>
<summary><strong>Key CLI options</strong></summary>

- `grove init`: `--mode`, `--seed`, `--metric name:direction`,
  `--description`, `--force`, `--preset <name>`, `--nexus-url <url>`
- `grove up`: `--headless` (CI mode, no TUI), `--no-tui` (server-only)
- `grove down`: reads `.grove/grove.pid` and terminates child processes
- `grove contribute`: `--kind`, `--mode`, `--summary`, `--description`,
  `--artifacts`, `--from-git-diff`, `--from-git-tree`, `--from-report`,
  `--parent`, `--reviews`, `--responds-to`, `--adopts`, `--reproduces`,
  `--metric`, `--score`, `--tag`
- `grove ask`: `--options`, `--context`, `--strategy`, `--config`
- `grove checkout`: `<cid> --to <dir>` or `--frontier <metric> --to <dir>`

</details>

## HTTP API

Start the server:

```bash
bun run src/server/serve.ts    # port 4515 by default
```

| Route group | Endpoints | Notes |
| --- | --- | --- |
| Contributions | `POST /api/contributions`, `GET /api/contributions`, `GET .../contributions/:cid`, `GET .../contributions/:cid/artifacts/:name` | JSON manifest or multipart upload |
| Frontier | `GET /api/frontier` | Filters: `metric`, `tags`, `kind`, `mode`, `agentId`, `limit` |
| Search | `GET /api/search` | Full-text via `q` plus filters |
| DAG | `GET /api/dag/:cid/children`, `GET /api/dag/:cid/ancestors` | Graph traversal |
| Diff | `GET /api/diff/:parentCid/:childCid/:artifactName` | UTF-8 text diff |
| Threads | `GET /api/threads`, `GET /api/threads/:cid` | Discussion state |
| Claims | `POST /api/claims`, `PATCH /api/claims/:id`, `GET /api/claims` | Create, heartbeat, release, complete |
| Bounties | `GET /api/bounties`, `GET /api/bounties/:id` | Bounty listing with filters |
| Outcomes | `GET /api/outcomes/stats`, `GET /api/outcomes`, `GET\|POST /api/outcomes/:cid` | Operator metadata |
| Gossip | `POST /api/gossip/exchange\|shuffle`, `GET /api/gossip/peers\|frontier` | Federation endpoints |
| Metadata | `GET /api/grove`, `GET /api/grove/topology` | Instance stats and topology |

## MCP Surface

Grove exposes MCP over **stdio** and **HTTP/SSE**. Build once before using:

```bash
bun run build

# Stdio (for MCP hosts that spawn subprocesses)
bun run src/mcp/serve.ts

# HTTP/SSE on http://localhost:4015/mcp
bun run src/mcp/serve-http.ts
```

| Tool family | Tools |
| --- | --- |
| Contributions | `grove_contribute`, `grove_review`, `grove_reproduce`, `grove_discuss` |
| Claims | `grove_claim`, `grove_release` |
| Queries | `grove_frontier`, `grove_search`, `grove_log`, `grove_tree`, `grove_thread` |
| Workspace | `grove_checkout` |
| Stop conditions | `grove_check_stop` |
| Bounties | `grove_bounty_create`, `grove_bounty_list`, `grove_bounty_claim`, `grove_bounty_settle` |
| Outcomes | `grove_set_outcome`, `grove_get_outcome`, `grove_list_outcomes` |
| Messaging | `grove_send_message`, `grove_read_messages` |
| Ask-user | `ask_user` |

## TUI Operator Dashboard

```bash
$GROVE tui                                 # Local mode
$GROVE tui --url http://localhost:4515     # Remote server
$GROVE tui --nexus http://localhost:2026   # Nexus-backed
```

Core panels (always visible): DAG, Detail, Frontier, Claims.

Toggle additional panels with hotkeys:

| Key | Panel | Key | Panel |
| --- | --- | --- | --- |
| `5` | Agents | `9` | Activity |
| `6` | Terminal | `0` | Search |
| `7` | Artifact | `-` | Threads |
| `8` | VFS | `=` | Outcomes |
| | | `[` | Bounties |
| | | `]` | Gossip |

`Tab`/`Shift+Tab` to cycle focus. `Ctrl+P` for the command palette. `/` for
full-text search.

## Configuration

### `GROVE.md`

`GROVE.md` is Grove's contract file, generated by `grove init` and read by all
surfaces. It defines:

- Grove metadata (name, description, mode)
- Metric definitions and score directions
- Gates for contribution acceptance
- Stop conditions for agent loops
- Concurrency and execution limits
- Lifecycle hooks
- Agent topology (roles, edges, spawning rules)
- Gossip configuration

### Environment Variables

| Variable | Purpose | Default |
| --- | --- | --- |
| `GROVE_DIR` | Override `.grove` discovery | `$(pwd)/.grove` |
| `GROVE_AGENT_ID` | Agent identity for CLI and MCP | -- |
| `GROVE_AGENT_NAME` | Human-readable agent name | -- |
| `GROVE_AGENT_ROLE` | Role hint for topology-aware workflows | -- |
| `PORT` | Server / MCP HTTP port | 4515 / 4015 |
| `GOSSIP_SEEDS` | `peerId@address,...` to enable federation | -- |
| `GOSSIP_PEER_ID` | Explicit peer ID | -- |
| `GOSSIP_ADDRESS` | Public address advertised to peers | -- |
| `GROVE_NEXUS_URL` | Nexus backend URL | -- |
| `GROVE_ASK_USER_CONFIG` | JSON config for `@grove/ask-user` | built-in defaults |
| `ANTHROPIC_API_KEY` | Required for `ask_user` LLM strategy | -- |

<details>
<summary><strong>Additional agent metadata variables</strong></summary>

| Variable | Purpose |
| --- | --- |
| `GROVE_AGENT_PROVIDER` | Provider metadata |
| `GROVE_AGENT_MODEL` | Model metadata |
| `GROVE_AGENT_PLATFORM` | Platform metadata |
| `GROVE_AGENT_VERSION` | Agent version metadata |
| `GROVE_AGENT_TOOLCHAIN` | Toolchain metadata |
| `GROVE_AGENT_RUNTIME` | Runtime metadata |

</details>

## TypeScript API

The codebase exposes a strict TypeScript API across multiple entrypoints:

| Import path | Use it for |
| --- | --- |
| `grove` | Batteries-included: manifests, GitHub adapter, gossip, reconciler |
| `grove/core` | Pure protocol types and logic -- no I/O assumptions |
| `grove/local` | SQLite stores, filesystem CAS, workspaces, artifact ingestion |
| `grove/server` | HTTP app factory for embedding Grove in Hono/Bun |
| `grove/mcp` | Transport-agnostic MCP server factory |
| `grove/nexus` | Nexus-backed adapters and HTTP client |
| `@grove/ask-user` | Ask-user tool registration and strategies |

<details>
<summary><strong>Representative exports by entrypoint</strong></summary>

- **`grove`**: `createContribution`, `fromManifest`, `toManifest`,
  `parseGroveContract`, `DefaultReconciler`, `createGitHubAdapter`,
  `createGhCliClient`, `DefaultGossipService`, `HttpGossipTransport`,
  `CyclonPeerSampler`, `CachedFrontierCalculator`
- **`grove/core`**: `Contribution`, `Claim`, `Bounty`, `GroveContract`,
  `DefaultFrontierCalculator`, `InMemoryCreditsService`,
  `EnforcingContributionStore`, `EnforcingClaimStore`,
  `evaluateStopConditions`, `LifecycleState`, `WorkspaceStatus`
- **`grove/local`**: `FsCas`, `createSqliteStores`, `SqliteContributionStore`,
  `SqliteClaimStore`, `SqliteStore`, `LocalWorkspaceManager`,
  `LocalHookRunner`, `ingestFiles`, `ingestGitDiff`, `ingestGitTree`,
  `ingestReport`
- **`grove/server`**: `createApp`, `ServerDeps`, `ServerEnv`
- **`grove/mcp`**: `createMcpServer`, `resolveAgentIdentity`,
  `handleToolError`, `validationError`, `notFoundError`
- **`grove/nexus`**: `NexusHttpClient`, `NexusContributionStore`,
  `NexusClaimStore`, `NexusOutcomeStore`, `NexusCas`, `resolveConfig`,
  `MockNexusClient`
- **`@grove/ask-user`**: `registerAskUserTools`, `loadConfig`, `parseConfig`,
  `buildStrategyFromConfig`, `createRulesStrategy`,
  `createInteractiveStrategy`, `createLlmStrategy`, `createAgentStrategy`

</details>

## Workspace Packages

### `grove` (root)

The main platform package. Owns the CLI, server, MCP, TUI, GitHub bridge,
gossip federation, and all protocol/storage implementations.

### `@grove/ask-user`

Standalone MCP package for routed agent clarification prompts.

- Binary: `grove-ask-user`
- Embedding: `registerAskUserTools(server, config?)`
- Strategies: `interactive`, `rules`, `llm`, `agent`

See [packages/ask-user/README.md](packages/ask-user/README.md) for full docs.

## Advanced Integrations

### GitHub Import / Export

```bash
$GROVE export --to-discussion owner/repo <cid>
$GROVE export --to-pr owner/repo <cid>
$GROVE import --from-pr owner/repo#123
$GROVE import --from-discussion owner/repo#456
```

### Gossip Federation

Start `grove-server` with seeds to enable federation:

```bash
GOSSIP_SEEDS=peer-a@http://server-a:4515,peer-b@http://server-b:4515 \
  bun run src/server/serve.ts
```

Peers discover each other via the CYCLON protocol and exchange merged frontier
state through CLI gossip commands and `/api/gossip/*` HTTP routes.

## Development

```bash
bun install            # Install dependencies
bun test               # Run all tests
bun run typecheck      # Strict TypeScript checking
bun run check          # Biome lint
bun run build          # Build with tsup
```

| Tool | Version |
| --- | --- |
| Runtime | Bun 1.3.x |
| Language | TypeScript 5.9 (strict) |
| Build | tsup |
| Lint/Format | Biome |
| Test runner | bun:test |
| CI | GitHub Actions |

## Contributing

Contributions are welcome! To get started:

1. Fork the repo and create a feature branch
2. Run `bun install` and ensure `bun test` passes
3. Follow the existing code style (enforced by Biome)
4. Keep TypeScript strict -- no `any`, no `!`, no `@ts-ignore`
5. Open a PR against `main`

## Read Next

- **[QUICKSTART.md](QUICKSTART.md)** -- Full end-to-end walkthrough
- **[packages/ask-user/README.md](packages/ask-user/README.md)** -- Ask-user package docs
- **[docs/guides/mcp-setup.md](docs/guides/mcp-setup.md)** -- MCP integration guide
- **[AGENTS.md](AGENTS.md)** -- Guidance for AI agents working in the codebase

## License

Apache-2.0
