# Grove Workstreams

Four parallel streams organized by domain. Each stream can progress
independently, with explicit sync points where one stream needs output
from another.

```
  ┌───────────────────────────┐   ┌───────────────────────────┐
  │  Stream 1: Protocol/Spec  │   │  Stream 2: Core Engine    │
  │  (7 issues)               │   │  (8 issues)               │
  │  Schemas + contracts      │   │  Models, store, CAS,      │
  │  #1,#2,#3,#4 (parallel)   │   │  frontier, Symphony ops   │
  │  → #5 → #23 → #26        │   │  #7 → #8,#9 → #10        │
  │                           │   │  → #24, #25, #27, #39     │
  └───────────────────────────┘   └──────┬──────────┬─────────┘
                                         │          │
              ┌──────────────────────────▼┐  ┌──────▼──────────────────┐
              │  Stream 3: CLI &          │  │  Stream 4: Network,     │
              │  Agent Surface (7 issues) │  │  Integration & Scale    │
              │  #11→#12→#13→#14          │  │  (7 issues)             │
              │  #16, #39, #28            │  │  #15→#17→#18            │
              └───────────────────────────┘  │  #19→#20→#21→#22        │
                                             └─────────────────────────┘
```

**All 4 streams are parallel.** Streams 1 & 2 both start from the same
proposal document — Stream 1 formalizes it into JSON schemas, Stream 2
implements it in TypeScript. Any mismatches get caught in normal code
review, no special sync needed.

**Streams 3 & 4** start once Stream 2's core engine (#7-#10) is
functional, and run in parallel with each other.

**Total: 28 issues + #6 (done) = 29**

---

## Stream 1: Protocol & Spec

**Theme:** Define the protocol schemas, semantics, and machine-readable
contracts. Pure markdown and JSON schema — no TypeScript code dependencies.
Can start immediately and inform all other streams.

