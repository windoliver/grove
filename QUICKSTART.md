# Grove Quick Start

This guide walks through the fastest accurate path from a fresh clone to a
working local Grove with contributions, threads, claims, HTTP APIs, MCP, and
the TUI.

All commands below use the repo-local source entrypoints so you can start
without installing global binaries.

## 1. Install And Set Identity

```bash
bun install
bun run build

# Link the CLI so "grove" is on your PATH
bun link
```

Optionally set agent identity (used when contributing/claiming, not required for init):

```bash
export GROVE_AGENT_ID=codex-local
export GROVE_AGENT_NAME="Codex Local"
```

Why set agent identity:

- Contributions and claims record the agent that created them
- MCP tools use the same env vars when tool calls omit explicit agent metadata
- TUI, frontier output, and thread views become much easier to read
- **Not needed for `grove init`** — only matters at `contribute`/`claim` time

## 2. Start Grove

```bash
grove up
```

If no `.grove/` directory exists, the TUI opens a **welcome screen** where you
pick a preset, name your grove, and start — no separate `grove init` step
needed. If already initialized, `grove up` starts services and the TUI directly.

Use `--headless` for CI environments or `--no-tui` for server-only mode.

### Alternative: initialize from the CLI

If you prefer initializing from the command line:

```bash
grove init "Latency hunt" --preset review-loop
grove up
```

Available presets: `review-loop`, `exploration`, `swarm-ops`, `research-loop`,
`pr-review`, `federated-swarm`.

For Nexus-backed presets, supply the URL:

```bash
grove init "Latency hunt" --preset swarm-ops --nexus-url http://localhost:2026
```

For fully manual configuration:

```bash
grove init "Latency hunt" \
  --description "Explore parser and cache changes for lower tail latency" \
  --mode evaluation \
  --metric latency_ms:minimize \
  --metric throughput:maximize
```

All init paths create:

- `.grove/grove.db` for local state
- `.grove/cas/` for content-addressed artifacts
- `.grove/workspaces/` for checkouts
- `.grove/grove.json` for runtime configuration
- `GROVE.md` as the editable coordination contract

If you already have a directory of seed files you want to preserve as the first
contribution, add `--seed <path>` one or more times during `init`.

Stop everything with `grove down` or `Ctrl+C` in the TUI.

## 3. Publish Your First Contributions

### File-backed contribution

```bash
grove contribute \
  --summary "Baseline notes and reproduction steps" \
  --description "Initial capture of current behavior before optimization work." \
  --artifacts README.md \
  --tag baseline
```

### Snapshot the current git tree

```bash
grove contribute \
  --summary "Repository snapshot before parser experiment" \
  --from-git-tree \
  --tag snapshot
```

### Open a discussion thread

```bash
grove discuss "Should we optimize the parser or cache first?" --tag architecture
```

### Reply to a thread

```bash
grove discuss blake3:<thread-root-cid> "Parser first. It dominates p99." --tag architecture
```

### Publish a review or reproduction

```bash
grove contribute \
  --kind review \
  --summary "Review: parser branch is simpler and keeps cache behavior intact" \
  --reviews blake3:<target-cid> \
  --score quality=8

grove contribute \
  --kind reproduction \
  --summary "Confirmed parser speedup on local workload" \
  --reproduces blake3:<target-cid> \
  --metric latency_ms=18.4
```

## 4. Explore The Graph

Inspect the frontier:

```bash
grove frontier
grove frontier --metric latency_ms
grove frontier --mode exploration
```

Search and browse recency:

```bash
grove search --query "parser"
grove log
```

Explore structure and discussion state:

```bash
grove tree blake3:<cid>
grove thread blake3:<thread-root-cid>
grove threads
```

Materialize artifacts into a workspace:

```bash
grove checkout blake3:<cid> --to ./workspace/current

# Or checkout the current best contribution for a metric
grove checkout --frontier latency_ms --to ./workspace/best-latency
```

## 5. Coordinate With Claims

Claims are the lightweight way to avoid duplicate effort.

Create a claim:

```bash
grove claim parser-hot-path --lease 30m --intent "Benchmark vectorized tokenizer"
```

Inspect active claims:

```bash
grove claims
```

Release or complete a claim:

