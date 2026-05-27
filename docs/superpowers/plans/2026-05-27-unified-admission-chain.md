# Unified Admission Chain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a pre-contribution admission chain that unifies `admission:`, legacy `hooks.before_contribute`, legacy `gates:`, audit metadata, and optional Nexus ReBAC/governance checks.

**Architecture:** Add a focused `src/core/admission/` package that owns admission protocols, normalization, validators, audit metadata, and rejection errors. `contributeOperation` runs the chain before CID computation and stores admission evidence under `context.admission`. Nexus mode plugs in through small TypeScript adapters backed by the existing Nexus `/api/nfs/{method}` RPC surface, keeping Grove core independent of Nexus Python internals.

**Tech Stack:** Bun 1.3.x, TypeScript strict mode, `bun:test`, Zod, Biome, Nexus REST/RPC over `fetch`.

---

## File Structure

- Create `src/core/admission/types.ts`: admission rule types, runtime protocol interfaces, audit metadata types, adapter interfaces.
- Create `src/core/admission/errors.ts`: `AdmissionRejectError` and evidence normalization.
- Create `src/core/admission/normalize.ts`: convert explicit `admission:`, `hooks.before_contribute`, and `gates:` into ordered admission rules.
- Create `src/core/admission/chain.ts`: two-pass mutator/validator executor and audit builder.
- Create `src/core/admission/validators.ts`: local validators for shell, metrics, artifacts, relations, blueprint hash, signatures, ReBAC, and governance.
- Create `src/core/admission/index.ts`: public exports for the package.
- Create `src/core/admission/normalize.test.ts`, `src/core/admission/chain.test.ts`, and `src/core/admission/validators.test.ts`.
- Modify `src/core/contract.ts`: parse and expose `admission` on `GroveContract`.
- Modify `src/core/contract.test.ts`: parser and cross-field coverage for admission rules.
- Modify `src/core/errors.ts` and `src/core/operations/result.ts`: map admission rejection to operation errors.
- Modify `src/core/operations/deps.ts`: add optional admission adapters.
- Modify `src/core/operations/contribute.ts`: run admission before CID computation and avoid duplicate legacy gate enforcement.
- Modify `src/core/operations/contribute.test.ts`: contribution acceptance, rejection, idempotency, and audit tests.
- Create `src/nexus/nexus-rpc-client.ts`: typed minimal Nexus `/api/nfs/{method}` RPC caller.
- Create `src/nexus/nexus-admission-adapters.ts`: Nexus-backed ReBAC and governance adapter implementations.
- Create `src/nexus/nexus-admission-adapters.test.ts`: mock-fetch tests for Nexus adapter behavior.
- Modify `src/local/runtime.ts`, server/MCP/CLI operation adapter files as needed: pass configured adapters into `OperationDeps`.
- Modify `spec/GROVE-CONTRACT.md`, `spec/schemas/grove-contract.json`, `spec/schemas/grove-contract.test.ts`, `GROVE.md`, and `README.md`: document the new contract shape.

### Task 1: Contract Types and Parser

**Files:**
- Modify: `src/core/contract.ts`
- Modify: `src/core/contract.test.ts`

- [ ] **Step 1: Write parser tests for explicit admission rules**

Append these tests near the existing v3 contract tests in `src/core/contract.test.ts`:

```ts
test("parses v3 admission rules", () => {
  const contract = parseGroveContract(`---
contract_version: 3
name: admission-test
metrics:
  coverage:
    direction: maximize
admission:
  - type: shell
    name: lint
    command: "bun run lint"
    timeout: 120000
    on_fail: reject
  - type: metric_check
    name: coverage_floor
    metric: coverage
    direction: maximize
    min_value: 0.8
  - type: artifact_required
    name: has_report
    artifact: report.json
  - type: relation_required
    name: derives_from_parent
    relation_type: derives_from
  - type: blueprint_hash
    name: coder_blueprint
    blueprint: ./blueprints/coder.yaml
    expected_hash: blake3:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
    on_mismatch: reject
  - type: artifact_signature
    name: signed_report
    artifact: report.json
    require_signer_in:
      - .grove/allowed-signers
  - type: rebac_permission
    name: reviewer_can_review
    permission: review
    object_type: contribution
  - type: governance_policy
    name: fraud_status
    policy: fraud_score_below
    max_score: 0.75
---
# Admission Test
`);

  expect(contract.admission).toEqual([
    {
      type: "shell",
      name: "lint",
      command: "bun run lint",
      timeout: 120000,
      onFail: "reject",
    },
    {
      type: "metric_check",
      name: "coverage_floor",
      metric: "coverage",
      direction: "maximize",
      minValue: 0.8,
    },
    { type: "artifact_required", name: "has_report", artifact: "report.json" },
    { type: "relation_required", name: "derives_from_parent", relationType: "derives_from" },
    {
      type: "blueprint_hash",
      name: "coder_blueprint",
      blueprint: "./blueprints/coder.yaml",
      expectedHash: "blake3:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      onMismatch: "reject",
    },
    {
      type: "artifact_signature",
      name: "signed_report",
      artifact: "report.json",
      requireSignerIn: [".grove/allowed-signers"],
    },
    {
      type: "rebac_permission",
      name: "reviewer_can_review",
      permission: "review",
      objectType: "contribution",
    },
    {
      type: "governance_policy",
      name: "fraud_status",
      policy: "fraud_score_below",
      maxScore: 0.75,
    },
  ]);
});

test("rejects duplicate admission rule names", () => {
  expect(() =>
    parseGroveContract(`---
contract_version: 3
name: duplicate-admission
admission:
  - type: shell
    name: lint
    command: "bun run lint"
  - type: metric_check
    name: lint
    metric: coverage
    min_value: 0.8
---
`),
  ).toThrow("duplicate admission rule name 'lint'");
});

test("rejects admission metric references not defined in metrics", () => {
  expect(() =>
    parseGroveContract(`---
contract_version: 3
name: bad-admission-metric
admission:
  - type: metric_check
    name: coverage_floor
    metric: coverage
    min_value: 0.8
---
`),
  ).toThrow("admission rule 'coverage_floor' references undefined metric 'coverage'");
});
```

- [ ] **Step 2: Run parser tests to verify they fail**

Run:

```bash
PATH="/Users/tafeng/.bun/bin:$PATH" bun test src/core/contract.test.ts
```

Expected: tests fail because `admission` is not yet accepted by the contract schemas.

- [ ] **Step 3: Add admission schemas and TypeScript types**

In `src/core/contract.ts`, after the `GateSchema` declaration, add:

```ts
const AdmissionOnFailSchema = z.enum(["reject", "warn"]).default("reject");

const AdmissionRuleBaseSchema = z.object({
  name: z
    .string()
    .regex(/^[a-z][a-z0-9_-]*$/)
    .max(128),
});

const ShellAdmissionRuleSchema = AdmissionRuleBaseSchema.extend({
  type: z.literal("shell"),
  command: z.string().min(1).max(4096),
  timeout: z.number().int().positive().optional(),
  on_fail: AdmissionOnFailSchema.optional(),
}).strict();

const MetricCheckAdmissionRuleSchema = AdmissionRuleBaseSchema.extend({
  type: z.literal("metric_check"),
  metric: z.string().regex(MetricNamePattern).max(64),
  direction: z.enum(["minimize", "maximize"]).optional(),
  min_value: z.number().optional(),
  max_value: z.number().optional(),
})
  .strict()
  .refine((rule) => rule.min_value !== undefined || rule.max_value !== undefined, {
    message: "metric_check admission rule requires min_value or max_value",
  });

const ArtifactRequiredAdmissionRuleSchema = AdmissionRuleBaseSchema.extend({
  type: z.literal("artifact_required"),
  artifact: z.string().min(1).max(256),
}).strict();

const RelationRequiredAdmissionRuleSchema = AdmissionRuleBaseSchema.extend({
  type: z.literal("relation_required"),
  relation_type: z.enum(["derives_from", "responds_to", "reviews", "reproduces", "adopts"]),
}).strict();

const BlueprintHashAdmissionRuleSchema = AdmissionRuleBaseSchema.extend({
  type: z.literal("blueprint_hash"),
  blueprint: z.string().min(1).max(1024),
  expected_hash: z.string().min(1).max(256).optional(),
  on_mismatch: z.literal("reject").default("reject").optional(),
}).strict();

const ArtifactSignatureAdmissionRuleSchema = AdmissionRuleBaseSchema.extend({
  type: z.literal("artifact_signature"),
  artifact: z.string().min(1).max(256).optional(),
  require_signer_in: z.array(z.string().min(1).max(1024)).min(1).max(20),
}).strict();

const RebacPermissionAdmissionRuleSchema = AdmissionRuleBaseSchema.extend({
  type: z.literal("rebac_permission"),
  permission: z.string().min(1).max(128),
  object_type: z.string().min(1).max(128),
  object_id_context_key: z.string().min(1).max(128).optional(),
}).strict();

const GovernancePolicyAdmissionRuleSchema = AdmissionRuleBaseSchema.extend({
  type: z.literal("governance_policy"),
  policy: z.enum(["constraint_check", "fraud_score_below", "governance_status_clean"]),
  max_score: z.number().min(0).max(1).optional(),
}).strict();

const AdmissionRuleSchema = z.discriminatedUnion("type", [
  ShellAdmissionRuleSchema,
  MetricCheckAdmissionRuleSchema,
  ArtifactRequiredAdmissionRuleSchema,
  RelationRequiredAdmissionRuleSchema,
  BlueprintHashAdmissionRuleSchema,
  ArtifactSignatureAdmissionRuleSchema,
  RebacPermissionAdmissionRuleSchema,
  GovernancePolicyAdmissionRuleSchema,
]);

const AdmissionSchema = z
  .array(AdmissionRuleSchema)
  .max(50)
  .superRefine((rules, ctx) => {
    const seen = new Set<string>();
    for (const [index, rule] of rules.entries()) {
      if (seen.has(rule.name)) {
        ctx.addIssue({
          code: "custom",
          path: [index, "name"],
          message: `duplicate admission rule name '${rule.name}'`,
        });
      }
      seen.add(rule.name);
    }
  });
```

