# Session-Config Consumers Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor PolicyEnforcer, EnforcingStore, and evaluateStopConditions to accept `SessionRuntimeConfig` instead of `GroveContract`, decoupling enforcement consumers from the contract type.

**Architecture:** Narrow constructor/function parameter types from `GroveContract` to `SessionRuntimeConfig` (a `Pick<GroveContract, ...>` already defined in `src/core/session-config.ts`). Rename internal `this.contract` fields to `this.config`. All existing callers continue to type-check since `GroveContract` structurally satisfies `SessionRuntimeConfig`. Add one integration test proving session config overrides contract.

**Tech Stack:** TypeScript, Vitest

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/core/stop-conditions.ts` | Modify | Change function parameter type |
| `src/core/policy-enforcer.ts` | Modify | Change constructor type + internal rename |
| `src/core/enforcing-store.ts` | Modify | Change both class constructors + internal rename |
| `src/core/policy-enforcer.test.ts` | Modify | Update type import |
| `src/core/stop-conditions.test.ts` | Modify | Update type import |
| `src/core/enforcing-store.test.ts` | Modify | Update type import |

Callers that pass `GroveContract` values don't need code changes — the value already satisfies the narrowed `SessionRuntimeConfig` type. TypeScript structural typing handles this.

---

### Task 1: Change `evaluateStopConditions` signature

This is the leaf dependency — PolicyEnforcer calls it, so change it first.

**Files:**
- Modify: `src/core/stop-conditions.ts:12,59-62`
- Test: `src/core/stop-conditions.test.ts`

- [ ] **Step 1: Update function signature and import**

In `src/core/stop-conditions.ts`, change the import and parameter type:

```typescript
// Line 12: replace GroveContract import
// Before:
import type { GroveContract, MetricDefinition } from "./contract.js";
// After:
import type { MetricDefinition } from "./contract.js";
import type { SessionRuntimeConfig } from "./session-config.js";
```

```typescript
// Lines 59-62: change parameter type
// Before:
export async function evaluateStopConditions(
  contract: GroveContract,
  store: ContributionStore,
): Promise<StopEvaluationResult> {
// After:
export async function evaluateStopConditions(
  config: SessionRuntimeConfig,
  store: ContributionStore,
): Promise<StopEvaluationResult> {
```

Then rename all internal references from `contract` to `config` within this function body. Specifically:
- Line 64: `const stopConditions = contract.stopConditions;` → `const stopConditions = config.stopConditions;`
- Line 81 (approx): where `contract.metrics` is passed → `config.metrics`

- [ ] **Step 2: Run tests to verify nothing breaks**

Run: `npx vitest run src/core/stop-conditions.test.ts`
Expected: All tests pass. The tests construct `GroveContract`-shaped objects and pass them — these satisfy `SessionRuntimeConfig` structurally.

- [ ] **Step 3: Commit**

```bash
git add src/core/stop-conditions.ts
git commit -m "refactor: evaluateStopConditions accepts SessionRuntimeConfig (#199)"
```

---

### Task 2: Change `PolicyEnforcer` constructor

**Files:**
- Modify: `src/core/policy-enforcer.ts:25,89,103-111`
- Test: `src/core/policy-enforcer.test.ts`

- [ ] **Step 1: Update imports**

In `src/core/policy-enforcer.ts`:

```typescript
// Line 25: narrow the import
// Before:
import type { Gate, GroveContract, MetricDefinition } from "./contract.js";
// After:
import type { Gate, MetricDefinition } from "./contract.js";
import type { SessionRuntimeConfig } from "./session-config.js";
```

- [ ] **Step 2: Update class field and constructor**

```typescript
// Line 89: rename field
// Before:
  private readonly contract: GroveContract;
// After:
  private readonly config: SessionRuntimeConfig;

// Lines 103-111: change constructor parameter
// Before:
  constructor(
    contract: GroveContract,
    contributionStore: ContributionStore,
    outcomeStore?: OutcomeStore | undefined,
  ) {
    this.contract = contract;
// After:
  constructor(
    config: SessionRuntimeConfig,
    contributionStore: ContributionStore,
    outcomeStore?: OutcomeStore | undefined,
  ) {
    this.config = config;
```

- [ ] **Step 3: Rename all `this.contract` references to `this.config`**

Search-and-replace within `policy-enforcer.ts`: `this.contract` → `this.config`. Affected lines (approx):
- Line 229: `this.contract.gates`
- Line 247: `this.contract.outcomePolicy`
- Line 268: `this.contract.stopConditions`
- Line 270: `evaluateStopConditions(this.contract, ...)` → `evaluateStopConditions(this.config, ...)`
- Line 315: `this.contract.agentConstraints`
- Line 382: `this.contract.agentConstraints`
- Line 410: `this.contract.agentConstraints`
- Line 438: `this.contract.evaluation`
- Line 552, 676, 791: `this.contract.metrics`
- Line 665, 708: `this.contract.outcomePolicy`, `this.contract.gates`

Also update the JSDoc comments referencing "contract" where they describe the parameter.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/core/policy-enforcer.test.ts`
Expected: All 67+ tests pass. Test code passes `GroveContract`-shaped objects which satisfy `SessionRuntimeConfig`.

- [ ] **Step 5: Commit**

```bash
git add src/core/policy-enforcer.ts
git commit -m "refactor: PolicyEnforcer accepts SessionRuntimeConfig (#199)"
```

---

### Task 3: Change `EnforcingContributionStore` and `EnforcingClaimStore` constructors

**Files:**
- Modify: `src/core/enforcing-store.ts:18,137-138,153-166,496-503`
- Test: `src/core/enforcing-store.test.ts`

- [ ] **Step 1: Update import**

In `src/core/enforcing-store.ts`:

```typescript
// Line 18: replace import
// Before:
import type { GroveContract } from "./contract.js";
// After:
import type { SessionRuntimeConfig } from "./session-config.js";
```

- [ ] **Step 2: Update EnforcingContributionStore**

```typescript
// Line 137: rename field
// Before:
  private readonly contract: GroveContract;
// After:
  private readonly config: SessionRuntimeConfig;

// Lines 153-166: change constructor parameter
// Before:
  constructor(
    inner: ContributionStore,
    contract: GroveContract,
    options?: {
      cas?: ContentStore;
      clock?: () => Date;
    },
  ) {
    this.inner = inner;
    this.contract = contract;
// After:
  constructor(
    inner: ContributionStore,
    config: SessionRuntimeConfig,
    options?: {
      cas?: ContentStore;
      clock?: () => Date;
    },
  ) {
    this.inner = inner;
    this.config = config;
```

Then rename all `this.contract` references in `EnforcingContributionStore` to `this.config` (rate limit checks around lines 321, 343).

- [ ] **Step 3: Update EnforcingClaimStore**

```typescript
// Line 496: rename field
// Before:
  private readonly contract: GroveContract;
// After:
  private readonly config: SessionRuntimeConfig;

// Line 499: change constructor parameter
// Before:
  constructor(inner: ClaimStore, contract: GroveContract) {
    this.inner = inner;
    this.contract = contract;
// After:
  constructor(inner: ClaimStore, config: SessionRuntimeConfig) {
    this.inner = inner;
    this.config = config;
```

Then rename all `this.contract` references in `EnforcingClaimStore` to `this.config` (execution/concurrency checks around lines 515-522, 578).

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/core/enforcing-store.test.ts`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/enforcing-store.ts
git commit -m "refactor: EnforcingStore classes accept SessionRuntimeConfig (#199)"
```

---

### Task 4: Update JSDoc and module-level comments

**Files:**
- Modify: `src/core/policy-enforcer.ts` (module docstring line 1-22)
- Modify: `src/core/enforcing-store.ts` (module docstring lines 1-15)
- Modify: `src/core/stop-conditions.ts` (module docstring lines 1-10)

- [ ] **Step 1: Update references from "contract" to "config" in doc comments**

In `policy-enforcer.ts` module docstring:
- Line 133: Update "Contract hot-reload" comment to reference config instead of contract.

In `enforcing-store.ts` module docstring:
- Line 4: `These decorators compose a raw store with a GroveContract to enforce:` → `These decorators compose a raw store with a SessionRuntimeConfig to enforce:`

In `stop-conditions.ts`:
- Line 6: Update "grove contract" reference to "session config".

- [ ] **Step 2: Commit**

```bash
git add src/core/policy-enforcer.ts src/core/enforcing-store.ts src/core/stop-conditions.ts
git commit -m "docs: update module docstrings for session-config refactor (#199)"
```

---

### Task 5: Add session-config-wins integration test

Prove that a PolicyEnforcer constructed with session config enforces different rules than the original contract would.

**Files:**
- Modify: `src/core/policy-enforcer.test.ts`

- [ ] **Step 1: Add test for session config override**

Add to the end of `src/core/policy-enforcer.test.ts`:

```typescript
describe("session config override", () => {
  test("session config with different agentConstraints overrides contract", async () => {
    // Session config allows only "review" kind
    const sessionConfig: SessionRuntimeConfig = {
      mode: ContributionMode.Evaluation,
      agentConstraints: { allowedKinds: ["review"] },
    };

    const store = makeStore();
    const enforcer = new PolicyEnforcer(sessionConfig, store);

    // "work" kind should be rejected by session config
    const workContribution = makeContribution({ kind: "work", mode: "evaluation" });
    const result = await enforcer.enforce(workContribution, false);
    expect(result.passed).toBe(false);
    expect(result.violations).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "role_kind" })]),
    );

    // "review" kind should pass
    const reviewContribution = makeContribution({ kind: "review", mode: "evaluation" });
    const reviewResult = await enforcer.enforce(reviewContribution, false);
    expect(reviewResult.violations.filter((v) => v.type === "role_kind")).toHaveLength(0);
  });

  test("session config with different stopConditions is used", async () => {
    // Session config with a very low budget
    const sessionConfig: SessionRuntimeConfig = {
      stopConditions: { budget: { maxContributions: 1 } },
    };

    // Store already has 1 contribution → budget should be exhausted
    const store = makeStore([
      makeContribution({ kind: "work" }),
    ]);
    const enforcer = new PolicyEnforcer(sessionConfig, store);
    const contribution = makeContribution({ kind: "work" });
    const result = await enforcer.enforce(contribution, false);
    expect(result.stopResult?.stopped).toBe(true);
  });
});
```

Ensure `SessionRuntimeConfig` is imported at the top of the test file:
```typescript
import type { SessionRuntimeConfig } from "./session-config.js";
```

- [ ] **Step 2: Run the new test**

Run: `npx vitest run src/core/policy-enforcer.test.ts`
Expected: All tests pass including the new ones.

- [ ] **Step 3: Commit**

```bash
git add src/core/policy-enforcer.test.ts
git commit -m "test: add session-config-wins tests for PolicyEnforcer (#199)"
```

---

### Task 6: Full test verification

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass. No type errors.

- [ ] **Step 2: Run type check**

Run: `npx tsc --noEmit`
Expected: No errors. All callers passing `GroveContract` still compile against `SessionRuntimeConfig` parameters.

- [ ] **Step 3: Run lint**

Run: `npx biome check src/core/policy-enforcer.ts src/core/enforcing-store.ts src/core/stop-conditions.ts`
Expected: No issues.
