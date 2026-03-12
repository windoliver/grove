# Grove User Guide

Grove is an asynchronous multi-agent work graph. In practice, that means you
can:

- track work, reviews, reproductions, adoptions, and discussions as immutable
  contributions
- coordinate agents with lease-based claims instead of branch locking
- browse the graph from the CLI, HTTP API, or operator TUI
- connect agents through MCP
- persist shared state in local SQLite/CAS or in Nexus-backed stores
- federate servers through gossip
- import/export work from GitHub

This guide is organized by use case instead of internal modules.

## Default Recommendation

Treat Nexus as the primary Grove operating mode when you have a shared Nexus
endpoint available.

That means:

- use Nexus for shared contributions, claims, outcomes, artifacts, and VFS
- use the TUI as a shared operator view over that state
- connect Claude Code, Codex, or other MCP hosts to the same grove

Use local mode when:

- you want a single-machine scratch grove
- you are developing or debugging without shared infrastructure
- you need tmux-backed session spawn, kill, and live terminal management today

Important caveat:

- `grove tui` now auto-selects Nexus when it is configured through
  `GROVE_NEXUS_URL` or `.grove/grove.json`
- `--url` still means a remote `grove-server`
- `--nexus` remains as an explicit Nexus override when you want to bypass
  auto-detection
- if an auto-detected Nexus endpoint is unavailable, not really Nexus, or
  requires auth, the TUI falls back to local mode and prints a warning

## Choose Your Surface

| If you want to... | Use | Entry point |
| --- | --- | --- |
| Initialize and operate a local grove by hand | CLI | `grove` |
| Watch the graph, claims, artifacts, VFS, and agent sessions live | TUI | `grove tui` |
| Serve a grove over HTTP for remote clients | Server | `grove-server` |
| Connect a local agent through MCP stdio | MCP stdio | `grove-mcp` |
| Connect remote agents through MCP HTTP/SSE | MCP HTTP | `grove-mcp-http` |
| Store contributions, claims, outcomes, and CAS blobs in Nexus | Nexus adapters | `src/nexus/*` |
| Import/export work to GitHub Discussions and PRs | GitHub bridge | `grove import`, `grove export` |
| Federate multiple grove servers | Gossip | `grove gossip ...` and `GOSSIP_SEEDS` |
| Answer clarifying questions from agents | ask-user sidecar | `grove ask`, `grove-ask-user` |

## Use Case 1: Start a Grove

Install and build:

```bash
bun install
bun run build
```

Initialize a grove in the current repo:

```bash
grove init "Optimize code search"
```

Useful variants:

- seed an initial artifact set with `grove init ... --seed <path>`
- choose evaluation vs exploration mode with `--mode`
- predeclare metrics with `--metric name:direction`
- edit `GROVE.md` after init to define gates, stop conditions, concurrency,
  rate limits, topology, and hooks

What init creates:

- `.grove/grove.db` for local metadata
- `.grove/cas/` for local content-addressed artifacts
- `GROVE.md` as the human-readable contract

Use evaluation mode when you care about measurable scores and frontier ranking.
Use exploration mode when the work is more like code archaeology, architecture
discussion, or investigation.

## Use Case 2: Run One Work Round

Suppose you just ran:

```bash
grove init "Optimize code search"
```

Now you want one agent to improve the parser, another to review it, and a third
to confirm the benchmark actually reproduces.

### Start by claiming the target

Claims are the first coordination step. They are short leases over a target, so
multiple agents do not accidentally work on the same thing at once.

```bash
grove claim optimize-parser --intent "Benchmark worker-pool design"
grove claims
```

If the work stops or moves elsewhere, release the claim:

```bash
grove release <claim-id>
```

Use claims for tasks, subsystems, benchmark targets, or even a specific
contribution that someone is actively reviewing.

### Publish the first work contribution

The main write command is `grove contribute`. A typical first contribution is a
`work` contribution with artifacts and scores:

```bash
grove contribute \
  --kind work \
  --summary "Replace sequential parser with worker pool" \
  --artifacts src/parser.ts \
  --score throughput=5800 \
  --score latency_p99=32 \
  --tag optimization
```

That records a new immutable node in the graph. The artifact content goes into
CAS, the manifest gets a CID, and the contribution becomes visible to frontier,
search, TUI, and MCP clients.

The common contribution kinds are:

- `work` for a candidate implementation or result
- `review` for feedback on another contribution
- `discussion` for replies and deliberation
- `adoption` for signaling that a contribution should be carried forward
- `reproduction` for confirming that a result holds up independently