Then add the TypeScript rule types near the `Gate` interface:

```ts
export type AdmissionRule =
  | ShellAdmissionRule
  | MetricCheckAdmissionRule
  | ArtifactRequiredAdmissionRule
  | RelationRequiredAdmissionRule
  | BlueprintHashAdmissionRule
  | ArtifactSignatureAdmissionRule
  | RebacPermissionAdmissionRule
  | GovernancePolicyAdmissionRule;

export interface ShellAdmissionRule {
  readonly type: "shell";
  readonly name: string;
  readonly command: string;
  readonly timeout?: number | undefined;
  readonly onFail?: "reject" | "warn" | undefined;
}

export interface MetricCheckAdmissionRule {
  readonly type: "metric_check";
  readonly name: string;
  readonly metric: string;
  readonly direction?: ScoreDirection | undefined;
  readonly minValue?: number | undefined;
  readonly maxValue?: number | undefined;
}

export interface ArtifactRequiredAdmissionRule {
  readonly type: "artifact_required";
  readonly name: string;
  readonly artifact: string;
}

export interface RelationRequiredAdmissionRule {
  readonly type: "relation_required";
  readonly name: string;
  readonly relationType: RelationType;
}

export interface BlueprintHashAdmissionRule {
  readonly type: "blueprint_hash";
  readonly name: string;
  readonly blueprint: string;
  readonly expectedHash?: string | undefined;
  readonly onMismatch?: "reject" | undefined;
}

export interface ArtifactSignatureAdmissionRule {
  readonly type: "artifact_signature";
  readonly name: string;
  readonly artifact?: string | undefined;
  readonly requireSignerIn: readonly string[];
}

export interface RebacPermissionAdmissionRule {
  readonly type: "rebac_permission";
  readonly name: string;
  readonly permission: string;
  readonly objectType: string;
  readonly objectIdContextKey?: string | undefined;
}

export interface GovernancePolicyAdmissionRule {
  readonly type: "governance_policy";
  readonly name: string;
  readonly policy: "constraint_check" | "fraud_score_below" | "governance_status_clean";
  readonly maxScore?: number | undefined;
}
```

Add `readonly admission?: readonly AdmissionRule[] | undefined;` to `GroveContract`.

- [ ] **Step 4: Wire schemas into v2/v3 and convert wire names**

In `GroveContractV2Schema` and `GroveContractV3Schema`, add:

```ts
admission: AdmissionSchema.optional(),
```

In `wireVxToContract()`, add:

```ts
...(wire.admission !== undefined && {
  admission: wire.admission.map(wireToAdmissionRule),
}),
```

Add this converter near the other `wireTo*` helpers:

```ts
function wireToAdmissionRule(rule: z.infer<typeof AdmissionRuleSchema>): AdmissionRule {
  switch (rule.type) {
    case "shell":
      return {
        type: "shell",
        name: rule.name,
        command: rule.command,
        ...(rule.timeout !== undefined ? { timeout: rule.timeout } : {}),
        ...(rule.on_fail !== undefined ? { onFail: rule.on_fail } : {}),
      };
    case "metric_check":
      return {
        type: "metric_check",
        name: rule.name,
        metric: rule.metric,
        ...(rule.direction !== undefined ? { direction: rule.direction } : {}),
        ...(rule.min_value !== undefined ? { minValue: rule.min_value } : {}),
        ...(rule.max_value !== undefined ? { maxValue: rule.max_value } : {}),
      };
    case "artifact_required":
      return { type: "artifact_required", name: rule.name, artifact: rule.artifact };
    case "relation_required":
      return {
        type: "relation_required",
        name: rule.name,
        relationType: rule.relation_type as RelationType,
      };
    case "blueprint_hash":
      return {
        type: "blueprint_hash",
        name: rule.name,
        blueprint: rule.blueprint,
        ...(rule.expected_hash !== undefined ? { expectedHash: rule.expected_hash } : {}),
        ...(rule.on_mismatch !== undefined ? { onMismatch: rule.on_mismatch } : {}),
      };
    case "artifact_signature":
      return {
        type: "artifact_signature",
        name: rule.name,
        ...(rule.artifact !== undefined ? { artifact: rule.artifact } : {}),
        requireSignerIn: rule.require_signer_in,
      };
    case "rebac_permission":
      return {
        type: "rebac_permission",
        name: rule.name,
        permission: rule.permission,
        objectType: rule.object_type,
        ...(rule.object_id_context_key !== undefined
          ? { objectIdContextKey: rule.object_id_context_key }
          : {}),
      };
    case "governance_policy":
      return {
        type: "governance_policy",
        name: rule.name,
        policy: rule.policy,
        ...(rule.max_score !== undefined ? { maxScore: rule.max_score } : {}),
      };
  }
}
```

- [ ] **Step 5: Add admission metric cross-reference validation**

In `validateMetricReferences()`, after the `contract.gates` block, add:

```ts
if (contract.admission !== undefined) {
  for (const rule of contract.admission) {
    if (
      (rule.type === "metric_check" || rule.type === "metric_improves") &&
      rule.metric !== undefined &&
      !metricNames.has(rule.metric)
    ) {
      errors.push(`admission rule '${rule.name}' references undefined metric '${rule.metric}'`);
    }
  }
}
```

If TypeScript rejects `metric_improves` because it is not yet in `AdmissionRule`, add only the `metric_check` branch in this task. `metric_improves` is added by normalization in Task 2.

- [ ] **Step 6: Run parser tests green**

Run:

```bash
PATH="/Users/tafeng/.bun/bin:$PATH" bun test src/core/contract.test.ts
```

Expected: `src/core/contract.test.ts` passes.

- [ ] **Step 7: Commit contract parsing**

Run:

```bash
git add src/core/contract.ts src/core/contract.test.ts
git commit -m "feat: parse admission contract rules"
```

### Task 2: Admission Normalization

**Files:**
- Create: `src/core/admission/types.ts`
- Create: `src/core/admission/normalize.ts`
- Create: `src/core/admission/index.ts`
- Create: `src/core/admission/normalize.test.ts`

- [ ] **Step 1: Write normalization tests**

Create `src/core/admission/normalize.test.ts`:

```ts
import { describe, expect, test } from "bun:test";

import type { GroveContract } from "../contract.js";
import { normalizeAdmissionRules } from "./normalize.js";

function contract(overrides: Partial<GroveContract>): GroveContract {
  return { contractVersion: 3, name: "test", ...overrides };
}

describe("normalizeAdmissionRules", () => {
  test("keeps explicit admission rules first", () => {
    const rules = normalizeAdmissionRules(
      contract({
        admission: [{ type: "shell", name: "lint", command: "bun run lint" }],
        gates: [{ type: "has_artifact", name: "report.json" }],
      }),
    );

    expect(rules.map((r) => r.name)).toEqual(["lint", "gate_has_artifact_report_json"]);
  });

  test("converts before_contribute hook to shell validator", () => {
    const rules = normalizeAdmissionRules(
      contract({
        hooks: { before_contribute: { cmd: "bun test", timeout: 12_000 } },
      }),
    );

    expect(rules).toEqual([
      {
        type: "shell",
        name: "before_contribute",
        command: "bun test",
        timeout: 12_000,
        onFail: "reject",
        source: "legacy_hook",
      },
    ]);
  });

  test("converts legacy gates to admission validators", () => {
    const rules = normalizeAdmissionRules(
      contract({
        gates: [
          { type: "metric_improves", metric: "accuracy" },
          { type: "has_artifact", name: "report.json" },
          { type: "has_relation", relationType: "derives_from" },
          { type: "min_score", metric: "coverage", threshold: 0.8 },
        ],
      }),
    );

    expect(rules).toEqual([
      {
        type: "metric_improves",
        name: "gate_metric_improves_accuracy",
        metric: "accuracy",
        source: "legacy_gate",
      },
      {
        type: "artifact_required",
        name: "gate_has_artifact_report_json",
        artifact: "report.json",
        source: "legacy_gate",
      },
      {
        type: "relation_required",
        name: "gate_has_relation_derives_from",
        relationType: "derives_from",
        source: "legacy_gate",
      },
      {
        type: "metric_check",
        name: "gate_min_score_coverage",
        metric: "coverage",
        minValue: 0.8,
        source: "legacy_gate",
      },
    ]);
  });
});
```

- [ ] **Step 2: Run normalization tests to verify they fail**

