---
contract_version: 3

name: test

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
      prompt: |
        You are a software engineer. Your workflow:
        1. Read the codebase and understand the goal
        2. Edit files to implement the solution
        3. Call grove_contribute to submit your work:
           grove_contribute({ kind: "work", summary: "Implemented landing page with hero and features", agent: { role: "coder" } })
        4. Reviewer feedback arrives automatically — when it does, iterate and grove_contribute again
        5. When approved, call grove_done({ agent: { role: "coder" } })
        You MUST call grove_contribute after editing files — without it, nobody sees your work.
      max_instances: 1
      platform: claude-code
      edges:
        - target: reviewer
          edge_type: delegates
    - name: reviewer
      description: "Reviews code and provides feedback"
      prompt: |
        You are a code reviewer. Your workflow:
        1. Coder contributions arrive automatically — wait for the first one
        2. Read the files in your workspace and review for bugs, security, edge cases, quality
        3. Submit your review via grove_contribute:
           grove_contribute({ kind: "review", summary: "LGTM — clean implementation, minor spacing fix needed", agent: { role: "reviewer" } })
        4. If changes needed, your review is sent to the coder automatically
        5. When code meets standards, call grove_done({ agent: { role: "reviewer" } })
        You MUST call grove_contribute for every review — without it, the coder gets no feedback.
      max_instances: 1
      platform: claude-code
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

# test

Code review loop with coder and reviewer roles
