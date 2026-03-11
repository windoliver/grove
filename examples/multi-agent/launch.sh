#!/bin/bash
# launch.sh — Start 3 agents for multi-agent collaboration via grove.
#
# Agents self-coordinate through grove's shared state (frontier, claims,
# contributions). No central orchestrator.
#
# Prerequisites:
#   npm install -g acpx@latest
#   bun install && bun run build
#   grove init "Optimize code for throughput" --seed ./src/
#
# Usage:
#   ./examples/multi-agent/launch.sh
#
# Each agent gets:
#   - grove MCP tools (grove_frontier, grove_claim, grove_contribute, etc.)
#   - @grove/ask-user MCP (answers clarifying questions headlessly)
#
# Agents will run until stop conditions in GROVE.md are met.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Helper: run grove CLI via bun (binaries aren't globally linked after build)
grove_cli() { bun run "$PROJECT_ROOT/dist/cli/main.js" "$@"; }

# Verify prerequisites
command -v acpx >/dev/null 2>&1 || {
  echo "Error: acpx not found. Install with: npm install -g acpx@latest"
  exit 1
}

if [ ! -f "$PROJECT_ROOT/dist/cli/main.js" ]; then
  echo "Error: dist/ not found. Run 'bun run build' first."
  exit 1
fi

# Initialize grove if not already initialized
if [ ! -d ".grove" ]; then
  echo "Initializing grove..."
  grove_cli init "Optimize code for throughput"
  cp "$SCRIPT_DIR/grove.md" ./GROVE.md
fi

echo "=== Starting multi-agent collaboration ==="
echo "Agents will self-coordinate through grove."
echo "Monitor progress with: grove frontier / grove tree / grove claims"
echo ""

# Agent A: Implementer (Claude Code)
# Full permissions — needs to write code and run tests
acpx --approve-all claude \
  --mcp grove-mcp \
  --mcp @grove/ask-user \
  "You are Agent A (Implementer) working on this grove.

Your workflow:
1. Call grove_frontier to see current best results and what needs work.
2. Call grove_claim with a targetRef describing what you'll work on.
3. Implement the optimization (write code, run tests).
4. Call grove_contribute with kind=work, your scores, and artifacts.
5. Call grove_check_stop — if stopped, exit. Otherwise loop to step 1.

Focus on implementation. Build on the best existing work (derives_from).
If your claim conflicts, pick different work.
Keep going until grove_check_stop returns stopped=true." &
PID_A=$!

# Agent B: Reviewer (Codex)
# Read-only permissions — only reviews code, doesn't write
acpx --approve-reads codex \
  --mcp grove-mcp \
  --mcp @grove/ask-user \
  "You are Agent B (Reviewer) working on this grove.

Your workflow:
1. Call grove_frontier to see contributions that need review.
2. Call grove_claim with targetRef=<CID of contribution to review>.
3. Review the contribution thoroughly (read code, check logic).
4. Call grove_review with your assessment and a score (0.0-1.0).
5. Call grove_check_stop — if stopped, exit. Otherwise loop to step 1.

Focus on reviewing other agents' contributions. Be thorough but fair.
If your claim conflicts, pick a different contribution to review.
Keep going until grove_check_stop returns stopped=true." &
PID_B=$!

# Agent C: Reproducer (Claude Code)
# Full permissions — needs to run code to reproduce results
acpx --approve-all claude \
  --mcp grove-mcp \
  --mcp @grove/ask-user \
  "You are Agent C (Reproducer) working on this grove.

Your workflow:
1. Call grove_frontier to see the best contributions.
2. Call grove_claim with targetRef=<CID of contribution to reproduce>.
3. Call grove_checkout to get the contribution's artifacts.
4. Run the code independently to verify the claimed scores.
5. Call grove_reproduce with result=confirmed|challenged|partial.
6. Call grove_check_stop — if stopped, exit. Otherwise loop to step 1.

Focus on reproducing promising results. Independent verification is critical.
If your claim conflicts, pick a different contribution to reproduce.
Keep going until grove_check_stop returns stopped=true." &
PID_C=$!

echo "Agent A (Implementer): PID $PID_A"
echo "Agent B (Reviewer):    PID $PID_B"
echo "Agent C (Reproducer):  PID $PID_C"
echo ""
echo "Waiting for all agents to complete..."

# Wait for each agent and track exit codes.
# Disable errexit so a non-zero wait doesn't abort the script.
FAIL=0
wait $PID_A 2>/dev/null || true; RC_A=$?
wait $PID_B 2>/dev/null || true; RC_B=$?
wait $PID_C 2>/dev/null || true; RC_C=$?

echo ""
if [ $RC_A -ne 0 ]; then echo "Agent A (Implementer) FAILED (exit $RC_A)"; FAIL=1; fi
if [ $RC_B -ne 0 ]; then echo "Agent B (Reviewer)    FAILED (exit $RC_B)"; FAIL=1; fi
if [ $RC_C -ne 0 ]; then echo "Agent C (Reproducer)  FAILED (exit $RC_C)"; FAIL=1; fi

if [ $FAIL -ne 0 ]; then
  echo "=== Some agents failed ==="
else
  echo "=== All agents completed successfully ==="
fi
echo ""

# Show results
echo "--- Frontier (final results) ---"
grove_cli frontier 2>/dev/null || echo "(grove CLI not available — use: bun run examples/multi-agent/scenario.ts)"

echo ""
echo "--- Collaboration DAG ---"
grove_cli tree 2>/dev/null || echo "(grove CLI not available)"

echo ""
echo "--- Claims (should be completed/expired, none stuck) ---"
grove_cli claims 2>/dev/null || echo "(grove CLI not available)"
