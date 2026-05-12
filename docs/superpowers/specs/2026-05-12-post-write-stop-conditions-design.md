# Post-Write Stop Conditions Design

## Summary

Stop-condition evaluation should move out of `PolicyEnforcer.enforce()` and remain on the post-write path in `contributeOperation`. `PolicyEnforcer` should enforce contribution policy only: role-kind constraints, score requirements, relation requirements, artifact requirements, gates, and derived outcomes. Stop detection for persisted contribution writes should be populated after the write, using `evaluateStopConditions()` against the updated store.

## Current Behavior

`PolicyEnforcer.enforce()` evaluates configured stop conditions before a contribution is written. That pre-write result cannot see the contribution being enforced, so it misses threshold-crossing writes. `contributeOperation` already runs a full post-write recheck outside the write mutex to detect those threshold crossings and to broadcast stop events.

The pre-write check therefore duplicates work for contribution writes. It also creates a public `enforce()` behavior where direct callers receive `stopResult`, while lifecycle and MCP stop checks already use `evaluateStopConditions()` directly.

## Design

`PolicyEnforcer.enforce()` will no longer evaluate stop conditions or accept stop-condition skip options. Its `PolicyEnforcementResult.stopResult` property remains available because `contributeOperation` attaches post-write stop results to the same result object returned to callers.

`contributeOperation` will continue classifying plans, done markers, and ephemeral chat as stop-excluded writes. For all other writes with a configured contract, it will run the existing post-write `evaluateStopConditions()` retry loop after persistence and set `policyResult.stopResult` from that result. If post-write evaluation fails after retries, it will keep the current degraded stop-result behavior.

Lifecycle paths, including `grove_check_stop`, remain unchanged and continue using `evaluateStopConditions()` as the canonical evaluator.

## Testing

Policy-enforcer tests should assert that stop conditions are not evaluated by `enforce()`. Operation tests should assert that normal contribution writes still populate stop results and broadcast stops post-write, and that plan/done/ephemeral writes still do not trigger stop evaluation. Cross-path parity tests should compare lifecycle evaluation only against `contributeOperation`, not direct `PolicyEnforcer.enforce()` stop output.