Run:

```bash
PATH="/Users/tafeng/.bun/bin:$PATH" bun test src/core/admission/normalize.test.ts
```

Expected: module resolution fails because the admission package does not exist.

- [ ] **Step 3: Add admission runtime and normalized rule types**

Create `src/core/admission/types.ts`:

```ts
import type { AdmissionRule, GroveContract } from "../contract.js";
import type { ContributionInput, JsonValue, RelationType, ScoreDirection } from "../models.js";
import type { ContributionStore } from "../store.js";
import type { HookEntry, HookRunner } from "../hooks.js";

export const AdmissionOp = {
  Contribute: "contribute",
} as const;
export type AdmissionOp = (typeof AdmissionOp)[keyof typeof AdmissionOp];

export type AdmissionRuleSource = "explicit" | "legacy_hook" | "legacy_gate";

export type NormalizedAdmissionRule =
  | (AdmissionRule & { readonly source: AdmissionRuleSource })
  | {
      readonly type: "metric_improves";
      readonly name: string;
      readonly metric: string;
      readonly source: AdmissionRuleSource;
    };

export interface AdmissionRuleAudit {
  readonly name: string;
  readonly type: NormalizedAdmissionRule["type"];
  readonly accepted: boolean;
  readonly reason?: string | undefined;
  readonly evidence?: Readonly<Record<string, JsonValue>> | undefined;
}

export interface AdmissionAudit {
  readonly version: 1;
  readonly accepted: boolean;
  readonly evaluatedAt: string;
  readonly rules: readonly AdmissionRuleAudit[];
  readonly annotations: Readonly<Record<string, string>>;
}

export interface AdmissionResult {
  readonly accepted: boolean;
  readonly audit: AdmissionAudit;
}

export interface AdmissionAttributes {
  readonly op: AdmissionOp;
  object: ContributionInput;
  readonly originalObject?: ContributionInput | undefined;
  readonly contract?: GroveContract | undefined;
  readonly annotations: Map<string, string>;
  readonly deps: AdmissionDeps;
}

export interface AdmissionMutator {
  readonly name: string;
  handles(op: AdmissionOp): boolean;
  mutate(attrs: AdmissionAttributes): Promise<void>;
}

export interface AdmissionValidator {
  readonly name: string;
  handles(op: AdmissionOp): boolean;
  validate(attrs: AdmissionAttributes): Promise<void>;
}

export interface AdmissionPermissionCheck {
  readonly subjectType: string;
  readonly subjectId: string;
  readonly permission: string;
  readonly objectType: string;
  readonly objectId: string;
  readonly zoneId?: string | undefined;
}

export interface AdmissionPermissionDecision {
  readonly allowed: boolean;
  readonly reason?: string | undefined;
  readonly evidence?: Readonly<Record<string, JsonValue>> | undefined;
}

export interface AdmissionPermissionResolver {
  check(input: AdmissionPermissionCheck): Promise<AdmissionPermissionDecision>;
}

export interface AdmissionGovernanceCheck {
  readonly policy: string;
  readonly agentId: string;
  readonly zoneId?: string | undefined;
  readonly contribution: ContributionInput;
  readonly maxScore?: number | undefined;
}

export interface AdmissionGovernanceDecision {
  readonly allowed: boolean;
  readonly reason?: string | undefined;
  readonly evidence?: Readonly<Record<string, JsonValue>> | undefined;
}

export interface AdmissionGovernanceEvaluator {
  evaluate(input: AdmissionGovernanceCheck): Promise<AdmissionGovernanceDecision>;
}

export interface BlueprintHashSource {
  hash(path: string): Promise<string | undefined>;
}

export interface ArtifactSignatureVerificationInput {
  readonly artifactName?: string | undefined;
  readonly artifactHashes: Readonly<Record<string, string>>;
  readonly context?: Readonly<Record<string, JsonValue>> | undefined;
  readonly requireSignerIn: readonly string[];
}

export interface ArtifactSignatureVerificationResult {
  readonly accepted: boolean;
  readonly reason?: string | undefined;
  readonly evidence?: Readonly<Record<string, JsonValue>> | undefined;
}

export interface ArtifactSignatureVerifier {
  verify(input: ArtifactSignatureVerificationInput): Promise<ArtifactSignatureVerificationResult>;
}

export interface AdmissionDeps {
  readonly contributionStore?: ContributionStore | undefined;
  readonly hookRunner?: HookRunner | undefined;
  readonly hookCwd?: string | undefined;
  readonly permissionResolver?: AdmissionPermissionResolver | undefined;
  readonly governanceEvaluator?: AdmissionGovernanceEvaluator | undefined;
  readonly blueprintHashSource?: BlueprintHashSource | undefined;
  readonly artifactSignatureVerifier?: ArtifactSignatureVerifier | undefined;
  readonly zoneId?: string | undefined;
}

export function hookEntryFromShellRule(rule: {
  readonly command: string;
  readonly timeout?: number | undefined;
}): HookEntry {
  return rule.timeout === undefined ? rule.command : { cmd: rule.command, timeout: rule.timeout };
}

export function scoreDirectionForRule(rule: { readonly direction?: ScoreDirection }): string {
  return rule.direction ?? "unspecified";
}

export function jsonRecord(value: Readonly<Record<string, JsonValue>>): Readonly<Record<string, JsonValue>> {
  return value;
}
```

- [ ] **Step 4: Add the normalizer**

Create `src/core/admission/normalize.ts`:

```ts
import type { Gate, GroveContract } from "../contract.js";
import { hookCommand, hookTimeout } from "../hooks.js";
import type { NormalizedAdmissionRule } from "./types.js";

const DEFAULT_HOOK_TIMEOUT_MS = 300_000;

function safeNamePart(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

function gateToAdmissionRule(gate: Gate): NormalizedAdmissionRule | undefined {
  switch (gate.type) {
    case "metric_improves":
      if (gate.metric === undefined) return undefined;
      return {
        type: "metric_improves",
        name: `gate_metric_improves_${safeNamePart(gate.metric)}`,
        metric: gate.metric,
        source: "legacy_gate",
      };
    case "has_artifact":
      if (gate.name === undefined) return undefined;
      return {
        type: "artifact_required",
        name: `gate_has_artifact_${safeNamePart(gate.name)}`,
        artifact: gate.name,
        source: "legacy_gate",
      };
    case "has_relation":
      if (gate.relationType === undefined) return undefined;
      return {
        type: "relation_required",
        name: `gate_has_relation_${gate.relationType}`,
        relationType: gate.relationType,
        source: "legacy_gate",
      };
    case "min_score":
      if (gate.metric === undefined || gate.threshold === undefined) return undefined;
      return {
        type: "metric_check",
        name: `gate_min_score_${safeNamePart(gate.metric)}`,
        metric: gate.metric,
        minValue: gate.threshold,
        source: "legacy_gate",
      };
    case "min_reviews":
      return undefined;
  }
}

export function normalizeAdmissionRules(contract: GroveContract | undefined): readonly NormalizedAdmissionRule[] {
  if (contract === undefined) return [];

  const rules: NormalizedAdmissionRule[] = [];
  for (const rule of contract.admission ?? []) {
    rules.push({ ...rule, source: "explicit" });
  }

  if (
    contract.hooks?.before_contribute !== undefined &&
    !rules.some((rule) => rule.name === "before_contribute")
  ) {
    rules.push({
      type: "shell",
      name: "before_contribute",
      command: hookCommand(contract.hooks.before_contribute),
      timeout: hookTimeout(contract.hooks.before_contribute, DEFAULT_HOOK_TIMEOUT_MS),
      onFail: "reject",
      source: "legacy_hook",
    });
  }

  for (const gate of contract.gates ?? []) {
    const rule = gateToAdmissionRule(gate);
    if (rule !== undefined && !rules.some((existing) => existing.name === rule.name)) {
      rules.push(rule);
    }
  }

  return rules;
}
```

- [ ] **Step 5: Add package exports**

Create `src/core/admission/index.ts`:

```ts
export * from "./types.js";
export * from "./normalize.js";
```

- [ ] **Step 6: Run normalization tests green**

Run:

```bash
PATH="/Users/tafeng/.bun/bin:$PATH" bun test src/core/admission/normalize.test.ts
```

Expected: `normalizeAdmissionRules` tests pass.

- [ ] **Step 7: Commit normalization**

Run:

```bash
git add src/core/admission src/core/contract.ts src/core/contract.test.ts
git commit -m "feat: normalize admission rules"
```

### Task 3: Admission Chain and Rejection Errors

**Files:**
- Create: `src/core/admission/errors.ts`
- Create: `src/core/admission/chain.ts`
- Create: `src/core/admission/chain.test.ts`
- Modify: `src/core/admission/index.ts`
- Modify: `src/core/errors.ts`
- Modify: `src/core/operations/result.ts`

- [ ] **Step 1: Write chain behavior tests**

Create `src/core/admission/chain.test.ts`:

```ts
import { describe, expect, test } from "bun:test";

import { ContributionKind, ContributionMode, type ContributionInput } from "../models.js";
import { AdmissionChain } from "./chain.js";
import { AdmissionRejectError } from "./errors.js";
import { AdmissionOp, type AdmissionMutator, type AdmissionValidator } from "./types.js";

function input(): ContributionInput {
  return {
    kind: ContributionKind.Work,
    mode: ContributionMode.Evaluation,
    summary: "work",
    artifacts: {},
    relations: [],
    tags: [],
    agent: { agentId: "agent-1" },
    createdAt: "2026-05-27T00:00:00.000Z",
  };
}

describe("AdmissionChain", () => {
  test("runs mutators before validators and validators see final object", async () => {
    const calls: string[] = [];
    const mutator: AdmissionMutator = {
      name: "add-tag",
      handles: () => true,
      mutate: async (attrs) => {
        calls.push("mutator");
        attrs.object = { ...attrs.object, tags: [...attrs.object.tags, "mutated"] };
        attrs.annotations.set("mutated", "true");
      },
    };
    const validator: AdmissionValidator = {
      name: "see-tag",
      handles: () => true,
      validate: async (attrs) => {
        calls.push(`validator:${attrs.object.tags.join(",")}`);
      },
    };

    const chain = new AdmissionChain({ mutators: [mutator], validators: [validator] });
    const result = await chain.admit({
      op: AdmissionOp.Contribute,
      object: input(),
      annotations: new Map(),
      deps: {},
    });

    expect(calls).toEqual(["mutator", "validator:mutated"]);
    expect(result.accepted).toBe(true);
    expect(result.audit.accepted).toBe(true);
    expect(result.audit.annotations).toEqual({ mutated: "true" });
  });

  test("fails fast on validator rejection", async () => {
    const calls: string[] = [];
    const chain = new AdmissionChain({
      mutators: [],
      validators: [
        {
          name: "reject",
          handles: () => true,
          validate: async () => {
            calls.push("reject");
            throw new AdmissionRejectError({
              ruleName: "reject",
              ruleType: "metric_check",
              reason: "score too low",
              evidence: { score: 0.2 },
            });
          },
        },
        {
          name: "never",
          handles: () => true,
          validate: async () => {
            calls.push("never");
          },
        },
      ],
    });

    await expect(
      chain.admit({
        op: AdmissionOp.Contribute,
        object: input(),
        annotations: new Map(),
        deps: {},
      }),
    ).rejects.toBeInstanceOf(AdmissionRejectError);
    expect(calls).toEqual(["reject"]);
  });
});
```

- [ ] **Step 2: Run chain tests to verify they fail**

Run:

```bash
PATH="/Users/tafeng/.bun/bin:$PATH" bun test src/core/admission/chain.test.ts
```

Expected: module resolution fails because `chain.ts` and `errors.ts` do not exist.

- [ ] **Step 3: Add admission rejection error and operation mapping**

Create `src/core/admission/errors.ts`:

```ts
import { GroveError } from "../errors.js";
import type { JsonValue } from "../models.js";
import type { NormalizedAdmissionRule } from "./types.js";

export interface AdmissionRejectOptions {
  readonly ruleName: string;
  readonly ruleType: NormalizedAdmissionRule["type"];
  readonly reason: string;
  readonly evidence?: Readonly<Record<string, JsonValue>> | undefined;
}

export class AdmissionRejectError extends GroveError {
  readonly ruleName: string;
  readonly ruleType: NormalizedAdmissionRule["type"];
  readonly reason: string;
  readonly evidence?: Readonly<Record<string, JsonValue>> | undefined;

  constructor(opts: AdmissionRejectOptions) {
    super(`Admission rejected by '${opts.ruleName}': ${opts.reason}`);
    this.name = "AdmissionRejectError";
    this.ruleName = opts.ruleName;
    this.ruleType = opts.ruleType;
    this.reason = opts.reason;
    this.evidence = opts.evidence;
  }
}
```

In `src/core/errors.ts`, import the type is not needed. Add `AdmissionRejectError` to the imports in `src/core/operations/result.ts`:

```ts
import { AdmissionRejectError } from "../admission/errors.js";
```

Then in `fromGroveError()` before the `PolicyViolationError` block, add:

```ts
if (error instanceof AdmissionRejectError) {
  return err({
    code: OperationErrorCode.PolicyViolation,
    message: error.message,
    details: {
      violationType: "admission_rejected",
      ruleName: error.ruleName,
      ruleType: error.ruleType,
      reason: error.reason,
      ...(error.evidence !== undefined ? { evidence: error.evidence } : {}),
    },
  });
}
```

- [ ] **Step 4: Add the admission chain executor**

Create `src/core/admission/chain.ts`:

```ts
import type { JsonValue } from "../models.js";
import { AdmissionRejectError } from "./errors.js";
import type {
  AdmissionAttributes,
  AdmissionAudit,
  AdmissionMutator,
  AdmissionResult,
  AdmissionValidator,
} from "./types.js";

export interface AdmissionChainOptions {
  readonly mutators: readonly AdmissionMutator[];
  readonly validators: readonly AdmissionValidator[];
}

function annotationsToRecord(annotations: Map<string, string>): Readonly<Record<string, string>> {
  return Object.fromEntries([...annotations.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function evidenceRecord(value: Readonly<Record<string, JsonValue>> | undefined):
  | Readonly<Record<string, JsonValue>>
  | undefined {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

export class AdmissionChain {
  private readonly mutators: readonly AdmissionMutator[];
  private readonly validators: readonly AdmissionValidator[];

  constructor(options: AdmissionChainOptions) {
    this.mutators = options.mutators;
    this.validators = options.validators;
  }

  async admit(attrs: AdmissionAttributes): Promise<AdmissionResult> {
    const rules: AdmissionAudit["rules"] = [];

    for (const mutator of this.mutators) {
      if (!mutator.handles(attrs.op)) continue;
      await mutator.mutate(attrs);
      rules.push({
        name: mutator.name,
        type: "shell",
        accepted: true,
        evidence: { phase: "mutating" },
      });
    }

    for (const validator of this.validators) {
      if (!validator.handles(attrs.op)) continue;
      try {
        await validator.validate(attrs);
        rules.push({
          name: validator.name,
          type: "metric_check",
          accepted: true,
          evidence: { phase: "validating" },
        });
      } catch (err) {
        if (err instanceof AdmissionRejectError) {
          rules.push({
            name: err.ruleName,
            type: err.ruleType,
            accepted: false,
            reason: err.reason,
            evidence: evidenceRecord(err.evidence),
          });
        }
        throw err;
      }
    }

    return {
      accepted: true,
      audit: {
        version: 1,
        accepted: true,
        evaluatedAt: new Date().toISOString(),
        rules,
        annotations: annotationsToRecord(attrs.annotations),
      },
    };
  }
}
```

In Task 4, validators will provide accurate rule types in their rejection errors. The accepted rule audit entries are intentionally minimal in this task and are made rule-specific by validators in Task 4.

- [ ] **Step 5: Export chain and errors**

Update `src/core/admission/index.ts`:

```ts
export * from "./types.js";
export * from "./normalize.js";
export * from "./errors.js";
export * from "./chain.js";
```

- [ ] **Step 6: Run chain tests green**

Run:

```bash
PATH="/Users/tafeng/.bun/bin:$PATH" bun test src/core/admission/chain.test.ts
```

Expected: `AdmissionChain` tests pass.

- [ ] **Step 7: Commit chain core**

Run:

```bash
git add src/core/admission src/core/operations/result.ts
git commit -m "feat: add admission chain core"
```

### Task 4: Local Validators

**Files:**
- Create: `src/core/admission/validators.ts`
- Create: `src/core/admission/validators.test.ts`
- Modify: `src/core/admission/index.ts`

- [ ] **Step 1: Write validator tests**

Create `src/core/admission/validators.test.ts`:

```ts
import { describe, expect, test } from "bun:test";

import { ContributionKind, ContributionMode, RelationType, type ContributionInput } from "../models.js";
import { makeInMemoryContributionStore } from "../operations/test-helpers.js";
import { AdmissionRejectError } from "./errors.js";
import { createAdmissionValidators } from "./validators.js";

function input(overrides: Partial<ContributionInput> = {}): ContributionInput {
  return {
    kind: ContributionKind.Work,
    mode: ContributionMode.Evaluation,
    summary: "work",
    artifacts: {},
    relations: [],
    tags: [],
    agent: { agentId: "agent-1", role: "coder" },
    createdAt: "2026-05-27T00:00:00.000Z",
    ...overrides,
  };
}

async function runValidator(rule: Parameters<typeof createAdmissionValidators>[0][number], object: ContributionInput, deps = {}) {
  const [validator] = createAdmissionValidators([rule]);
  if (validator === undefined) throw new Error("validator missing");
  const annotations = new Map<string, string>();
  await validator.validate({
    op: "contribute",
    object,
    annotations,
    deps,
  });
  return annotations;
}

describe("createAdmissionValidators", () => {
  test("artifact_required accepts present artifacts and rejects missing artifacts", async () => {
    await runValidator(
      { type: "artifact_required", name: "has_report", artifact: "report.json", source: "explicit" },
      input({ artifacts: { "report.json": "blake3:abc" } }),
    );

    await expect(
      runValidator(
        { type: "artifact_required", name: "has_report", artifact: "report.json", source: "explicit" },
        input(),
      ),
    ).rejects.toBeInstanceOf(AdmissionRejectError);
  });

  test("relation_required accepts present relation and rejects missing relation", async () => {
    await runValidator(
      {
        type: "relation_required",
        name: "has_parent",
        relationType: RelationType.DerivesFrom,
        source: "explicit",
      },
      input({
        relations: [{ targetCid: "blake3:parent", relationType: RelationType.DerivesFrom }],
      }),
    );

    await expect(
      runValidator(
        {
          type: "relation_required",
          name: "has_parent",
          relationType: RelationType.DerivesFrom,
          source: "explicit",
        },
        input(),
      ),
    ).rejects.toBeInstanceOf(AdmissionRejectError);
  });

  test("metric_check enforces minimum score", async () => {
    await runValidator(
      { type: "metric_check", name: "coverage", metric: "coverage", minValue: 0.8, source: "explicit" },
      input({ scores: { coverage: { value: 0.9, direction: "maximize" } } }),
    );

    await expect(
      runValidator(
        { type: "metric_check", name: "coverage", metric: "coverage", minValue: 0.8, source: "explicit" },
        input({ scores: { coverage: { value: 0.7, direction: "maximize" } } }),
      ),
    ).rejects.toBeInstanceOf(AdmissionRejectError);
  });

  test("shell validator uses HookRunner and records evidence", async () => {
    const annotations = await runValidator(
      { type: "shell", name: "lint", command: "bun run lint", onFail: "reject", source: "explicit" },
      input(),
      {
        hookCwd: "/tmp",
        hookRunner: {
          run: async () => ({
            success: true,
            exitCode: 0,
            stdout: "ok",
            stderr: "",
            command: "bun run lint",
            durationMs: 12,
          }),
        },
      },
    );

    expect(annotations.get("admission.shell.lint.exit_code")).toBe("0");
  });

  test("rebac_permission uses resolver and rejects denies", async () => {
    await expect(
      runValidator(
        {
          type: "rebac_permission",
          name: "can_review",
          permission: "review",
          objectType: "contribution",
          source: "explicit",
        },
        input(),
        {
          permissionResolver: {
            check: async () => ({ allowed: false, reason: "no grant" }),
          },
        },
      ),
    ).rejects.toBeInstanceOf(AdmissionRejectError);
  });

  test("governance_policy uses evaluator and rejects denies", async () => {
    await expect(
      runValidator(
        {
          type: "governance_policy",
          name: "fraud",
          policy: "fraud_score_below",
          maxScore: 0.5,
          source: "explicit",
        },
        input(),
        {
          governanceEvaluator: {
            evaluate: async () => ({ allowed: false, reason: "fraud score too high", evidence: { score: 0.9 } }),
          },
        },
      ),
    ).rejects.toBeInstanceOf(AdmissionRejectError);
  });
});
```

- [ ] **Step 2: Run validator tests to verify they fail**

Run:

```bash
PATH="/Users/tafeng/.bun/bin:$PATH" bun test src/core/admission/validators.test.ts
```

Expected: module resolution fails because `validators.ts` does not exist.

- [ ] **Step 3: Add validator factory and simple validators**

Create `src/core/admission/validators.ts`:

```ts
import { PolicyEnforcer } from "../policy-enforcer.js";
import type { Score } from "../models.js";
import { AdmissionRejectError } from "./errors.js";
import type { AdmissionValidator, NormalizedAdmissionRule } from "./types.js";
import { hookEntryFromShellRule } from "./types.js";

const MAX_EVIDENCE_TEXT = 4096;

function truncateText(value: string): string {
  return value.length <= MAX_EVIDENCE_TEXT ? value : value.slice(0, MAX_EVIDENCE_TEXT);
}

function reject(rule: NormalizedAdmissionRule, reason: string, evidence = {}): never {
  throw new AdmissionRejectError({
    ruleName: rule.name,
    ruleType: rule.type,
    reason,
    evidence,
  });
}

function scoreValue(score: Score | undefined): number | undefined {
  return score?.value;
}

export function createAdmissionValidators(
  rules: readonly NormalizedAdmissionRule[],
): readonly AdmissionValidator[] {
  return rules.map((rule): AdmissionValidator => ({
    name: rule.name,
    handles: (op) => op === "contribute",
    validate: async (attrs) => {
      switch (rule.type) {
        case "shell": {
          if (attrs.deps.hookRunner === undefined) {
            reject(rule, "hook runner is not configured");
          }
          if (attrs.deps.hookCwd === undefined) {
            reject(rule, "hook working directory is not configured");
          }
          const result = await attrs.deps.hookRunner.run(hookEntryFromShellRule(rule), attrs.deps.hookCwd);
          attrs.annotations.set(`admission.shell.${rule.name}.exit_code`, String(result.exitCode));
          attrs.annotations.set(`admission.shell.${rule.name}.duration_ms`, String(result.durationMs));
          if (!result.success && rule.onFail !== "warn") {
            reject(rule, "shell command failed", {
              command: result.command,
              exit_code: result.exitCode,
              stdout: truncateText(result.stdout),
              stderr: truncateText(result.stderr),
              stdout_truncated: result.stdout.length > MAX_EVIDENCE_TEXT,
              stderr_truncated: result.stderr.length > MAX_EVIDENCE_TEXT,
            });
          }
          return;
        }
        case "metric_check": {
          const value = scoreValue(attrs.object.scores?.[rule.metric]);
          if (value === undefined) {
            reject(rule, `missing metric '${rule.metric}'`, { metric: rule.metric });
          }
          if (rule.minValue !== undefined && value < rule.minValue) {
            reject(rule, `metric '${rule.metric}' is below minimum`, {
              metric: rule.metric,
              value,
              min_value: rule.minValue,
            });
          }
          if (rule.maxValue !== undefined && value > rule.maxValue) {
            reject(rule, `metric '${rule.metric}' is above maximum`, {
              metric: rule.metric,
              value,
              max_value: rule.maxValue,
            });
          }
          attrs.annotations.set(`admission.metric.${rule.name}.value`, String(value));
          return;
        }
        case "artifact_required": {
          if (attrs.object.artifacts[rule.artifact] === undefined) {
            reject(rule, `missing artifact '${rule.artifact}'`, {
              artifact: rule.artifact,
              present_artifacts: Object.keys(attrs.object.artifacts),
            });
          }
          return;
        }
        case "relation_required": {
          if (!attrs.object.relations.some((relation) => relation.relationType === rule.relationType)) {
            reject(rule, `missing relation '${rule.relationType}'`, {
              relation_type: rule.relationType,
              present_relation_types: attrs.object.relations.map((relation) => relation.relationType),
            });
          }
          return;
        }
        case "metric_improves": {
          if (attrs.contract === undefined || attrs.deps.contributionStore === undefined) {
            reject(rule, "metric_improves requires contract and contribution store");
          }
          const enforcer = new PolicyEnforcer(attrs.contract, attrs.deps.contributionStore);
          const result = await enforcer.enforce(
            {
              cid: "blake3:0000000000000000000000000000000000000000000000000000000000000000",
              manifestVersion: 1,
              ...attrs.object,
            },
            false,
          );
          const violation = result.violations.find(
            (item) => item.type === "gate_failed" && item.details.gate === "metric_improves",
          );
          if (violation !== undefined) {
            reject(rule, violation.message, violation.details);
          }
          return;
        }
        case "blueprint_hash": {
          if (attrs.deps.blueprintHashSource === undefined) {
            reject(rule, "blueprint hash source is not configured");
          }
          const observedHash = await attrs.deps.blueprintHashSource.hash(rule.blueprint);
          if (observedHash === undefined) {
            reject(rule, "blueprint not found", { blueprint: rule.blueprint });
          }
          const expectedHash =
            rule.expectedHash ??
            (typeof attrs.object.context?.blueprint_hash === "string"
              ? attrs.object.context.blueprint_hash
              : undefined);
          if (expectedHash === undefined) {
            reject(rule, "expected blueprint hash is missing", { blueprint: rule.blueprint });
          }
          if (observedHash !== expectedHash) {
            reject(rule, "blueprint hash mismatch", {
              blueprint: rule.blueprint,
              observed_hash: observedHash,
              expected_hash: expectedHash,
            });
          }
          return;
        }
        case "artifact_signature": {
          if (attrs.deps.artifactSignatureVerifier === undefined) {
            reject(rule, "artifact signature verifier is not configured");
          }
          const result = await attrs.deps.artifactSignatureVerifier.verify({
            artifactName: rule.artifact,
            artifactHashes: attrs.object.artifacts,
            context: attrs.object.context,
            requireSignerIn: rule.requireSignerIn,
          });
          if (!result.accepted) {
            reject(rule, result.reason ?? "artifact signature rejected", result.evidence ?? {});
          }
          return;
        }
        case "rebac_permission": {
          if (attrs.deps.permissionResolver === undefined) {
            reject(rule, "permission resolver is not configured");
          }
          const objectId =
            rule.objectIdContextKey !== undefined &&
            typeof attrs.object.context?.[rule.objectIdContextKey] === "string"
              ? attrs.object.context[rule.objectIdContextKey]
              : attrs.object.summary;
          const decision = await attrs.deps.permissionResolver.check({
            subjectType: "agent",
            subjectId: attrs.object.agent.agentId,
            permission: rule.permission,
            objectType: rule.objectType,
            objectId,
            zoneId: attrs.deps.zoneId,
          });
          if (!decision.allowed) {
            reject(rule, decision.reason ?? "permission denied", decision.evidence ?? {});
          }
          return;
        }
        case "governance_policy": {
          if (attrs.deps.governanceEvaluator === undefined) {
            reject(rule, "governance evaluator is not configured");
          }
          const decision = await attrs.deps.governanceEvaluator.evaluate({
            policy: rule.policy,
            agentId: attrs.object.agent.agentId,
            zoneId: attrs.deps.zoneId,
            contribution: attrs.object,
            maxScore: rule.maxScore,
          });
          if (!decision.allowed) {
            reject(rule, decision.reason ?? "governance policy denied", decision.evidence ?? {});
          }
          return;
        }
      }
    },
  }));
}
```