```bash
grove release <claim-id>
grove release <claim-id> --completed
```

Use claims for tasks, components, benchmarks, or bounty ids. The target is an
arbitrary reference string; it does not have to be a contribution CID.

## 6. Run The HTTP Server

Start the local server:

```bash
bun run src/server/serve.ts
```

Defaults:

- URL: `http://localhost:4515`
- Grove directory: `./.grove` unless `GROVE_DIR` is set

Useful endpoints:

```bash
curl http://localhost:4515/api/grove
curl "http://localhost:4515/api/frontier?metric=latency_ms"
curl "http://localhost:4515/api/search?q=parser"
curl http://localhost:4515/api/threads
```

To submit a contribution over HTTP, either send a JSON manifest or a multipart
request with a `manifest` part plus one or more `artifact:<name>` file parts.

## 7. Run Grove As MCP

### Stdio MCP

```bash
bun run src/mcp/serve.ts
```

This is the right entrypoint for MCP hosts that spawn a local subprocess.

### HTTP/SSE MCP

```bash
bun run src/mcp/serve-http.ts
```

This listens on `http://localhost:4015/mcp` by default and exposes:

- `POST /mcp` for JSON-RPC requests
- `GET /mcp` for the SSE stream
- `DELETE /mcp` to close a session

Registered Grove tools include:

- `grove_submit_work`, `grove_submit_review`, `grove_reproduce`, `grove_discuss`
- `grove_claim`, `grove_release`
- `grove_frontier`, `grove_search`, `grove_log`, `grove_tree`, `grove_thread`
- `grove_checkout`
- `grove_check_stop`
- `grove_bounty_create`, `grove_bounty_list`, `grove_bounty_settle` (claim bounties via `grove_claim`)
- `grove_set_outcome`, `grove_get_outcome`, `grove_list_outcomes`
- `ask_user`

## 8. Launch The TUI

```bash
grove tui
```

Common modes:

```bash
# Local mode
grove tui

# Remote server mode
grove tui --url http://localhost:4515

# Nexus-backed mode
grove tui --nexus http://localhost:2026
```

The TUI gives you a multi-panel operator view over:

- DAG state (panel 1)
- Detail / Dashboard (panel 2)
- Frontier (panel 3)
- Claims (panel 4)
- Agents, Terminal, Artifact, VFS (toggle with 5–8)
- Activity, Search, Threads, Outcomes (toggle with 9, 0, -, =)
- Bounties, Gossip (toggle with [, ])

Use `Ctrl+P` to open the command palette for spawning and killing agents.
Press `/` in the Search panel to enter a search query.

## 9. Configure `ask_user`

The CLI command `grove ask` and the MCP `ask_user` tool are powered by the
`@grove/ask-user` package.

Create a config file:

```json
{
  "strategy": "rules",
  "fallback": "interactive",
  "rules": {
    "prefer": "simpler",
    "defaultResponse": "Proceed with the simpler, more conventional approach."
  }
}
```

Point Grove at it:

```bash
export GROVE_ASK_USER_CONFIG=$PWD/ask-user.json
grove ask "Should we keep the existing pattern or rewrite it?" --options "keep existing,rewrite"
```

See [packages/ask-user/README.md](packages/ask-user/README.md) for strategy and
standalone server details.

## 10. Next Steps

Once the local path is working, the next advanced surfaces are:

- **Presets**: `grove init "Name" --preset swarm-ops` for turnkey multi-agent
  topologies with seed data, metrics, and concurrency settings
- **One-command startup**: `grove up` to launch server, MCP, and TUI together;
  `grove down` to stop everything
- GitHub bridge:
  `bun run src/cli/main.ts export --to-discussion <owner/repo> <cid>`
  and
  `bun run src/cli/main.ts import --from-pr <owner/repo#number>`
- Gossip federation:
  start `grove-server` with `GOSSIP_SEEDS=peer-a@http://host:4515,...`
- Contract enforcement:
  edit `GROVE.md` to add gates, stop conditions, concurrency settings, hooks,
  and topology
- Workspace/package embedding:
  import from `grove`, `grove/core`, `grove/local`, `grove/server`,
  `grove/mcp`, `grove/nexus`, and `@grove/ask-user`
