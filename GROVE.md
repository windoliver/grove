---
contract_version: 3

name: drifting-cooking-lerdorf

description: Code review loop with coder and reviewer roles

mode: exploration

# Metrics — define measurable objectives.
# Uncomment and configure for evaluation mode.
#
# metrics:
#   metric_name:
#     direction: minimize    # or maximize
#     unit: ""               # optional unit label
#     description: ""        # optional description

# Gates — contribution acceptance rules.
# Uncomment and configure to enforce quality requirements.
#
# gates:
#   - type: metric_improves
#     metric: <metric_name>
#   - type: has_artifact
#     name: <artifact_name>
#   - type: has_relation
#     relation_type: derives_from
#   - type: min_reviews
#     count: 1

# Stop conditions — when to pause work.
#
# stop_conditions:
#   max_rounds_without_improvement: 5
#   target_metric:
#     metric: <metric_name>
#     value: 0.99
#   budget:
#     max_contributions: 100
#     max_wall_clock_seconds: 3600

agent_constraints:
  required_artifacts:
    work: ["diff.patch"]
  required_relations:
    review: ["reviews"]

evaluation:
  required_context: ["pr_number", "branch"]

concurrency:
  max_active_claims: 4
  max_claims_per_agent: 1

execution:
  default_lease_seconds: 300
  max_lease_seconds: 900

agent_topology:
  structure: graph
  roles:
    - name: coder
      description: "Writes and iterates on code"
      prompt: "Write code for the session goal. Keep changes small — one file, under 80 lines. Steps: 1) Write code 2) git checkout -b feat/<name> 3) Commit and push 4) gh pr create 5) grove_ingest_git_diff to get diff hash 6) grove_contribute kind=work artifacts={diff.patch: hash} context={pr_number: N, branch: name}. CONTRACT ENFORCES: diff.patch artifact and pr_number/branch are REQUIRED. After contributing, check grove_log for reviewer feedback. If reviewer requests changes, fix them, push, and grove_contribute again. Only call grove_done after reviewer approves."
      max_instances: 1
      command: "claude"
      edges:
        - target: reviewer
          edge_type: delegates
    - name: reviewer
      description: "Reviews code and provides feedback"
      prompt: "Loop: 1) Check grove_log for work contributions with pr_number. 2) Read PR diff with gh pr diff <number>. 3) Review code — if issues found, gh pr review --request-changes with feedback, then grove_contribute kind=review with reviews relation. 4) Check grove_log again — wait for coder to fix and resubmit. 5) Re-review the updated PR. 6) When code is good, gh pr review --approve, grove_contribute kind=review, then grove_done. Do NOT call grove_done until you have approved. CONTRACT ENFORCES: reviews relation REQUIRED."
      max_instances: 1
      command: "claude"
      edges:
        - target: coder
          edge_type: feedback
  spawning:
    dynamic: true
    max_depth: 2

# Rate limits — prevent runaway agents.
#
# rate_limits:
#   max_contributions_per_agent_per_hour: 30
#   max_contributions_per_grove_per_hour: 100
#   max_artifact_size_bytes: 10485760
#   max_artifacts_per_contribution: 50

# Retry — backoff configuration for failed operations.
#
# retry:
#   max_attempts: 5
#   base_delay_ms: 10000
#   max_backoff_ms: 300000

# Lifecycle hooks — shell commands run at key points.
#
# hooks:
#   after_checkout: "echo 'Workspace ready'"
#   before_contribute: "bun test"
#   after_contribute: "echo 'Contribution submitted'"
---

# drifting-cooking-lerdorf

Code review loop with coder and reviewer roles
