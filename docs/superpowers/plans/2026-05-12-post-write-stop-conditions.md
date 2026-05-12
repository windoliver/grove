# Post-Write Stop Conditions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move contribution stop-condition evaluation entirely to the post-write path while preserving stop broadcasts and lifecycle checks.

**Architecture:** `PolicyEnforcer` remains responsible for policy validation and derived outcomes, but not stop detection. `contributeOperation` owns contribution-write stop results by running `evaluateStopConditions()` after persistence against the updated store. Lifecycle and MCP stop checks continue to call `evaluateStopConditions()` directly.

**Tech Stack:** Bun 1.3.x, TypeScript strict mode, `bun:test`, Biome.

---

### Task 1: Lock In PolicyEnforcer Stop Removal Tests

**Files:**
- Modify: `src/core/policy-enforcer.test.ts`
- Modify: `src/core/stop-conditions.test.ts`

- [ ] **Step 1: Replace direct PolicyEnforcer stop assertions**

In `src/core/policy-enforcer.test.ts`, change the `PolicyEnforcer: stop conditions`, `PolicyEnforcer: max_rounds_without_improvement`, `PolicyEnforcer: quorum_review_score stop condition`, `PolicyEnforcer: deliberation_limit stop condition`, and session stop-condition tests so they assert:

```ts
const result = await enforcer.enforce(contribution, false);
expect(result.stopResult).toBeUndefined();
```

- [ ] **Step 2: Update cross-path stop tests**

In `src/core/stop-conditions.test.ts`, remove assertions that direct `PolicyEnforcer.enforce()` agrees with `evaluateStopConditions()`. Keep canonical `evaluateStopConditions()` assertions and update the describe/test names to document that direct enforcer calls no longer evaluate stops.

- [ ] **Step 3: Run red tests**

Run:

```bash
tmpdir=$(mktemp -d /tmp/grove-bunfig.XXXXXX)
tmp="$tmpdir/bunfig.toml"
printf '[test]\ncoverage = false\n' > "$tmp"
PATH="/Users/tafeng/.bun/bin:$PATH" bun --config="$tmp" test src/core/policy-enforcer.test.ts src/core/stop-conditions.test.ts
rc=$?
rm -rf "$tmpdir"
exit $rc
```

Expected: tests fail because `PolicyEnforcer.enforce()` still returns stop results.

### Task 2: Remove Stop Work From PolicyEnforcer

**Files:**
- Modify: `src/core/policy-enforcer.ts`
- Modify: `src/core/stop-conditions.ts`

- [ ] **Step 1: Remove the stop evaluator import and options**

In `src/core/policy-enforcer.ts`, delete:

```ts
import { evaluateStopConditions } from "./stop-conditions.js";
```

Change the `enforce()` options type to remove `skipStopConditions` and `skipExpensiveStopChecks`.

- [ ] **Step 2: Delete the pre-write stop block**

In `src/core/policy-enforcer.ts`, remove the block that declares `let stopResult` and calls `evaluateStopConditions()`. Return only the policy fields, leaving `stopResult` absent.

- [ ] **Step 3: Update comments**

Update the file header and `enforce()` docs so they list validation, gate checks, and outcome derivation, but not stop-condition evaluation.

- [ ] **Step 4: Remove stale stop-options docs**

In `src/core/stop-conditions.ts`, update `EvaluateStopConditionsOptions.skipExpensive` comments so they refer to callers that deliberately want cheap-only evaluation, not `PolicyEnforcer.enforce()` on the pre-write hot path.

- [ ] **Step 5: Run policy tests green**

Run:

```bash
tmpdir=$(mktemp -d /tmp/grove-bunfig.XXXXXX)
tmp="$tmpdir/bunfig.toml"
printf '[test]\ncoverage = false\n' > "$tmp"
PATH="/Users/tafeng/.bun/bin:$PATH" bun --config="$tmp" test src/core/policy-enforcer.test.ts src/core/stop-conditions.test.ts
rc=$?
rm -rf "$tmpdir"
exit $rc
```

Expected: all tests in those two files pass.

### Task 3: Make ContributeOperation Always Own Write Stop Results

**Files:**
- Modify: `src/core/operations/contribute.ts`
- Modify: `src/core/operations/contribute-routing.test.ts`
- Modify: `src/core/operations/plan.test.ts`

- [ ] **Step 1: Update enforcement calls**

In `src/core/operations/contribute.ts`, call:

```ts
policyResult = await enforcer.enforce(c, true);
```

and:

```ts
policyResult = await enforcer.enforce(contribution, true);
```

The routing classification booleans stay in place, but `skipStopConditions` becomes a local post-write guard only.

- [ ] **Step 2: Update post-write comments**

Rewrite the post-write comment to say this is the only stop-condition evaluation for contribution writes and runs outside the mutex.

- [ ] **Step 3: Preserve skip behavior**

Keep this post-write guard:

```ts
!skipStopConditions &&
policyResult !== undefined &&
deps.contract?.stopConditions !== undefined &&
deps.contributionStore !== undefined
```

Do not depend on `!policyResult.stopResult?.stopped`, since pre-write stop results no longer exist.

- [ ] **Step 4: Run operation tests**

Run:

```bash
tmpdir=$(mktemp -d /tmp/grove-bunfig.XXXXXX)
tmp="$tmpdir/bunfig.toml"
printf '[test]\ncoverage = false\n' > "$tmp"
PATH="/Users/tafeng/.bun/bin:$PATH" bun --config="$tmp" test src/core/operations/contribute-routing.test.ts src/core/operations/plan.test.ts
rc=$?
rm -rf "$tmpdir"
exit $rc
```

Expected: all tests in those two files pass.

### Task 4: Full Local Verification

**Files:**
- Modify: no source files

- [ ] **Step 1: Run typecheck**

Run:

```bash
PATH="/Users/tafeng/.bun/bin:$PATH" bun --bun run typecheck
```

Expected: exit 0.

- [ ] **Step 2: Run focused tests**

Run:

```bash
tmpdir=$(mktemp -d /tmp/grove-bunfig.XXXXXX)
tmp="$tmpdir/bunfig.toml"
printf '[test]\ncoverage = false\n' > "$tmp"
PATH="/Users/tafeng/.bun/bin:$PATH" bun --config="$tmp" test src/core/policy-enforcer.test.ts src/core/stop-conditions.test.ts src/core/operations/contribute-routing.test.ts src/core/operations/plan.test.ts
rc=$?
rm -rf "$tmpdir"
exit $rc
```

Expected: exit 0.

- [ ] **Step 3: Run Biome check**

Run:

```bash
PATH="/Users/tafeng/.bun/bin:$PATH" bun run check
```

Expected: exit 0.
