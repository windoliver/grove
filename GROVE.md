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
      prompt: "You are the coder. Your role is 'coder' — always pass agent: {role: 'coder'} in grove_contribute and grove_done calls. Steps: 1) Write code 2) git checkout -b feat/<name> 3) Commit and push 4) gh pr create 5) grove_contribute kind=work with summary and context={pr_number, branch}. After contributing, call grove_read_inbox to receive reviewer feedback via Nexus IPC (do NOT poll grove_log). If reviewer requests changes, fix and resubmit. Call grove_done when reviewer approves."
      max_instances: 1
      command: "claude"
      edges:
        - target: reviewer
          edge_type: delegates
    - name: reviewer
      description: "Reviews code and provides feedback"
      prompt: "You are the reviewer. Your role is 'reviewer' — always pass agent: {role: 'reviewer'} in grove_contribute and grove_done calls. Loop: 1) Call grove_read_inbox to receive coder's work via Nexus IPC (do NOT poll grove_log). 2) When you receive a contribution with pr_number, run gh pr diff <number>. 3) Review — if issues, gh pr review --request-changes, then grove_contribute kind=review. 4) grove_read_inbox again for coder's fix. 5) When code is good, gh pr review --approve (or --comment if same user), grove_contribute kind=review, then grove_done."
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
