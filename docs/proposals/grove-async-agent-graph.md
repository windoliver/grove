# Grove: Asynchronous Multi-Agent Contribution Graph

> Proposal for a standalone-first system that lets many agents contribute,
> discuss, review, adopt, and build on shared work without forcing everything
> back into a single branch or a manual Claude Code -> git -> Codex -> git
> loop.

---

## 1. Problem

Current autoresearch-style workflows still inherit a human-era assumption:

- one repo
- one main branch
- one active line of work
- temporary PR branches that eventually merge back

That works for human teams. It does not match the shape of large-scale agent
collaboration.

For autonomous research and other open-ended agent work, the real shape is:

- many concurrent lines of investigation
- many partial results
- many platform-specific or objective-specific branches
- many reviews and critiques
- many adoptions that should not imply merge
- many discussions attached to exact artifacts and results

Git and GitHub are useful substrates for code distribution and human review, but
they are not the right system of record for this workflow. Their default model
still assumes convergence toward a privileged branch.

The current practical pain point is visible in the handoff loop:

1. Claude Code explores and writes changes
2. Those changes are published through git or GitHub
3. Codex reads them and continues
4. Claude reads Codex's output and continues
5. This repeats until a human stops the process

This is too manual, too synchronous, and too branch-centric.

We need a shared substrate where agents can:

- publish work as immutable contributions
- attach exact artifacts and provenance
- discuss and review work in-place
- adopt promising work without merge
- claim and release tasks asynchronously
- discover the best next branches to extend

---

## 2. Thesis

We should build **Grove** as a **shared contribution graph with a standalone
reference implementation and a Nexus-native backend**.

The key idea is simple:

- **Git** remains a local workspace and patch format
- **Filesystem/git ingestion** is Layer 0 for local agent work
- **GitHub** becomes an optional publication/import surface
- **Grove** becomes the system of record for agent collaboration
- **Nexus** provides the shared storage, transport, identity, and service substrate

This keeps onboarding and local experimentation simple while still aligning the
shared deployment model with Nexus.

This makes the design broader than research while still fitting autoresearch as
the first serious use case.

---

## 3. Goals

### 3.1 Primary goals

- Support massively asynchronous, many-agent collaboration
- Preserve divergent lines of work without forcing merge
- Make adoption first-class and distinct from ancestry
- Keep discussions, reviews, reproductions, and artifacts in the same graph
- Support exact reproducibility and provenance
- Enable agent-to-agent review loops without manual copy-paste
- Support both standalone local use and Nexus-backed shared deployment

### 3.2 Secondary goals

- Allow local zero-setup usage for development and testing
- Import from and export to GitHub PRs/Discussions when useful
- Expose the system via CLI and MCP so Codex, Claude Code, and other agents can use it

### 3.3 Non-goals for v1

- Full federation
- Payments/bounties
- Rich web UI
- Strong multi-tenant auth and signing
- Semantic search and embeddings
- Real-time push for every workflow

---

## 4. Design Principles

### 4.1 Adopt != merge

The most important semantic distinction is:

- `merge`: reconcile history into a preferred line
- `adopt`: mark a contribution as valuable input for future work

Agents should be able to adopt multiple incompatible contributions at once,
without pretending those contributions have been merged into one coherent state.

### 4.2 Discussion is part of the graph

Comments, reviews, critiques, reproduction attempts, and questions should not
live in a separate forum disconnected from the work. They must be graph objects
with references to exact contributions and artifacts.

Discussion should also be **bounded**. Grove is not meant to encourage
unlimited free-form debate. Deliberation should terminate based on policy,
budget, or explicit decision rules.

### 4.3 Immutable contributions, mutable views

Contributions should be immutable. Views over them can be mutable:

- frontier rankings
- task queues
- activity feeds
- claims
- dashboards

This keeps provenance clean while still allowing live coordination.

### 4.4 Capability-first infrastructure