- [ ] **Step 4: Export validators**

Update `src/core/admission/index.ts`:

```ts
export * from "./types.js";
export * from "./normalize.js";
export * from "./errors.js";
export * from "./chain.js";
export * from "./validators.js";
```

- [ ] **Step 5: Run validator tests green**

Run:

```bash
PATH="/Users/tafeng/.bun/bin:$PATH" bun test src/core/admission/validators.test.ts
```

Expected: validator tests pass.

- [ ] **Step 6: Commit validators**

Run:

```bash
git add src/core/admission
git commit -m "feat: add admission validators"
```

### Task 5: Wire Admission Into Contribute Operation

**Files:**
- Modify: `src/core/operations/deps.ts`
- Modify: `src/core/operations/contribute.ts`
- Modify: `src/core/operations/contribute.test.ts`

- [ ] **Step 1: Write contribution operation tests**

Add these tests in `src/core/operations/contribute.test.ts` near the existing policy/idempotency tests:

```ts
test("attaches admission audit metadata before computing CID", async () => {
  const { deps, cleanup } = await createTestOperationDeps();
  try {
    const result = await contributeOperation(
      {
        kind: ContributionKind.Work,
        summary: "audited work",
        scores: { coverage: { value: 0.9, direction: "maximize" } },
        agent: { agentId: "agent-1" },
      },
      {
        ...deps,
        contract: {
          contractVersion: 3,
          name: "admission",
          metrics: { coverage: { direction: "maximize" } },
          admission: [
            {
              type: "metric_check",
              name: "coverage_floor",
              metric: "coverage",
              minValue: 0.8,
            },
          ],
        },
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const stored = await deps.contributionStore.get(result.value.cid);
    expect(stored?.context?.admission).toBeDefined();
    expect(stored?.context?.admission).toMatchObject({
      version: 1,
      accepted: true,
    });
  } finally {
    await cleanup();
  }
});

test("admission rejection prevents storing contribution and releases idempotency key", async () => {
  const { deps, cleanup } = await createTestOperationDeps();
  try {
    const contract = {
      contractVersion: 3,
      name: "admission",
      metrics: { coverage: { direction: "maximize" } },
      admission: [
        {
          type: "metric_check" as const,
          name: "coverage_floor",
          metric: "coverage",
          minValue: 0.8,
        },
      ],
    };

    const rejected = await contributeOperation(
      {
        kind: ContributionKind.Work,
        summary: "bad work",
        scores: { coverage: { value: 0.3, direction: "maximize" } },
        agent: { agentId: "agent-1" },
        idempotencyKey: "retry-key",
      },
      { ...deps, contract },
    );

    expect(rejected.ok).toBe(false);
    expect(await deps.contributionStore.count()).toBe(0);

    const accepted = await contributeOperation(
      {
        kind: ContributionKind.Work,
        summary: "bad work",
        scores: { coverage: { value: 0.9, direction: "maximize" } },
        agent: { agentId: "agent-1" },
        idempotencyKey: "retry-key",
      },
      { ...deps, contract },
    );

    expect(accepted.ok).toBe(true);
    expect(await deps.contributionStore.count()).toBe(1);
  } finally {
    await cleanup();
  }
});
```

- [ ] **Step 2: Run contribution tests to verify they fail**

Run:

```bash
PATH="/Users/tafeng/.bun/bin:$PATH" bun test src/core/operations/contribute.test.ts
```

Expected: new tests fail because admission is not wired into `contributeOperation`.

- [ ] **Step 3: Add admission deps to `OperationDeps`**

In `src/core/operations/deps.ts`, import:

```ts
import type {
  AdmissionGovernanceEvaluator,
  AdmissionPermissionResolver,
  ArtifactSignatureVerifier,
  BlueprintHashSource,
} from "../admission/types.js";
```

Add fields to `OperationDeps`:

```ts
readonly admissionPermissionResolver?: AdmissionPermissionResolver | undefined;
readonly admissionGovernanceEvaluator?: AdmissionGovernanceEvaluator | undefined;
readonly blueprintHashSource?: BlueprintHashSource | undefined;
readonly artifactSignatureVerifier?: ArtifactSignatureVerifier | undefined;
readonly zoneId?: string | undefined;
```

Update `createTestOperationDeps()` in `src/core/operations/test-helpers.ts` with
these new entries in the `deps` object:

```ts
admissionPermissionResolver: undefined as unknown as NonNullable<
  OperationDeps["admissionPermissionResolver"]
>,
admissionGovernanceEvaluator: undefined as unknown as NonNullable<
  OperationDeps["admissionGovernanceEvaluator"]
>,
blueprintHashSource: undefined as unknown as NonNullable<OperationDeps["blueprintHashSource"]>,
artifactSignatureVerifier: undefined as unknown as NonNullable<
  OperationDeps["artifactSignatureVerifier"]
>,
zoneId: undefined as unknown as string,
```

- [ ] **Step 4: Run admission before contribution creation**

In `src/core/operations/contribute.ts`, import:

```ts
import { AdmissionChain, AdmissionOp, createAdmissionValidators, normalizeAdmissionRules } from "../admission/index.js";
```

After the `unsignedContributionInput` object is created, add:

```ts
let admittedContributionInput = unsignedContributionInput;
let admissionAudit: import("../admission/index.js").AdmissionAudit | undefined;
const admissionRules = normalizeAdmissionRules(deps.contract);
if (admissionRules.length > 0) {
  const annotations = new Map<string, string>();
  const chain = new AdmissionChain({
    mutators: [],
    validators: createAdmissionValidators(admissionRules),
  });
  const attrs = {
    op: AdmissionOp.Contribute,
    object: admittedContributionInput,
    originalObject: unsignedContributionInput,
    contract: deps.contract,
    annotations,
    deps: {
      contributionStore: deps.contributionStore,
      hookRunner: deps.hookRunner,
      hookCwd: deps.hookCwd,
      permissionResolver: deps.admissionPermissionResolver,
      governanceEvaluator: deps.admissionGovernanceEvaluator,
      blueprintHashSource: deps.blueprintHashSource,
      artifactSignatureVerifier: deps.artifactSignatureVerifier,
      zoneId: deps.zoneId ?? deps.namespace,
    },
  };
  const admissionResult = await chain.admit(attrs);
  admissionAudit = admissionResult.audit;
  admittedContributionInput = attrs.object;
}
```

Then replace:

```ts
const contributionInput = withRuntimeRoutingSignature(unsignedContributionInput);
```

with:

```ts
const contributionContext =
  admissionAudit === undefined
    ? admittedContributionInput.context
    : {
        ...(admittedContributionInput.context ?? {}),
        admission: admissionAudit as unknown as JsonValue,
      };
const contributionInput = withRuntimeRoutingSignature({
  ...admittedContributionInput,
  ...(contributionContext !== undefined ? { context: contributionContext } : {}),
});
```

- [ ] **Step 5: Avoid duplicate legacy gate enforcement**

In the `PolicyEnforcer` block, skip the old policy enforcer whenever the new
admission path has rules. This prevents legacy `gates:` from rejecting twice
after they have been normalized into admission validators.

```ts
const hasAdmissionRules = admissionRules.length > 0;
if (
  deps.contract !== undefined &&
  deps.contributionStore !== undefined &&
  !hasAdmissionRules
) {
  enforcer = new PolicyEnforcer(deps.contract, deps.contributionStore, deps.outcomeStore);
```

Keep the existing body of the policy-enforcer block below this guard. Its first
line is still the `enforcer = new PolicyEnforcer(deps.contract, deps.contributionStore, deps.outcomeStore)` assignment shown above.

Then preserve post-write stop-condition evaluation with:

```ts
if (policyResult === undefined && deps.contract !== undefined) {
  policyResult = { passed: true, violations: [] };
}
```

This first implementation prioritizes avoiding duplicate rejections while still
allowing the existing post-write stop-condition path to run for
admission-enabled contracts.

- [ ] **Step 6: Make admission rejections release idempotency reservations**

In the outer `catch` path in `contributeOperation`, verify it already calls `idempotencySlot?.release()` and `rollbackOwnedDurableReservation()`. If `AdmissionRejectError` is caught by the generic `fromGroveError()` path, no special catch is needed. Add this focused assertion to the new idempotency test if it is not already covered:

```ts
expect(accepted.ok).toBe(true);
```

The second call using the same idempotency key proves the rejected call did not leave a durable pending reservation.

- [ ] **Step 7: Run contribution tests green**

Run:

```bash
PATH="/Users/tafeng/.bun/bin:$PATH" bun test src/core/operations/contribute.test.ts
```

Expected: contribution tests pass.

- [ ] **Step 8: Commit operation wiring**

Run:

```bash
git add src/core/operations/deps.ts src/core/operations/test-helpers.ts src/core/operations/contribute.ts src/core/operations/contribute.test.ts
git commit -m "feat: run admission before contribution writes"
```

### Task 6: Nexus ReBAC and Governance Adapters

**Files:**
- Create: `src/nexus/nexus-rpc-client.ts`
- Create: `src/nexus/nexus-admission-adapters.ts`
- Create: `src/nexus/nexus-admission-adapters.test.ts`
- Modify: `src/nexus/index.ts`

- [ ] **Step 1: Write Nexus adapter tests**

Create `src/nexus/nexus-admission-adapters.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test";

import { ContributionKind, ContributionMode } from "../core/models.js";
import { NexusAdmissionGovernanceEvaluator, NexusAdmissionPermissionResolver } from "./nexus-admission-adapters.js";
import { NexusRpcClient } from "./nexus-rpc-client.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch(result: unknown, status = 200): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
      status,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
}

describe("NexusAdmissionPermissionResolver", () => {
  test("maps allowed rebac_check result", async () => {
    mockFetch(true);
    const resolver = new NexusAdmissionPermissionResolver(
      new NexusRpcClient({ url: "http://nexus.test", apiKey: "key" }),
    );

    const decision = await resolver.check({
      subjectType: "agent",
      subjectId: "agent-1",
      permission: "review",
      objectType: "contribution",
      objectId: "cid-1",
      zoneId: "zone-1",
    });

    expect(decision).toEqual({
      allowed: true,
      evidence: { backend: "nexus", method: "rebac_check" },
    });
  });

  test("maps denied rebac_check result", async () => {
    mockFetch(false);
    const resolver = new NexusAdmissionPermissionResolver(
      new NexusRpcClient({ url: "http://nexus.test", apiKey: "key" }),
    );

    const decision = await resolver.check({
      subjectType: "agent",
      subjectId: "agent-1",
      permission: "review",
      objectType: "contribution",
      objectId: "cid-1",
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("Nexus ReBAC denied permission");
  });
});

describe("NexusAdmissionGovernanceEvaluator", () => {
  test("accepts clean governance status", async () => {
    mockFetch({ recent_alerts: { alerts: [], count: 0 }, fraud_rings: { rings: [], count: 0 } });
    const evaluator = new NexusAdmissionGovernanceEvaluator(
      new NexusRpcClient({ url: "http://nexus.test", apiKey: "key" }),
    );

    const decision = await evaluator.evaluate({
      policy: "governance_status_clean",
      agentId: "agent-1",
      contribution: {
        kind: ContributionKind.Work,
        mode: ContributionMode.Evaluation,
        summary: "work",
        artifacts: {},
        relations: [],
        tags: [],
        agent: { agentId: "agent-1" },
        createdAt: "2026-05-27T00:00:00.000Z",
      },
    });

    expect(decision.allowed).toBe(true);
  });

  test("rejects governance status with alerts", async () => {
    mockFetch({
      recent_alerts: { alerts: [{ agent_id: "agent-1", severity: "high" }], count: 1 },
      fraud_rings: { rings: [], count: 0 },
    });
    const evaluator = new NexusAdmissionGovernanceEvaluator(
      new NexusRpcClient({ url: "http://nexus.test", apiKey: "key" }),
    );

    const decision = await evaluator.evaluate({
      policy: "governance_status_clean",
      agentId: "agent-1",
      contribution: {
        kind: ContributionKind.Work,
        mode: ContributionMode.Evaluation,
        summary: "work",
        artifacts: {},
        relations: [],
        tags: [],
        agent: { agentId: "agent-1" },
        createdAt: "2026-05-27T00:00:00.000Z",
      },
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("Nexus governance status is not clean");
  });
});
```

- [ ] **Step 2: Run Nexus adapter tests to verify they fail**

Run:

```bash
PATH="/Users/tafeng/.bun/bin:$PATH" bun test src/nexus/nexus-admission-adapters.test.ts
```

Expected: module resolution fails because the Nexus admission client/adapters do not exist.

- [ ] **Step 3: Add minimal Nexus RPC client**

Create `src/nexus/nexus-rpc-client.ts`:

```ts
import { z } from "zod";

export interface NexusRpcClientConfig {
  readonly url: string;
  readonly apiKey?: string | undefined;
  readonly timeoutMs?: number | undefined;
}

const RpcEnvelopeSchema = z.object({
  jsonrpc: z.string().optional(),
  id: z.union([z.string(), z.number()]).optional(),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
});

export class NexusRpcClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;

  constructor(config: NexusRpcClientConfig) {
    this.baseUrl = config.url.replace(/\/+$/, "");
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs ?? 30_000;
  }

  async call<T>(method: string, params: Readonly<Record<string, unknown>>, schema: z.ZodType<T>): Promise<T> {
    const response = await fetch(`${this.baseUrl}/api/nfs/${encodeURIComponent(method)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.apiKey !== undefined ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`Nexus RPC ${method} failed: HTTP ${response.status}`);
    }

    const envelope = RpcEnvelopeSchema.parse(await response.json());
    if (envelope.error !== undefined) {
      throw new Error(`Nexus RPC ${method} failed: ${JSON.stringify(envelope.error)}`);
    }
    return schema.parse(envelope.result);
  }
}
```

- [ ] **Step 4: Add Nexus admission adapters**

Create `src/nexus/nexus-admission-adapters.ts`:

```ts
import { z } from "zod";

import type {
  AdmissionGovernanceCheck,
  AdmissionGovernanceDecision,
  AdmissionGovernanceEvaluator,
  AdmissionPermissionCheck,
  AdmissionPermissionDecision,
  AdmissionPermissionResolver,
} from "../core/admission/types.js";
import type { NexusRpcClient } from "./nexus-rpc-client.js";

const GovernanceStatusSchema = z
  .object({
    recent_alerts: z.object({
      alerts: z.array(z.unknown()),
      count: z.number(),
    }),
    fraud_rings: z.object({
      rings: z.array(z.unknown()),
      count: z.number(),
    }),
  })
  .passthrough();

export class NexusAdmissionPermissionResolver implements AdmissionPermissionResolver {
  constructor(private readonly client: NexusRpcClient) {}

  async check(input: AdmissionPermissionCheck): Promise<AdmissionPermissionDecision> {
    const allowed = await this.client.call(
      "rebac_check",
      {
        subject: [input.subjectType, input.subjectId],
        permission: input.permission,
        object: [input.objectType, input.objectId],
        zone_id: input.zoneId,
      },
      z.boolean(),
    );

    if (!allowed) {
      return {
        allowed: false,
        reason: "Nexus ReBAC denied permission",
        evidence: { backend: "nexus", method: "rebac_check" },
      };
    }
    return {
      allowed: true,
      evidence: { backend: "nexus", method: "rebac_check" },
    };
  }
}

export class NexusAdmissionGovernanceEvaluator implements AdmissionGovernanceEvaluator {
  constructor(private readonly client: NexusRpcClient) {}

