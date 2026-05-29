# Unified Admission Chain - Design

- **Issue**: [#269](https://github.com/windoliver/grove/issues/269)
- **Date**: 2026-05-27
- **Status**: Approved by user

## Goal

Add a first-class admission chain that runs before a contribution is accepted.
The chain unifies legacy `hooks.before_contribute`, declarative `gates:`, and
new policy integrations behind one auditable pre-write contract. It follows the
Kubernetes admission shape: mutators run first, validators run second against
the final post-mutation object, and validators fail fast on rejection.

Full scope includes a Grove-native admission core plus optional Nexus-backed
adapters for governance and ReBAC permission checks.

## Non-goals

- Replacing post-acceptance stop conditions, frontier ranking, reviewer loops,
  or outcome derivation.
- Embedding Nexus Python bricks directly into Grove core.
- Introducing OPA/Rego or a general dynamic policy language.
- Removing `gates:` or `hooks.before_contribute` compatibility in the first
  implementation.
- Implementing a complete artifact signing key-management system beyond the
  admission rule interface and local verification hook.

## Context

Today, contribution acceptance spans separate surfaces:

- `src/core/contract.ts` parses `gates:` and `hooks:`.
- `src/core/policy-enforcer.ts` evaluates gates and related policy checks.
- `src/core/hooks.ts` and `src/local/hook-runner.ts` define shell hook
  execution.
- `src/core/operations/contribute.ts` is the single contribution write path.

The current model has two gaps. First, `hooks.before_contribute` and `gates:`
are not represented as one ordered admission pipeline with a standard result
shape. Second, policy-side integrations such as blueprint hash verification,
artifact signatures, ReBAC authorization, and governance rules have no common
pre-write attachment point.

Issue comments add one critical constraint: mutators and validators must remain
separate passes. Validators must see the final object after all mutations.

## Approach

Create a new `src/core/admission/` module with a small protocol boundary:

```ts
export const AdmissionOp = {
  Contribute: "contribute",
} as const;

export interface AdmissionAttributes {
  readonly op: AdmissionOp;
  readonly object: ContributionInput;
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
```

`AdmissionChain` receives ordered mutators and validators. It runs:

```text
mutators.filter(handles).reduce(attrs)
validators.filter(handles).reduce(attrs)
```

Validators reject by throwing `AdmissionRejectError`. The chain converts success
or rejection into a stable `AdmissionResult` for operation responses and audit
metadata.

`AdmissionAttributes.object` is mutable only inside the chain. Before the
contribution CID is computed, `contributeOperation` copies the final object and
adds the admission audit block under `context.admission`. This makes admission
evidence part of the immutable contribution identity.

## Contract Shape

Add an optional `admission:` section to GROVE.md contracts:

```yaml
admission:
  - type: shell
    name: lint
    command: "bun run lint"
    timeout: 300000
    on_fail: reject
  - type: metric_check
    name: coverage_floor
    metric: coverage
    direction: maximize
    min_value: 0.8
  - type: artifact_signature
    name: signed_report
    require_signer_in: [".grove/allowed-signers"]
  - type: blueprint_hash
    name: coder_blueprint
    blueprint: ./blueprints/coder.yaml
    on_mismatch: reject
  - type: rebac_permission
    name: reviewer_can_review
    permission: review
    object_type: contribution
  - type: governance_policy
    name: no_blocked_agent_pair
    policy: constraint_check
```

`name` is required and must be unique within the admission list. A stable name
is needed for annotations and audit evidence.

Legacy fields are normalized into this same plan:

- `hooks.before_contribute` becomes a validator rule:
  `type: shell`, `name: before_contribute`, `on_fail: reject`.
- `gates:` become validator rules preserving their current semantics:
  `metric_improves`, `has_artifact`, `has_relation`, `min_score`.

For compatibility, both legacy and new sections may be present. The normalized
order is:

1. Explicit `admission:` rules in declared order.
2. Legacy `hooks.before_contribute`, if configured and not already represented.
3. Legacy `gates:`, if configured and not already represented.

This order lets a new contract opt into precise ordering without breaking
existing GROVE.md files.

## Rule Types

### Shell

`shell` is validator-only for v1. It uses `HookRunner` and the existing hook
execution trust model: GROVE.md is a repo-owned trusted file, similar to GitHub
Actions workflow configuration.

On success it records command, exit code, and duration in annotations. On
failure with `on_fail: reject`, it rejects with bounded stdout/stderr evidence.

### Metric Checks

`metric_check` validates a named metric on the contribution. It supports
`min_value`, `max_value`, and explicit `direction` for messages and future
policy projection.

`metric_improves` remains store-aware and compares the candidate contribution
to the current best stored score using the existing `PolicyEnforcer` logic
during migration.

### Artifact and Relation Requirements

`artifact_required` and `relation_required` preserve `has_artifact` and
`has_relation` behavior. They run after mutation so validators inspect the
final artifact and relation sets.

### Blueprint Hash

`blueprint_hash` validates that the contributing role's blueprint matches the
expected file hash. It reads the configured blueprint path through a dedicated
adapter so tests can provide an in-memory source and Nexus mode can provide a
backend-specific source later.

The first implementation records:

- configured blueprint path
- expected hash if supplied
- observed hash
- mismatch result

If no expected hash is supplied, the rule can verify against a contribution
context field such as `context.blueprint_hash`. A missing expected value is a
configuration error when `on_mismatch: reject`.

### Artifact Signature

`artifact_signature` validates signer metadata for named artifacts. The core
rule depends on an `ArtifactSignatureVerifier` interface:

```ts
export interface ArtifactSignatureVerifier {
  verify(input: ArtifactSignatureVerificationInput): Promise<ArtifactSignatureVerificationResult>;
}
```

Local mode can start with a deterministic verifier that reads an allowed signer
file and checks contribution context/signature metadata. Nexus mode can later
bind the same interface to a richer artifact ownership or signing service.

### ReBAC Permission

`rebac_permission` validates that the contributing principal is allowed to
perform an operation on the target object. Grove core defines a TypeScript
interface instead of importing Nexus Python code:

```ts
export interface AdmissionPermissionResolver {
  check(input: AdmissionPermissionCheck): Promise<AdmissionPermissionDecision>;
}
```

The Nexus adapter maps the check to Nexus ReBAC concepts:

- subject: `agent`, `user`, or delegated agent identity from the contribution
- permission: contract rule permission such as `review`, `contribute`, `adopt`
- object: contribution, session, workspace, file, or grove zone object
- zone: Grove namespace/session zone

The adapter is fail-closed by default. If Nexus ReBAC is configured but the
check errors, the validator rejects and records the error class in evidence.

### Governance Policy

`governance_policy` validates higher-level governance decisions, such as
blocked agent pairs, approval-required constraints, anomaly thresholds, or
collusion/fraud scores. Grove core defines:

```ts
export interface AdmissionGovernanceEvaluator {
  evaluate(input: AdmissionGovernanceCheck): Promise<AdmissionGovernanceDecision>;
}
```

The Nexus adapter maps to the existing governance brick surfaces:

- `GovernanceGraphService.check_constraint()` for block or approval-required
  relationships between agents.
- `AnomalyService.analyze_transaction()` when a contribution carries payment,
  bounty, or credit-like metadata.
- `CollusionService.compute_fraud_scores()` for fraud score thresholds.
- Approval state-machine concepts for future pending/manual workflows.

V1 admission remains synchronous: rules return accept or reject before write.
If a governance policy requires manual approval, the initial Grove behavior is
reject with a structured reason such as `approval_required`. A future issue can
add pending contribution admission once Grove has a durable pending queue.

## Audit Metadata

Accepted contributions receive a JSON-safe audit block in context:

```json
{
  "admission": {
    "version": 1,
    "accepted": true,
    "evaluated_at": "2026-05-27T00:00:00.000Z",
    "rules": [
      {
        "name": "lint",
        "type": "shell",
        "accepted": true,
        "evidence": {
          "exit_code": 0,
          "duration_ms": 1842
        }
      }
    ],
    "annotations": {
      "admission.shell.lint.command": "bun run lint"
    }
  }
}
```

Rejected contributions are not stored. Their operation result includes the
same rule name, type, reason, and bounded evidence so CLI, MCP, and HTTP
callers get a uniform rejection surface.

Admission metadata must avoid raw secrets and unbounded command output. Shell
stdout/stderr evidence is truncated with explicit `truncated: true` flags.

## Contribution Operation Flow

`contributeOperation` changes from direct draft-to-contribution creation to:

1. Resolve agent, mode, timestamp, relations, artifacts, and idempotency.
2. Run existing relation and CAS existence validation.
3. Build unsigned `ContributionInput`.
4. Run admission mutators and validators.
5. Add `context.admission` to the final input.
6. Attach routing signature if needed.
7. Compute the contribution CID.
8. Continue duplicate detection, policy migration fallback, write, routing,
   event, outcome, and stop-condition behavior.

Admission must run before durable idempotency result storage. If admission
rejects, the idempotency slot is released so a corrected retry with the same key
can proceed.

## Migration Plan

Implementation should be staged to minimize behavioral risk:

1. Add contract types and parsing for `admission:` plus normalized admission
   rule derivation from legacy `hooks.before_contribute` and `gates:`.
2. Add admission core, errors, result types, and in-memory test adapters.
3. Implement local validators for shell, metric checks, artifact requirements,
   relation requirements, and `metric_improves`.
4. Wire the chain into `contributeOperation` before CID computation and attach
   audit metadata.
5. Move existing `PolicyEnforcer` gate checks behind admission validators while
   preserving outcome derivation and stop-condition behavior.
6. Add ReBAC and governance adapter interfaces to Grove core and no-op/absent
   adapters for local mode.
7. Wire Nexus mode to adapters that call the Nexus backend or bridge layer,
   keeping Grove core independent of Nexus Python implementation details.
8. Update `spec/GROVE-CONTRACT.md`, `spec/schemas/grove-contract.json`,
   README/GROVE examples, and any CLI/server schemas that expose contract data.

During migration, duplicate enforcement must be avoided. Once gates are
represented as admission validators, the old gate enforcement path should not
run a second time for the same contribution.

## Error Handling

Admission rejection maps to the existing operation error style as validation or
policy rejection. The response includes:

- `ruleName`
- `ruleType`
- `reason`
- `evidence`
- `annotations`

Unexpected adapter exceptions are fail-closed for validators. Mutator
exceptions also reject the operation because validators cannot safely run on an
unknown partially-mutated object.

Adapter evidence should include stable classifications, not raw stack traces.
Debug logs may include deeper detail under existing Grove debug conventions.

## Testing

Add focused Bun tests:

- Contract parser accepts `admission:` and rejects duplicate names or invalid
  rule-specific fields.
- Legacy `hooks.before_contribute` normalizes to a shell validator.
- Legacy `gates:` normalize to admission validators.
- Mutators run before validators, and validators see the mutated object.
- Validators fail fast and later validators do not run after rejection.
- Successful admission attaches `context.admission` before CID computation.
- Admission rejection releases idempotency reservations for corrected retries.
- Shell validator records bounded evidence on success and failure.
- Gate compatibility tests preserve existing `PolicyEnforcer` behavior for
  `metric_improves`, `has_artifact`, `has_relation`, and `min_score`.
- Mock ReBAC adapter rejects denied permissions and accepts allowed ones.
- Mock governance adapter rejects blocked constraints and accepts clean checks.

Run at least:

```bash
bun test src/core/contract.test.ts
bun test src/core/admission
bun test src/core/operations/contribute.test.ts
bun run typecheck
bun run check
```

## Rollout

The feature is backwards-compatible for existing contracts. Existing GROVE.md
files with `gates:` or `hooks.before_contribute` should behave the same, except
accepted contributions now include admission audit metadata.

New contracts can move directly to `admission:` for ordered, composable rules.
Documentation should mark `hooks.before_contribute` as compatibility syntax and
recommend `admission: - type: shell` for new work.

Nexus governance and ReBAC integration is opt-in. Local mode remains usable
without Nexus dependencies. Nexus mode should fail closed only when a contract
explicitly configures Nexus-backed admission rules.