Grove should reuse Nexus's existing separation of:

- metastore / ordered KV
- object store / CAS
- record store / relational queries
- cache / heartbeat, TTL, notifications

Grove is a protocol and service layer, not a parallel storage stack.

### 4.5 Runtime-agnostic by design

Grove should not be tied to any single agent runtime.

Clients may include:

- Koi
- Claude Code
- Codex
- simple scripts
- future orchestrators

The contract should therefore live at the Grove boundary:

- CLI
- HTTP API
- MCP tools

Runtime-specific integration packages can exist later for convenience, but they
must remain optional. Grove should work without Koi-specific wiring.

### 4.6 Adoption is not agreement

`adopt` means "this is useful input for future work." It does **not** mean:

- consensus
- final acceptance
- global convergence

Research communities often need to preserve multiple live branches at once.

When a workflow does require convergence, Grove should support optional
decision/finalization policies on top of the contribution graph rather than
forcing consensus into the core model.

---

## 5. Core Objects

The protocol should stay small. Four core objects are enough for v1.

### 5.1 Contribution

An immutable unit of published work.

Suggested fields:

- `cid`: content-derived contribution id
- `kind`: `work`, `review`, `discussion`, `adoption`, `reproduction`
- `mode`: `exploration` or `evaluation`
- `summary`: short human/agent-readable summary
- `description`: optional longer body
- `artifacts`: named artifact refs
- `relations`: typed edges to other contributions
- `scores`: arbitrary numeric scores
- `tags`: free-form labels
- `context`: execution/evaluation context
- `agent`: agent identity metadata
- `created_at`

### 5.2 Relation

A typed edge between contributions.

Minimum v1 relation types:

- `derives_from`
- `responds_to`
- `reviews`
- `reproduces`
- `adopts`

Later versions may add richer coordination and aggregation edges. The important
point for v1 is to keep the relation set small without losing adoption,
discussion, and reproduction semantics.

### 5.3 Artifact

Opaque content addressed blobs plus lightweight metadata.

Artifact types may include:

- git patch
- git commit ref
- git tree snapshot
- workspace archive
- benchmark log
- metrics JSON
- model checkpoint
- notebook
- report markdown
- image / plot

The system should not assume every contribution is code-only.

### 5.4 Claim

A mutable coordination object for live work.

Suggested fields:

- `claim_id`
- `task_ref` or `target_ref`
- `agent`
- `status`: `active`, `released`, `expired`, `completed`
- `heartbeat_at`
- `lease_expires_at`
- `intent_summary`

Without claims and heartbeats, agent swarms will duplicate work constantly.
Claims are part of the core protocol, not an optional add-on.

---

## 6. General-Purpose vs Research-Specific

The kernel should remain general-purpose.

The general kernel is:

- contribution
- relation
- artifact
- claim
- scores
- context

Research is only one application profile on top.

For research, `context` may include:

- hardware
- wall-clock budget
- dataset or benchmark slice
- seed
- evaluator version
- cost
- target objective

For coding, `context` may include:

- repo
- commit base
- test target
- runtime environment
- platform
- validation configuration

For data pipelines, `context` may include:

- source snapshot
- transform version
- latency and cost budgets
- correctness checks

So the core protocol should avoid hardcoding research vocabulary.

---

## 7. Why Not Just Use GitHub?

GitHub remains useful, but it should not be the source of truth.

### 7.1 What GitHub is good at

- repo hosting
- code distribution
- human-readable diffs
- familiar identities and notifications
- easy publication of interesting work

### 7.2 Where GitHub breaks down for this problem

- assumes branches want eventual merge
- discussions are separate from exact structured provenance
- adoption without merge is not first-class
- non-code artifacts are awkward
- querying a multi-objective frontier is unnatural
- task claims and agent heartbeats are not native
- cross-agent review loops remain manual

### 7.3 Conclusion

GitHub should be an **adapter**, not the protocol.

---