  async evaluate(input: AdmissionGovernanceCheck): Promise<AdmissionGovernanceDecision> {
    if (input.policy !== "governance_status_clean") {
      return {
        allowed: false,
        reason: `Nexus governance policy '${input.policy}' is not supported by the current RPC surface`,
        evidence: { backend: "nexus", method: "governance_status" },
      };
    }

    const status = await this.client.call("governance_status", {}, GovernanceStatusSchema);
    const alertCount = status.recent_alerts.count;
    const ringCount = status.fraud_rings.count;
    const allowed = alertCount === 0 && ringCount === 0;
    return {
      allowed,
      ...(allowed ? {} : { reason: "Nexus governance status is not clean" }),
      evidence: {
        backend: "nexus",
        method: "governance_status",
        alert_count: alertCount,
        ring_count: ringCount,
      },
    };
  }
}
```

- [ ] **Step 5: Export Nexus adapter classes**

Update `src/nexus/index.ts`:

```ts
export * from "./nexus-rpc-client.js";
export * from "./nexus-admission-adapters.js";
```

Keep existing exports in the file and append these lines.

- [ ] **Step 6: Run Nexus adapter tests green**

Run:

```bash
PATH="/Users/tafeng/.bun/bin:$PATH" bun test src/nexus/nexus-admission-adapters.test.ts
```

Expected: Nexus adapter tests pass.

- [ ] **Step 7: Commit Nexus adapters**

Run:

```bash
git add src/nexus/nexus-rpc-client.ts src/nexus/nexus-admission-adapters.ts src/nexus/nexus-admission-adapters.test.ts src/nexus/index.ts
git commit -m "feat: add Nexus admission adapters"
```

### Task 7: Runtime Wiring and Documentation

**Files:**
- Modify: `src/local/runtime.ts`
- Modify: `src/server/operation-adapter.ts`
- Modify: `src/mcp/operation-adapter.ts`
- Modify: `src/cli/operation-adapter.ts`
- Modify: `spec/GROVE-CONTRACT.md`
- Modify: `spec/schemas/grove-contract.json`
- Modify: `spec/schemas/grove-contract.test.ts`
- Modify: `GROVE.md`
- Modify: `README.md`

- [ ] **Step 1: Add schema tests for `admission`**

In `spec/schemas/grove-contract.test.ts`, add a test that validates this object against `spec/schemas/grove-contract.json`:

```ts
test("schema accepts admission rules", () => {
  const contract = {
    contract_version: 3,
    name: "schema-admission",
    metrics: {
      coverage: { direction: "maximize" },
    },
    admission: [
      {
        type: "metric_check",
        name: "coverage_floor",
        metric: "coverage",
        min_value: 0.8,
      },
      {
        type: "rebac_permission",
        name: "can_contribute",
        permission: "contribute",
        object_type: "session",
      },
    ],
  };

  expect(validate(contract)).toBe(true);
});
```

Use the existing test file's `validate` helper name. If the helper has a different local name, use that exact helper instead of adding a new validator.

- [ ] **Step 2: Run schema tests to verify they fail**

Run:

```bash
PATH="/Users/tafeng/.bun/bin:$PATH" bun test spec/schemas/grove-contract.test.ts
```

Expected: schema test fails because the JSON schema does not accept `admission`.

- [ ] **Step 3: Update JSON schema**

In `spec/schemas/grove-contract.json`, add an `admission` property to v2/v3 definitions matching the TypeScript schema:

```json
"admission": {
  "type": "array",
  "maxItems": 50,
  "items": { "$ref": "#/$defs/admissionRule" }
}
```

Add this `$defs.admissionRule` entry:

```json
"admissionRule": {
  "oneOf": [
    {
      "type": "object",
      "required": ["type", "name", "command"],
      "additionalProperties": false,
      "properties": {
        "type": { "const": "shell" },
        "name": { "type": "string", "pattern": "^[a-z][a-z0-9_-]*$", "maxLength": 128 },
        "command": { "type": "string", "minLength": 1, "maxLength": 4096 },
        "timeout": { "type": "integer", "minimum": 1 },
        "on_fail": { "enum": ["reject", "warn"] }
      }
    },
    {
      "type": "object",
      "required": ["type", "name", "metric"],
      "additionalProperties": false,
      "anyOf": [{ "required": ["min_value"] }, { "required": ["max_value"] }],
      "properties": {
        "type": { "const": "metric_check" },
        "name": { "type": "string", "pattern": "^[a-z][a-z0-9_-]*$", "maxLength": 128 },
        "metric": { "type": "string", "pattern": "^[a-z][a-z0-9_]*$", "maxLength": 64 },
        "direction": { "enum": ["minimize", "maximize"] },
        "min_value": { "type": "number" },
        "max_value": { "type": "number" }
      }
    },
    {
      "type": "object",
      "required": ["type", "name", "artifact"],
      "additionalProperties": false,
      "properties": {
        "type": { "const": "artifact_required" },
        "name": { "type": "string", "pattern": "^[a-z][a-z0-9_-]*$", "maxLength": 128 },
        "artifact": { "type": "string", "minLength": 1, "maxLength": 256 }
      }
    },
    {
      "type": "object",
      "required": ["type", "name", "relation_type"],
      "additionalProperties": false,
      "properties": {
        "type": { "const": "relation_required" },
        "name": { "type": "string", "pattern": "^[a-z][a-z0-9_-]*$", "maxLength": 128 },
        "relation_type": {
          "enum": ["derives_from", "responds_to", "reviews", "reproduces", "adopts"]
        }
      }
    },
    {
      "type": "object",
      "required": ["type", "name", "blueprint"],
      "additionalProperties": false,
      "properties": {
        "type": { "const": "blueprint_hash" },
        "name": { "type": "string", "pattern": "^[a-z][a-z0-9_-]*$", "maxLength": 128 },
        "blueprint": { "type": "string", "minLength": 1, "maxLength": 1024 },
        "expected_hash": { "type": "string", "minLength": 1, "maxLength": 256 },
        "on_mismatch": { "const": "reject" }
      }
    },
    {
      "type": "object",
      "required": ["type", "name", "require_signer_in"],
      "additionalProperties": false,
      "properties": {
        "type": { "const": "artifact_signature" },
        "name": { "type": "string", "pattern": "^[a-z][a-z0-9_-]*$", "maxLength": 128 },
        "artifact": { "type": "string", "minLength": 1, "maxLength": 256 },
        "require_signer_in": {
          "type": "array",
          "minItems": 1,
          "maxItems": 20,
          "items": { "type": "string", "minLength": 1, "maxLength": 1024 }
        }
      }
    },
    {
      "type": "object",
      "required": ["type", "name", "permission", "object_type"],
      "additionalProperties": false,
      "properties": {
        "type": { "const": "rebac_permission" },
        "name": { "type": "string", "pattern": "^[a-z][a-z0-9_-]*$", "maxLength": 128 },
        "permission": { "type": "string", "minLength": 1, "maxLength": 128 },
        "object_type": { "type": "string", "minLength": 1, "maxLength": 128 },
        "object_id_context_key": { "type": "string", "minLength": 1, "maxLength": 128 }
      }
    },
    {
      "type": "object",
      "required": ["type", "name", "policy"],
      "additionalProperties": false,
      "properties": {
        "type": { "const": "governance_policy" },
        "name": { "type": "string", "pattern": "^[a-z][a-z0-9_-]*$", "maxLength": 128 },
        "policy": {
          "enum": ["constraint_check", "fraud_score_below", "governance_status_clean"]
        },
        "max_score": { "type": "number", "minimum": 0, "maximum": 1 }
      }
    }
  ]
}
```

- [ ] **Step 4: Wire adapters through operation deps**

In each operation adapter that builds `OperationDeps`, pass:

```ts
admissionPermissionResolver: deps.admissionPermissionResolver,
admissionGovernanceEvaluator: deps.admissionGovernanceEvaluator,
blueprintHashSource: deps.blueprintHashSource,
artifactSignatureVerifier: deps.artifactSignatureVerifier,
zoneId: deps.namespace,
```

Use the local dependency container names in each file. For local mode, these values can be `undefined`; admission rules that require them fail closed only when configured.

- [ ] **Step 5: Document `admission:` in contract docs and examples**

In `spec/GROVE-CONTRACT.md`, add a section:

```markdown
## Admission

`admission:` defines pre-contribution admission rules. Grove runs mutators first
and validators second. Validators inspect the final post-mutation contribution
input and reject before the contribution is stored.

Legacy `hooks.before_contribute` and `gates:` are normalized into admission
validators for compatibility. New contracts should prefer explicit
`admission:` rules for ordering and audit clarity.
```

In `GROVE.md`, replace the commented `hooks.before_contribute` example with:

```yaml
# Admission — pre-contribution validation chain.
#
# admission:
#   - type: shell
#     name: test
#     command: "bun test"
#     on_fail: reject
#   - type: metric_check
#     name: coverage_floor
#     metric: coverage
#     direction: maximize
#     min_value: 0.8
```

In `README.md`, update the configuration bullet list so it mentions:

```markdown
- Admission rules for pre-contribution validation and audit evidence
```

- [ ] **Step 6: Run schema and parser tests green**

Run:

```bash
PATH="/Users/tafeng/.bun/bin:$PATH" bun test spec/schemas/grove-contract.test.ts src/core/contract.test.ts
```

Expected: schema and parser tests pass.

- [ ] **Step 7: Commit wiring and docs**

Run:

```bash
git add src/local/runtime.ts src/server/operation-adapter.ts src/mcp/operation-adapter.ts src/cli/operation-adapter.ts spec/GROVE-CONTRACT.md spec/schemas/grove-contract.json spec/schemas/grove-contract.test.ts GROVE.md README.md
git commit -m "docs: document admission contract"
```

### Task 8: Full Verification

**Files:**
- Modify: no source files

- [ ] **Step 1: Run focused admission and contribution tests**

Run:

```bash
PATH="/Users/tafeng/.bun/bin:$PATH" bun test src/core/admission src/core/contract.test.ts src/core/operations/contribute.test.ts src/nexus/nexus-admission-adapters.test.ts spec/schemas/grove-contract.test.ts
```

Expected: all focused tests pass.

- [ ] **Step 2: Run typecheck**

Run:

```bash
PATH="/Users/tafeng/.bun/bin:$PATH" bun run typecheck
```

Expected: TypeScript exits 0.

- [ ] **Step 3: Run Biome check**

Run:

```bash
PATH="/Users/tafeng/.bun/bin:$PATH" bun run check
```

Expected: Biome exits 0.

- [ ] **Step 4: Run full test suite if focused checks pass**

Run:

```bash
PATH="/Users/tafeng/.bun/bin:$PATH" bun test
```

Expected: full suite exits 0. If the full suite fails outside touched admission/contract/contribute/Nexus-adapter paths, capture the failing test names and decide whether the failure is related before changing unrelated code.

- [ ] **Step 5: Inspect final diff**

Run:

```bash
git status --short
git diff --stat
git diff --check
```

Expected: only planned files are modified and `git diff --check` exits 0.

- [ ] **Step 6: Final commit**

Run:

```bash
git add src/core src/nexus spec GROVE.md README.md
git commit -m "feat: add unified admission chain"
```

If all changes were already committed in prior tasks, this command should report no changes; keep the per-task commits as the final history.
