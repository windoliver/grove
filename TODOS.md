# TODOS

Items discovered during Grove v2 CEO review (2026-03-20).

## P2 — Post-v2 cleanup

### Remove TmuxRuntime fallback
- **What:** Remove `TmuxRuntime` adapter once acpx is proven stable in production.
- **Why:** TmuxRuntime exists only as a safety net during acpx integration. Once acpx handles all supported agents reliably, the tmux codepath is dead weight.
- **Effort:** S | **Depends on:** Phase 2 (AgentRuntime) shipped + acpx stability proven (~1 month)

### Separate EventBus semaphore from store semaphore
- **What:** Nexus per-store semaphore (20 concurrent ops) may be shared with EventBus. EventBus should have its own semaphore to avoid reducing DAG write throughput.
- **Why:** Under load (10+ agents), EventBus publishes compete with DAG writes for the same semaphore slots.
- **Effort:** S | **Depends on:** Phase 3 (EventBus routing) shipped

### Git worktree pooling for swarm-scale
- **What:** Pre-create a pool of git worktrees and assign them to agents on spawn, rather than creating worktrees on-demand.
- **Why:** `git worktree add` takes 200-500ms. At 50+ agents, sequential creation is 10-25 seconds. Pooling amortizes this.
- **Effort:** M | **Depends on:** Swarm runtime (prior CEO plan)

### Provider.ts capability flag cleanup
- **What:** The 11 optional capability interfaces + type guards in `provider.ts` are an anti-pattern. The `AgentRuntime` interface provides a path to simplify: spawn/send/close replace ad-hoc claim/heartbeat/workspace methods.
- **Why:** New features currently require adding a new interface + type guard + conditional logic everywhere. Fragile and hard to trace.
- **Effort:** M | **Depends on:** Phase 2 (AgentRuntime) shipped

## P3 — Edge cases and polish

### Contract re-evaluation on mid-session change
- **What:** When GROVE.md changes mid-session (cherry-pick #6), optionally re-evaluate existing contributions against the new contract. Currently deferred — only detection + notification + diff ships in v2.
- **Why:** Semantically tricky: a previously accepted contribution might now violate the new contract. Need a policy for handling this (flag, reject, ignore).
- **Effort:** M | **Depends on:** Cherry-pick #6 (contract watcher) shipped

### Empty summary validation
- **What:** `grove_contribute` with an empty string summary passes schema validation. Add minimum length check (e.g., 10 chars).
- **Why:** Empty summaries provide no value in the contribution DAG and make the TUI feed unreadable.
- **Effort:** S | **Depends on:** Phase 1 (enforcement pipeline)

### Score tie policy
- **What:** Define outcome when a new contribution has the same score as the frontier best. Currently undefined — could be "unchanged", "tied", or treated as "improved" (same threshold met).
- **Why:** Tie-breaking affects frontier ranking and outcome derivation. Need a consistent policy.
- **Effort:** S | **Depends on:** Phase 1 (outcome derivation)

### Contract watcher debounce tuning
- **What:** The contract file watcher (cherry-pick #6) needs a debounce interval to handle rapid saves (e.g., editor auto-save). Start with 1s, tune based on usage.
- **Why:** Without debounce, rapid GROVE.md edits trigger multiple diff/notification cycles.
- **Effort:** S | **Depends on:** Cherry-pick #6 shipped
