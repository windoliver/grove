#!/usr/bin/env bash
# Grove agent runner — spawned by TUI's Ctrl+P command palette.
# Usage: grove-agent.sh <role> [round]
#
# Reads GROVE.md for context, constructs a role-specific prompt,
# and runs acpx codex to execute the agent's task autonomously.

set -euo pipefail

ROLE="${1:?Usage: grove-agent.sh <role>}"
ROUND="${2:-1}"
GROVE_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GROVE_BIN="bun $GROVE_ROOT/dist/cli/main.js"

# Resolve nexus credentials from environment (set by grove up)
export NEXUS_API_KEY="${NEXUS_API_KEY:-}"
export GROVE_AGENT_ID="${ROLE}-$$"
export GROVE_AGENT_NAME="${ROLE^}"  # capitalize first letter

echo "=== Grove Agent: $ROLE (round $ROUND) ==="
echo "  grove root: $GROVE_ROOT"
echo "  agent id:   $GROVE_AGENT_ID"

# Read current frontier to know what's available
FRONTIER=$($GROVE_BIN frontier --json 2>/dev/null || echo '[]')
LOG=$($GROVE_BIN log --limit 5 2>/dev/null || echo 'No contributions yet')

# Build role-specific prompt
case "$ROLE" in
  coder)
    PROMPT="You are the CODER agent in a Grove review-loop. Working directory: $(pwd)

CONTEXT — Recent contributions:
$LOG

YOUR TASK (round $ROUND):
1. Read GROVE.md to understand the project
2. Create or improve a source file. If this is round 1, create src/utils/parser.ts with a simple CSV parser. If a later round, read previous reviews via 'grove log' and improve the code.
3. Submit your work by running:
   NEXUS_API_KEY=$NEXUS_API_KEY GROVE_AGENT_ID=$GROVE_AGENT_ID GROVE_AGENT_NAME=$GROVE_AGENT_NAME $GROVE_BIN contribute --kind work --summary '<describe what you did>' --mode evaluation --artifacts <your-file>
4. Print the blake3 CID.

IMPORTANT: Only create/edit files and run the grove contribute command. Nothing else."
    ;;

  reviewer)
    # Find the latest work contribution to review
    LATEST_WORK=$(echo "$LOG" | grep -o 'blake3:[a-f0-9]*' | head -1)
    PROMPT="You are the REVIEWER agent in a Grove review-loop. Working directory: $(pwd)

CONTEXT — Recent contributions:
$LOG

YOUR TASK:
1. Find source files to review (look in src/ directory)
2. Read the code carefully
3. Write a 2-3 sentence code review identifying issues
4. Submit your review by running:
   NEXUS_API_KEY=$NEXUS_API_KEY GROVE_AGENT_ID=$GROVE_AGENT_ID GROVE_AGENT_NAME=$GROVE_AGENT_NAME $GROVE_BIN review ${LATEST_WORK:-HEAD} --summary '<your review>' --score quality=<0.0-1.0>
5. Print the blake3 CID.

Score guide: 0.0-0.3 = poor, 0.4-0.6 = needs work, 0.7-0.8 = good, 0.9-1.0 = excellent.
IMPORTANT: Only read files and run the grove review command. Nothing else."
    ;;

  *)
    echo "Unknown role: $ROLE (expected: coder, reviewer)"
    exit 1
    ;;
esac

echo "  prompt length: ${#PROMPT} chars"
echo "  launching acpx codex..."
echo ""

# Run the agent via acpx codex
npx acpx \
  --approve-all \
  --max-turns 8 \
  --timeout 180 \
  --format text \
  codex exec "$PROMPT"

echo ""
echo "=== Agent $ROLE finished ==="
