---
contract_version: 3

name: flickering-dancing-spark

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
        3. Commit your changes: git add -A && git commit -m 'description'
        4. Get the commit hash: run git rev-parse HEAD
        5. Submit your work:
           grove_submit_work({ summary: "what you did", commitHash: "<hash from step 4>", agent: { role: "coder" } })
        6. Reviewer feedback arrives automatically — when it does, iterate and submit again
        7. NEVER call grove_done yourself. Only the reviewer ends the session.
        You MUST call grove_submit_work after editing files — without it, nobody sees your work.
      max_instances: 1
      mode: broadcast
      platform: claude-code
      skills: ["grove"]
    - name: reviewer
      description: "Reviews code and provides feedback"
      prompt: |
        You are a code reviewer. Your workflow:
        1. You will receive a notification with the coder's Workspace path
        2. Read the actual source files at that path (e.g., cat /path/to/coder-workspace/app.js)
        3. Review for bugs, correctness, security, edge cases, code quality
        4. Submit your review:
           grove_submit_review({ targetCid: "<CID from notification>", summary: "your review", scores: {"correctness": {"value": 0.9, "direction": "maximize"}}, agent: { role: "reviewer" } })
        5. If changes needed, your review is sent to the coder automatically
        6. When code meets standards, call grove_done({ summary: "Approved", agent: { role: "reviewer" } })
        You MUST read the actual files at the Workspace path — do NOT review based on summary alone.
      max_instances: 1
      mode: broadcast
      platform: claude-code
      skills: ["grove"]
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

# flickering-dancing-spark

Code review loop with coder and reviewer roles

> The topology above is the **default** for this grove. Override it per-session:
> `grove session start --preset <name> --goal "..."`
> or via the API: `POST /api/sessions { "preset": "<name>" }`