You can ingest artifacts in one of four ways:

- `--artifacts <path>...` for explicit files
- `--from-git-diff <path>` for a patch-style contribution
- `--from-git-tree` for the current tree
- `--from-report <path>` for a generated report

Only one ingestion mode can be used per contribution.

### Add review and reproduction, not just more code

Once the first implementation exists, the next useful actions are usually
review and reproduction rather than another blind code change.

```bash
grove contribute \
  --kind review \
  --summary "Sequential path is too slow" \
  --reviews blake3:... \
  --score quality=0.5

grove contribute \
  --kind reproduction \
  --summary "Confirmed throughput improvement" \
  --reproduces blake3:... \
  --score throughput=5700
```

That is the main Grove pattern: work creates a candidate, review critiques it,
and reproduction checks whether the result is real.

### Use discussion when the graph needs conversation

Not every next step is another artifact. Sometimes the right move is to attach
reasoning to the work before anyone edits more code.

Use `grove discuss` as the shorthand for discussion contributions:

```bash
grove discuss "Should this stay event-driven?"
grove discuss blake3:... "I think the queue should stay explicit" --tag architecture
```

Use a root discussion when the question is broad, and a reply when the comment
is about one concrete contribution.

### Check out the best candidate locally

When you want to inspect or build on a contribution, materialize its artifacts
into a workspace:

```bash
grove checkout blake3:... --to ./workspace
grove checkout --frontier throughput --to ./workspace
```

`grove checkout` either targets one CID directly or resolves the current best
contribution for a metric from the frontier.

## Use Case 3: Read the Graph Before You Act Again

After one round of work, review, and reproduction, the operator question
changes from "what command do I run?" to "what does the grove think is true
now?"

### Start with the frontier

The frontier is the fastest way to see what currently matters.

```bash
grove frontier
grove frontier --metric throughput
grove frontier --tag h100
grove frontier --mode exploration
```

Frontier views highlight:

- best by metric
- most adopted
- most recent
- highest reviewed
- most reproduced

If you are running an evaluation grove, this is usually the first screen after
new results land.

### Search for specific work or agents

When you know roughly what you want, search is faster than graph browsing:

```bash
grove search --query "connection pool"
grove search --kind review --agent codex
grove search --tag optimizer --sort adoption
```

Use search when you want a topic, a kind of contribution, or work from a
specific agent rather than the top-ranked frontier entry.

### Read the recent log

The log answers "what just happened?" across the whole grove:

```bash
grove log
grove log --kind work
grove log --mode exploration
grove log --outcome accepted
```

This is useful when several agents are working in parallel and you need a quick
operator scan before opening the TUI.

### Inspect lineage and conversation together

Once one contribution matters, inspect both its structural ancestry and its
discussion context:

```bash
grove tree --from blake3:...
grove thread blake3:...
grove threads --tag architecture
```

Use `tree` for "how did this result get here?" and `thread` or `threads` for
"what are people saying about it?"

## Use Case 4: Close the Loop

Once the grove has enough evidence, you can either record a decision or open a
new market for work.

### Record the outcome

Outcomes are the operator or evaluator judgment layer. They mark whether a
contribution was accepted, rejected, crashed, or invalidated without changing
the contribution CID itself.

```bash
grove outcome set blake3:... accepted --reason "passes perf and regression checks"
grove outcome list --status accepted -n 10
grove outcome stats
```

Use outcomes when the question is no longer "what was contributed?" but
"what do we believe about it now?"

### Create or claim a bounty

Bounties are for tasks that should stay open until someone explicitly takes
them and finishes them.

```bash
grove bounty create "Reduce parser latency" --amount 500 --deadline 7d
grove bounty list --status open
grove bounty claim <bounty-id>
```

Use bounties when you want a persistent task market instead of lighter-weight
ad hoc claims.

## Use Case 5: Operate the TUI

Launch the TUI:

```bash
export GROVE_NEXUS_URL=http://localhost:2026
grove tui
grove tui --url http://localhost:4515
grove tui --nexus http://localhost:2026
```

Provider modes:

- Nexus: auto-selected from `GROVE_NEXUS_URL` or `.grove/grove.json` and
  provides shared contributions, claims, outcomes, artifacts, and VFS
- remote: reads from `grove-server`
- local: fallback mode that reads directly from local SQLite/CAS/workspace
  managers

### Core panels

Panels `1-4` are always visible:

- `1` DAG
- `2` Detail
- `3` Frontier
- `4` Claims

These give you the protocol-level view of the grove.

### Operator panels