| Order | Issue | Title | Phase |
|-------|-------|-------|-------|
| 1.1 | [#1](https://github.com/windoliver/grove/issues/1) | Define contribution manifest schema | P1 |
| 1.2 | [#2](https://github.com/windoliver/grove/issues/2) | Define relation schema and semantics | P1 |
| 1.3 | [#3](https://github.com/windoliver/grove/issues/3) | Define artifact schema and CAS addressing | P1 |
| 1.4 | [#4](https://github.com/windoliver/grove/issues/4) | Define claim lifecycle for swarm coordination | P1 |
| 1.5 | [#5](https://github.com/windoliver/grove/issues/5) | Define frontier algorithm and exploration mode | P1 |
| 1.6 | [#23](https://github.com/windoliver/grove/issues/23) | GROVE.md as repo-owned workflow contract | P1 |
| 1.7 | [#26](https://github.com/windoliver/grove/issues/26) | Explicit handoff states and stop conditions | P1 |

**Dependencies:** None — starts immediately, runs in parallel with Stream 2.

**Deliverables:**
- `spec/schemas/contribution.json`, `relation.json`, `artifact.json`, `claim.json`
- `spec/PROTOCOL.md`, `spec/RELATIONS.md`, `spec/FRONTIER.md`, `spec/LIFECYCLE.md`
- `spec/GROVE-CONTRACT.md` with JSON Schema for GROVE.md
- Example GROVE.md files for autoresearch and code optimization

**Internal order:**
- #1-#4 can run in parallel (four independent schemas)
- #5 depends on #1 (needs score/contribution schema)
- #23 depends on #5 (GROVE.md references metrics, stop conditions)
- #26 depends on #4, #23 (handoff states reference claims and GROVE.md)

**Relationship to Stream 2:** Both streams work from the same proposal.
Stream 1 produces formal schemas, Stream 2 produces TypeScript code.
Mismatches (if any) get caught in normal code review — no blocking
dependency in either direction.

---

## Stream 2: Core Engine

**Theme:** Build the data layer — models, store, CAS, frontier calculator,
and Symphony operational patterns. Pure TypeScript with `bun:sqlite` and
filesystem I/O. No network, no CLI parsing.

| Order | Issue | Title | Phase |
|-------|-------|-------|-------|
| 2.0 | [#6](https://github.com/windoliver/grove/issues/6) | Project scaffolding and repo structure | P1 ✅ |
| 2.1 | [#7](https://github.com/windoliver/grove/issues/7) | Implement grove-core models | P1 (partial ✅) |
| 2.2 | [#8](https://github.com/windoliver/grove/issues/8) | Implement store protocol and SQLite backend | P1 |
| 2.3 | [#9](https://github.com/windoliver/grove/issues/9) | Implement local filesystem CAS | P1 |
| 2.4 | [#10](https://github.com/windoliver/grove/issues/10) | Implement multi-signal frontier calculator | P1 |
| 2.5 | [#24](https://github.com/windoliver/grove/issues/24) | Workspace isolation and path containment | P1 |
| 2.6 | [#25](https://github.com/windoliver/grove/issues/25) | Reconciliation and idempotency | P1 |
| 2.7 | [#27](https://github.com/windoliver/grove/issues/27) | Bounded concurrency and execution limits | P1 |
| 2.8 | [#39](https://github.com/windoliver/grove/issues/39) | Discussion ergonomics: thread queries (store helpers) | P1 |

**Dependencies:** None — starts immediately, in parallel with Stream 1.
Works directly from the proposal document.

**Deliverables:**
- `src/core/models.ts` — complete with `computeCid()`, serialization
- `src/local/sqlite-store.ts` — full CRUD, relations, search, claims
- `src/local/fs-cas.ts` — BLAKE3 CAS with atomic writes
- `src/core/frontier.ts` — multi-signal calculator
- Workspace isolation, reconciliation, concurrency enforcement
- 80%+ test coverage for all modules

**Internal order:**
- #7 first (models are the foundation)
- #8, #9 can run in parallel after #7 (store and CAS are independent)
- #10 depends on #8 (frontier queries the store)
- #24 depends on #9 (workspaces use CAS for checkout)
- #25 depends on #8 (reconciliation sweeps the store)
- #27 depends on #8 (concurrency limits enforced at store layer)
- #39 store helpers depend on #8 (thread/replyCounts extend store protocol); CLI/MCP depend on #11, #16

**Sync point → Streams 3 & 4:** Core engine (#7-#10) must be functional
before CLI (#11) or server (#15) can be built. #8 and #9 are the critical
path — everything downstream blocks on a working store + CAS.

**Note on #7:** Initial models are already implemented (enums, interfaces,
tests). Remaining work: `computeCid()`, `toManifest()`/`fromManifest()`,
and additional AgentIdentity fields from proposal §10 (`version`,
`toolchain`, `runtime`).

---

## Stream 3: CLI & Agent Surface

**Theme:** Build the surfaces that agents and humans interact with — CLI
commands, MCP tools, operator TUI. Depends on Stream 2 core engine.

| Order | Issue | Title | Phase |
|-------|-------|-------|-------|
| 3.1 | [#11](https://github.com/windoliver/grove/issues/11) | CLI: grove init and grove contribute | P1 |
| 3.2 | [#12](https://github.com/windoliver/grove/issues/12) | CLI: grove claim and grove release | P1 |
| 3.3 | [#13](https://github.com/windoliver/grove/issues/13) | CLI: grove checkout, frontier, search, log, tree | P1 |
| 3.4 | [#14](https://github.com/windoliver/grove/issues/14) | End-to-end validation: autoresearch scenario | P1 |
| 3.5 | [#16](https://github.com/windoliver/grove/issues/16) | grove-mcp: MCP tools for agents | P2 |
| 3.6 | [#39](https://github.com/windoliver/grove/issues/39) | Discussion ergonomics: CLI/MCP shorthands + activity | P1 |
| 3.7 | [#28](https://github.com/windoliver/grove/issues/28) | Operator TUI for swarm visibility (k9s-style) | P2 |

**Dependencies:** Stream 2 (#7-#10 at minimum).

**Deliverables:**
- Full CLI: init, contribute, claim, release, checkout, frontier, search, log, tree
- Layer 0 ingestion: `--artifacts`, `--from-git-diff`, `--from-git-tree`, `--from-report`
- MCP server (stdio + HTTP/SSE) with all grove tools
- k9s-style TUI: dashboard, DAG view, claims, activity stream
- E2E validation scenarios in `examples/`

**Internal order:**
- #11 first (init + contribute are foundational CLI)
- #12 can start once #11's init is done (claims need a grove)
- #13 depends on #11, #12 (checkout/frontier/search assume data exists)
- #14 depends on #11-#13 (E2E exercises all CLI commands)
- #16 can start once #11-#12 are stable (MCP wraps the same core)
- #39 CLI depends on #11 (discuss/thread/threads are CLI commands); MCP depends on #16
- #28 can start once #13 is stable (TUI visualizes frontier/tree/claims); #39 store helpers unblock #28 threaded views

**CLI commands mapped to proposal §12.2:**
| Proposal command | Issue |
|-----------------|-------|
| `grove init` | #11 |
| `grove contribute` | #11 |
| `grove claim` | #12 |
| `grove release` | #12 |
| `grove review` | #11 (via `--kind review`) |
| `grove reproduce` | #11 (via `--kind reproduction`) |
| `grove checkout` | #13 |
| `grove frontier` | #13 |
| `grove search` | #13 |
| `grove log` | #13 |
| `grove tree` | #13 |
| `grove discuss` | #39 |
| `grove thread` | #39 |
| `grove threads` | #39 |

**MCP tools mapped to proposal §12.3:**
| Proposal tool | Issue |
|--------------|-------|
| `grove_submit_work` | #16 |
| `grove_submit_review` | #16 |
| `grove_claim` | #16 |
| `grove_release` | #16 |
| `grove_reproduce` | #16 |
| `grove_frontier` | #16 |
| `grove_search` | #16 |
| `grove_checkout` | #16 |
| `grove_discuss` | #39 |
| `grove_thread` | #39 |

---

## Stream 4: Network, Integration & Scale

**Theme:** HTTP server, GitHub adapter, Nexus backend, gossip protocol,
and web dashboard. Depends on Stream 2 core engine. Can run in parallel
with Stream 3.

| Order | Issue | Title | Phase |
|-------|-------|-------|-------|
| 4.1 | [#15](https://github.com/windoliver/grove/issues/15) | grove-server: HTTP API over grove-core | P2 |
| 4.2 | [#17](https://github.com/windoliver/grove/issues/17) | grove-github-adapter: PR/Discussion import/export | P2 |
| 4.3 | [#18](https://github.com/windoliver/grove/issues/18) | E2E: Claude Code + Codex collaboration | P2 |
| 4.4 | [#19](https://github.com/windoliver/grove/issues/19) | grove-nexus: Nexus-backed store and CAS | P3 |
| 4.5 | [#20](https://github.com/windoliver/grove/issues/20) | Bounty and payment integration via NexusPay | P3 |
| 4.6 | [#21](https://github.com/windoliver/grove/issues/21) | Gossip protocol for frontier propagation | P3 |
| 4.7 | [#22](https://github.com/windoliver/grove/issues/22) | Web dashboard | P3 |

**Dependencies:** Stream 2 (#7-#10). Stream 3 (#16) for #18.

**Deliverables:**
- HTTP API server (Hono/Elysia on Bun)
- GitHub import/export adapter
- Multi-agent E2E validation (Claude Code + Codex on same grove)
- Nexus-backed store + CAS adapters
- NexusPay bounty integration
- Gossip protocol for decentralized frontier propagation
- Web dashboard (D3/Cytoscape.js)

**Internal order:**
- #15 first (server is the foundation for remote access)
- #17 can run in parallel with #15 (GitHub adapter uses core, not server)
- #18 depends on #15 + Stream 3 #16 (needs server + MCP for multi-agent test)
- #19 depends on #8, #9 interfaces (ports store/CAS to Nexus primitives)
- #20 depends on #19 (bounties need Nexus payment infrastructure)
- #21 depends on #15 (gossip extends the server layer)
- #22 depends on #15, #28 (web dashboard after TUI, uses server API)

---

## Cross-Stream Sync Points

```
Week   Stream 1         Stream 2         Stream 3         Stream 4
       Protocol         Core Engine      CLI/Agent        Network/Scale
─────  ───────────────  ───────────────  ───────────────  ──────────────
 1-2   #1,#2,#3,#4      #7 (models)       —                —
       (parallel)        (extend stubs)

 3-4   #5 (frontier)     #8,#9 (parallel)  —                —
       #23 (GROVE.md)    store + CAS

 5-6   #26 (handoff)     #10 (frontier)   #11 (init +      #15 (server)
                         #24 (workspace)  contribute)       #17 (github)

 7-8   (done)            #25 (reconcile)  #12 (claim)       (continues)
                         #27 (concurrency) #13 (query CLIs)
                         #39 (thread qry)  #39 (discuss CLI)

 9-10                    (done)           #14 (E2E local)   #18 (multi-
                                          #16 (MCP)         agent E2E)

 11+                                      #28 (TUI)         #19→#20→#21
                                                            →#22
```

---

## Proposal Coverage Audit

Every section of the proposal (`grove-async-agent-graph.md`) is mapped
to at least one issue:

| Proposal Section | Issue(s) | Status |
|-----------------|----------|--------|
| §1 Problem | Background | — |
| §2 Thesis | Background | — |
| §3 Goals | Background | — |
| §4.1 Adopt != merge | #2 | ✅ |
| §4.2 Discussion in graph | #1, #7 | ✅ |
| §4.3 Immutable contributions | #7 | ✅ |
| §4.4 Capability-first | #19 | ✅ |
| §4.5 Runtime-agnostic | #16 | ✅ |
| §4.6 Adoption != agreement | #2, #26 | ✅ |
| §5.1 Contribution | #1, #7 | ✅ |
| §5.2 Relation | #2, #7 | ✅ |
| §5.3 Artifact | #3, #9 | ✅ |
| §5.4 Claim | #4, #12 | ✅ |
| §6 General-purpose context | #1 (free-form dict) | ✅ |
| §7 Why not GitHub | #17 | ✅ |
| §8 Why Nexus | #19 | ✅ |
| §8.1 Recommended split | #6 ✅ | ✅ |
| §9 Agent loop | #18 | ✅ |
| §9.3 Stop conditions | #26 | ✅ |
| §10 Discussion/deliberation | #1, #26, #39 | ✅ |
| §10.1 Bounded deliberation | #26, #39 | ✅ |
| §10.2 Decision policies | #26 | ✅ |
| §10 Agent metadata | #7 | ⚠️ minor |
| §11.1 Frontier dimensions | #5, #10 | ✅ |
| §11.2 Simple → filtered → Pareto | #5, #10 | ✅ |
| §11.3 Exploration mode | #5, #10 | ✅ |
| §12.1 Layer 0 ingestion | #11 | ✅ |
| §12.2 CLI commands | #11, #12, #13 | ✅ |
| §12.3 MCP tools | #16 | ✅ |
| §12.4 UI (TUI → web) | #28, #22 | ✅ |
| §13 Build order | Phase structure | ✅ |
| §14.1 IDs | #1, #3 | ✅ |
| §14.2 Storage | #8, #9 | ✅ |
| §14.3 Query guidance | #8, #13 | ✅ |
| §15 Risks | Background | — |
| §16.1 Symphony patterns | #23-#27 | ✅ |
| §17 Recommendation | All | ✅ |
| §18 Next step | Phase 1 | ✅ |

### Minor Gap

**§10 Agent metadata:** Proposal lists `version`, `toolchain`, `runtime`
as agent fields. Current `AgentIdentity` in `models.ts` has `agentId`,
`agentName`, `provider`, `model`, `platform`. The three missing fields
should be added when #7 is completed. They are optional and don't block
any other work.