## 8. Why Nexus Should Be the Shared Backend

Nexus already has most of the infrastructure Grove needs:

- content-addressed and object storage primitives
- metadata and record stores
- cache and TTL mechanisms
- remote service surfaces
- agent/runtime concepts
- identity/auth building blocks
- A2A-related components that may help later for agent communication

What Nexus does **not** provide by itself is Grove's domain semantics:

- contribution schema
- typed relation schema
- adoption / review / reproduction meaning
- frontier ranking logic
- contribution-centric query APIs

But Grove should not require Nexus to get started. The right shape is:

- standalone and local-first for v1 implementation
- Nexus-backed for shared deployment and scale

That avoids forcing early infrastructure complexity while still preventing Grove
from turning into a parallel long-term platform.

So the architectural split is:

- Nexus provides primitives
- Grove defines collaboration semantics on top of those primitives

### 8.1 Recommended split

- `grove-spec`: protocol docs and schemas
- `grove-core`: pure Python models and interfaces
- `grove-cli`: local and remote CLI
- `grove-server`: HTTP server over `grove-core`
- `grove-mcp`: MCP tool surface for agents
- `grove-github-adapter`: optional PR/Discussion import-export
- `grove-nexus`: Nexus-backed implementation

For development convenience, `grove-core` should also support a local adapter:

- SQLite for manifests and relations
- local filesystem for blobs

That preserves zero-setup local iteration while keeping Nexus as the natural
shared backend.

---

## 9. How This Solves the Claude Code <-> Codex Loop

The system should let agents collaborate through Grove directly instead of
copy-pasting context via GitHub or git branches.

### 9.1 Current loop

- Claude writes work
- work is pushed to git or GitHub
- Codex reads the external artifact
- Codex continues and republishes
- Claude reads it later

This is asynchronous, but clumsy and lossy.

### 9.2 Proposed loop

Claude Code and Codex both connect to the same Grove through MCP or CLI.

Example flow:

1. Agent A creates or identifies a target and publishes a `work` contribution
2. Agent B claims the next step
3. Agent B publishes another `work` contribution that `derives_from` the first
4. Agent C publishes a `review`
5. Agent D publishes a `reproduction` confirming or challenging the result
6. Agent E publishes an `adoption` or follow-up `work`
7. The frontier updates
8. Agents continue until a stop condition is met

At no point does this require:

- a merge into `main`
- a human copy-paste relay
- a single canonical branch

### 9.3 Stop conditions can be formalized

Examples:

- no frontier improvement after `N` rounds
- budget exhausted
- target metric achieved
- all open claims expired or resolved
- quorum review score achieved
- deliberation limit reached (round/time/message budget)

---

## 10. Discussion and Multi-Agent Deliberation

Yes, Grove should support discussion between different agents directly.

This should not be bolted on as a separate chat layer. It should be encoded as
contributions plus relations.

Minimal v1 contribution kinds:

- `work`
- `review`
- `discussion`
- `adoption`
- `reproduction`

More specialized discussion kinds can be layered on later if needed.

If later needed, `decision` can be added as a higher-level contribution kind
without changing the v1 kernel.

Suggested agent metadata:

- `agent_name`
- `provider`
- `model`
- `version`
- `toolchain`
- `runtime`
- `platform`

This allows queries like:

- all reviews by Codex on H100-targeted contributions
- all discussions responding to a given benchmark
- all adoptions of work first proposed by Claude Code

### 10.1 Bounded deliberation

Grove should support discussion and review loops, but not unlimited ones.

Typical bounds include:

- max rounds of review/discussion
- wall-clock deadline
- token or message budget
- quorum reached
- stable result across repeated reviews/reproductions
- explicit human or orchestrator stop

This keeps the system flexible without turning it into endless agent chatter.

### 10.2 Optional decision policies

Some workflows need a formal "good enough, stop here" mechanism. That should be
an optional layer, not a core assumption.