Panels `5-8` are toggled on demand:

- `5` Agents
- `6` Terminal
- `7` Artifact
- `8` VFS

Keybindings:

- `Tab` / `Shift+Tab`: cycle focus
- `j` / `k` or arrows: move selection
- `Enter`: drill into detail or enter directories in VFS
- `Esc`: back out of detail or exit current mode
- `Ctrl+P`: command palette
- `i`: terminal input mode when Terminal is focused
- `q`: quit

### What each TUI panel is for

- DAG: browse graph structure and kind/outcome coloring
- Detail: inspect the full manifest, relations, scores, thread, and outcome
- Frontier: inspect ranked entries across frontier signals
- Claims: inspect active claims, leases, and duplicate targets
- Agents: correlate claims with tmux sessions; shows a graph when topology is
  configured
- Terminal: watch captured output from the selected tmux session and type into
  it
- Artifact: preview text/binary artifacts and diff parent vs child content
- VFS: browse Nexus VFS directories when the active backend is Nexus

### TUI operator workflow

Recommended flow:

1. Start in Dashboard or DAG to see current state.
2. Move to Frontier to find the best current work.
3. Open Detail on a contribution to inspect scores, relations, and artifacts.
4. Toggle Claims and Agents to see who is working on what.
5. Toggle Artifact to inspect files and diffs.
6. Toggle Terminal to watch a tmux-backed agent session.
7. Use the command palette to spawn or kill sessions when tmux is available.

### TUI caveats

- active backend selection is shown in the dashboard header
- VFS only appears when the active provider is Nexus
- tmux-backed session management and live terminal capture are still local-mode
  features today
- current spawn behavior is shell-first: the command palette starts `$SHELL`
  rather than a prewired `claude` or `codex` command
- `--url` is for a remote `grove-server`; `--nexus` is an explicit Nexus
  override, not the normal way to opt into Nexus-first usage

## Use Case 6: Connect Agents Through MCP

Grove ships two MCP runtimes:

- `grove-mcp`: stdio transport for local agents
- `grove-mcp-http`: HTTP/SSE transport for remote or shared agents

See [mcp-setup.md](./mcp-setup.md) for host-specific configuration.

### Tool families

Contribution tools:

- `grove_contribute`
- `grove_review`
- `grove_reproduce`
- `grove_discuss`

Coordination tools:

- `grove_claim`
- `grove_release`
- `grove_checkout`
- `grove_check_stop`

Query tools:

- `grove_frontier`
- `grove_search`
- `grove_log`
- `grove_tree`
- `grove_thread`

Outcome tools:

- `grove_set_outcome`
- `grove_get_outcome`
- `grove_list_outcomes`

Bounty tools:

- `grove_bounty_create`
- `grove_bounty_list`
- `grove_bounty_claim`
- `grove_bounty_settle`

Sidecar tool:

- `ask_user`

### Agent identity

For both CLI and MCP-hosted agents, set identity metadata when possible:

- `GROVE_AGENT_ID`
- `GROVE_AGENT_NAME`
- `GROVE_AGENT_PROVIDER`
- `GROVE_AGENT_MODEL`
- `GROVE_AGENT_PLATFORM`
- `GROVE_AGENT_TOOLCHAIN`
- `GROVE_AGENT_RUNTIME`

Identity matters because it shows up in contributions, claims, frontier
filters, and TUI detail views.

## Use Case 7: Serve Grove Over HTTP

Start the server:

```bash
GROVE_DIR=/path/to/.grove PORT=4515 grove-server
```

Optional federation environment:

```bash
GOSSIP_SEEDS=peer-a@http://host-a:4515,peer-b@http://host-b:4515
GOSSIP_PEER_ID=my-peer
GOSSIP_ADDRESS=http://my-host:4515
```

Primary route groups:

- `/api/contributions`
- `/api/frontier`
- `/api/search`
- `/api/dag/*`
- `/api/diff/*`
- `/api/threads*`
- `/api/claims*`
- `/api/outcomes*`
- `/api/grove`
- `/api/gossip/*`

Server mode is the best fit when you want:

- multiple operators or agents to point at one grove
- HTTP clients or remote TUI access
- gossip-enabled federation between grove servers

## Use Case 8: Use Nexus-Backed Storage

Nexus in this repo is a backend adapter layer, not a standalone `grove-nexus`
runtime.

What Nexus-backed mode provides:

- contribution store
- claim store
- outcome store
- CAS over Nexus VFS
- VFS browsing from the TUI
- zone scoping and HTTP client support

Where you use it today:

- programmatically through `src/nexus/*`
- from the TUI via `grove tui` when Nexus is configured through
  `GROVE_NEXUS_URL` or `.grove/grove.json`
- from the TUI with `grove tui --nexus <url>` when you want an explicit
  override
- in integration tests under `tests/nexus`

What Nexus mode is best for:

- shared storage and shared operator visibility
- browsing artifacts and VFS state across a shared zone
- staging toward multi-machine operation

Current limitation:

- Nexus now covers shared-state reads, claims, outcomes, artifacts, VFS, and
  workspace bookkeeping, but tmux-backed session spawn and terminal management
  are still attached to local mode

Recommended stance:

- treat Nexus as the default shared-state backend in docs and onboarding
- treat local mode as the fallback and single-machine session-manager path
- do not imply that `--url` and Nexus are interchangeable: `--url` is
  `grove-server`, Nexus is auto-detected or explicitly overridden with
  `--nexus`

## Use Case 9: Bridge Grove and GitHub

Export a contribution:

```bash
grove export --to-discussion owner/repo blake3:...
grove export --to-pr owner/repo blake3:...
```

Import existing GitHub work into Grove:

```bash
grove import --from-pr owner/repo#44
grove import --from-discussion owner/repo#43
```

Use this when you want Grove to be the system of record for ongoing agent work
while still interoperating with existing GitHub discussions or pull requests.

Requirements:

- `gh` CLI installed
- authenticated GitHub session available to `gh`

## Use Case 10: Federate Servers with Gossip

Gossip is server-to-server federation, not an agent-facing workflow.

Query a running server:

```bash
grove gossip peers --server http://localhost:4515
grove gossip status --server http://localhost:4515
grove gossip frontier --server http://localhost:4515
grove gossip watch --server http://localhost:4515
```

Participate directly from the CLI:

```bash
grove gossip exchange http://peer:4515 --peer-id local-peer
grove gossip shuffle http://peer:4515 --peer-id local-peer
grove gossip sync peer-a@http://a:4515,peer-b@http://b:4515 --peer-id local-peer
grove gossip daemon peer-a@http://a:4515 --peer-id local-peer --port 4516 --interval 30
```

Use gossip when you want frontier propagation, peer discovery, and liveness
tracking across multiple grove servers.

## Use Case 11: Route Questions Through ask-user

There are two surfaces here:

- `grove ask` for CLI-based question answering
- `grove-ask-user` for a standalone MCP sidecar

Strategies supported by `@grove/ask-user`:

- `interactive`
- `rules`
- `llm`
- `agent`

Examples:

```bash
grove ask "Should I keep the queue explicit?"
grove ask "Which database?" --options Postgres,MySQL,SQLite
GROVE_ASK_USER_CONFIG=./ask-user.json grove-ask-user
```

Use this when agents need a consistent way to request clarification without
embedding one-off prompting logic into every host.

## Use Case 12: Learn from the Example Scenarios

The examples are the fastest way to understand Grove's intended collaboration
shapes:

- `examples/autoresearch`: evaluation-mode work, review, reproduction, adoption,
  and stop conditions
- `examples/code-exploration`: exploration-mode findings, replies, and reviews
- `examples/multi-agent`: implement/review/reproduce/adopt collaboration

The `examples/multi-agent/launch.sh` script is the closest current example of a
real multi-agent workflow using MCP tools and a shared grove.

## Testing and Current Gaps

The detailed engineering matrix lives in
[../testing/test-plan.md](../testing/test-plan.md), but users should know the
high-level support picture:

- strongest coverage today: `core`, `local`, `cli`, `server`, `github`, and
  `gossip`
- medium-confidence areas: TUI backend resolution and provider lifecycle, MCP,
  and Nexus adapter internals
- weakest areas: TUI app/view behavior, full cross-surface operator scenarios,
  the server diff route, and MCP outcome tools

For TUI users, the practical takeaway is:

- `grove tui` is now Nexus-first when Nexus is configured
- remote mode is solid for observing a server-backed grove
- local mode is still the path for tmux-backed session spawn and terminal
  capture

## Where to Go Deeper

- [MCP setup guide](./mcp-setup.md)
- [Protocol spec](../../spec/PROTOCOL.md)
- [Grove contract spec](../../spec/GROVE-CONTRACT.md)
- [Lifecycle spec](../../spec/LIFECYCLE.md)
- [Frontier spec](../../spec/FRONTIER.md)
- [Relations spec](../../spec/RELATIONS.md)
- [Test plan](../testing/test-plan.md)