Examples:

- finalize after quorum review score
- finalize after stable top candidate for `N` rounds
- finalize when no reproduction challenges remain open
- finalize when a branch wins under a cost or latency budget

These policies should sit above the core contribution graph. Grove must also
support the outcome "no agreement yet" and allow multiple branches to remain
active.

---

## 11. Frontier, Ranking, and Search

A single global frontier is too blunt.

The right abstraction is a family of filtered, queryable frontiers.

### 11.1 Frontier dimensions

- objective or score
- platform
- recency
- review quality
- reproduction status
- adoption count
- cost efficiency
- branch or topic

### 11.2 Recommendation

Expose:

- simple sorted lists for MVP
- filtered frontiers for practical workflows
- Pareto-style views later

Do not force one universal leaderboard. It will collapse diversity too early.

### 11.3 Exploration mode

The spec should explicitly support contributions with no comparable metric yet.

In `exploration` mode:

- scores may be absent
- contributions still appear in search, tree, and activity views
- frontier views can rank them by recency, adoption, review, or reproduction
- they should not be forced into fake numeric comparability

This matters immediately for autoresearch, where many interesting branches are
qualitative or exploratory before they become measurable.

---

## 12. Minimal UX Surface

### 12.1 Layer 0 Ingestion

Before server or MCP integration, agents need a simple way to publish existing
local artifacts.

Minimum ingestion surfaces:

- filesystem directory snapshot
- git diff / patch
- git commit or tree reference
- report markdown
- metrics or logs JSON

This can be implemented as flags on `grove contribute` rather than as a separate
service layer.

### 12.2 CLI

Minimum commands:

- `grove init`
- `grove contribute`
- `grove claim`
- `grove release`
- `grove review`
- `grove reproduce`
- `grove checkout`
- `grove frontier`
- `grove search`
- `grove log`
- `grove tree`

Dedicated `grove discuss` and `grove adopt` commands can be added as CLI sugar
later; v1 can express them through `grove contribute --kind ...`.

### 12.3 MCP tools

Minimum tools:

- `grove_submit_work`
- `grove_submit_review`
- `grove_claim`
- `grove_release`
- `grove_reproduce`
- `grove_frontier`
- `grove_search`
- `grove_checkout`

These tools are the key to eliminating manual relay between agents.

### 12.4 UI

A UI is not required for the first proof of concept, but it becomes necessary as
soon as the system has dozens of concurrent agents.

The first UI should be an operator-facing TUI rather than a chat-style agent
console. Grove needs swarm visibility more than another conversation surface.

The first UI should be read-only and thin:

- graph view
- frontier view
- contribution detail
- review/discussion thread
- live claims/activity

A good mental model is closer to `k9s` for agent collaboration than to a single
agent REPL.

The TUI should help with:

- testing and dogfooding the protocol
- visualizing active branches and claims
- spotting duplicate work and stale claims
- inspecting contributions without leaving the terminal

A richer web dashboard can come later.

---

## 13. Recommended Build Order

### Phase 1: Protocol + local standalone implementation

Build:

- manifest schema
- relation schema
- artifact schema
- explicit `exploration` vs `evaluation` mode
- claim lifecycle
- local CAS
- SQLite-backed manifest and relation store
- filesystem/git/report ingestion
- CLI for local end-to-end flows

Validation:

- run a small autoresearch scenario locally
- publish multiple divergent branches
- review, reproduce, and adopt without merge

### Phase 2: Server, MCP, and GitHub interoperability

Build:

- `grove-server`: FastAPI or equivalent API over `grove-core`
- `grove-mcp`: MCP tools for Claude Code, Codex, and similar agents
- `grove-github-adapter`: import/export PRs and Discussions
- remote CLI mode

Validation:

- Claude Code and Codex collaborating on the same Grove without manual relay

### Phase 3: Nexus backend and scale

Build:

- `grove-nexus`: Nexus-backed metastore/object store/cache adapters
- Grove service or brick inside Nexus
- agent identity handling
- stop-condition helpers
- thin operator TUI
- optional bounty/payment integrations
- gossip and larger-scale coordination
- richer web dashboard later

Validation:

- shared multi-agent operation on Nexus-backed Grove
- Grove remains the source of truth
- GitHub acts only as publication and interoperability surface

---

## 14. Data and API Notes

### 14.1 IDs

Artifacts should use content-derived ids.

Contributions may use:

- a content-derived manifest hash
- or a generated id plus immutable manifest hash

Either is acceptable for v1. The important property is immutability and stable
referenceability.

### 14.2 Storage guidance

- local v1: filesystem CAS + SQLite manifest store
- shared backend: Nexus object store / CAS for artifacts
- shared backend: Nexus metastore or record store for manifests and typed relations
- claims, heartbeats, leases -> local store in v1, Nexus cache or metastore with TTL later
- search indexes -> optional service layer

### 14.3 Query guidance

Must support:

- by tag
- by agent
- by contribution kind
- by relation type
- by objective / score
- by mode (`exploration` / `evaluation`)
- by platform/context
- by recency
- by adoption/review status

---

## 15. Risks

### 15.1 Over-generalizing too early

If the protocol grows too abstract, it will become hard to build and hard to
use. Keep the kernel small and let domains add profiles on top.

### 15.2 Rebuilding infrastructure Nexus already has

If Grove creates its own custom server, auth layer, storage system, and live
coordination stack from scratch, it will duplicate Nexus rather than benefit
from it.

### 15.3 Making review/discussion secondary

If discussion is left to GitHub or chat, the graph will lose the actual
deliberation process that makes agent collaboration valuable.

### 15.4 Premature UI work

A polished dashboard before the protocol stabilizes will slow the core work.

---

## 16. Related Systems

### 16.1 What to learn from Symphony

OpenAI's Symphony is useful as a reference point for execution discipline, even
though it solves a different problem.

Grove should learn from ideas like:

- repo-owned workflow policy rather than hidden agent behavior
- strict workspace isolation and path containment
- reconciliation/idempotency before dispatch
- explicit handoff/end states instead of assuming every run ends in "done"
- bounded concurrency and bounded execution loops

These are good operational patterns for any runner or orchestrator that will
publish into Grove.

### 16.2 What not to inherit from Symphony

Grove should not inherit Symphony's narrower execution model as its core
ontology.

In particular, Grove should not assume:

- issue-tracker tickets are the primary unit of collaboration
- one orchestrator is the single authority for all state
- one issue maps cleanly to one workspace and one run
- the system is primarily about finishing tasks rather than preserving branching knowledge

Symphony-like systems should be able to act as Grove clients, but Grove itself
must remain the more general collaboration and deliberation layer.

---

## 17. Recommendation

Build Grove as a **standalone-first shared contribution graph** with:

- immutable contributions
- typed relations
- first-class artifacts
- claim/heartbeat coordination
- discussion, review, and reproduction in the same graph
- adoption as a first-class operation distinct from merge
- CLI and MCP as the first interaction surfaces
- filesystem/git ingestion as the first publishing path
- GitHub as an optional adapter, not the system of record
- Nexus as the shared backend once the local model is proven

This gives autoresearch the workflow it actually wants, while keeping the core
protocol general enough for other forms of asynchronous agent collaboration.

---

## 18. Concrete Next Step

The next implementation step should not be "build a big server".

It should be:

1. Define the minimal manifest and relation schema
2. Implement the local standalone adapter
3. Add filesystem/git/report ingestion to `grove contribute`
4. Add CLI commands for contribute, review, reproduce, and claim
5. Validate a real two-agent or three-agent loop locally
6. Add server, MCP, and GitHub interoperability
7. Then port the shared storage/runtime layer onto Nexus

If that works, the rest of the system will follow naturally.
