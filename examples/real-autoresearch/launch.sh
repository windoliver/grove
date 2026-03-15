#!/bin/bash
# launch.sh — Start multi-agent autoresearch with grove coordination.
#
# Supports both Apple Silicon (MLX) and Cloud GPU (H100).
# Platform is auto-detected via uname -m; override with GROVE_PLATFORM.
#
# Agents self-coordinate through grove (frontier, claims, contributions).
# Each agent runs in a Ralph loop for automatic restart on stall/crash.
#
# Prerequisites:
#   - Nexus running on NEXUS_PORT (default: 1001)
#   - acpx, bun installed
#   - grove built (bun run build)
#   - autoresearch repo cloned and data prepared (see setup-*.sh)
#
# Usage:
#   NEXUS_PORT=1001 ./examples/real-autoresearch/launch.sh
#
# Environment:
#   NEXUS_PORT          Nexus server port (default: 1001)
#   GROVE_PLATFORM      Override platform detection (apple-silicon|gpu)
#   GROVE_NO_TRAIN_LOCK Skip flock serialization (set to 1 for GPU)
#   MAX_RESTARTS        Max Ralph loop restarts per agent (default: 0 = unlimited)
#   AGENT_TIMEOUT       Timeout per agent session in seconds (default: 900)
#   RESEARCHER_CMD      Override researcher agent command (default: acpx --approve-all claude)
#   REVIEWER_CMD        Override reviewer agent command (default: acpx --approve-reads codex)
#   REPRODUCER_CMD      Override reproducer agent command (default: gemini)

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PROJECT_ROOT
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Source shared functions
# shellcheck source=../lib.sh
source "$SCRIPT_DIR/../lib.sh"

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

NEXUS_PORT="${NEXUS_PORT:-1001}"
NEXUS_URL="http://localhost:${NEXUS_PORT}"
MAX_RESTARTS="${MAX_RESTARTS:-0}"
AGENT_TIMEOUT="${AGENT_TIMEOUT:-900}"
LOG_DIR="${LOG_DIR:-.grove/agent-logs}"

PLATFORM="$(detect_platform)"

# Agent runtime commands (configurable via env vars)
RESEARCHER_CMD="${RESEARCHER_CMD:-acpx --approve-all claude}"
REVIEWER_CMD="${REVIEWER_CMD:-acpx --approve-reads codex}"
REPRODUCER_CMD="${REPRODUCER_CMD:-gemini}"

# On GPU platforms, disable flock by default (concurrent training is fine)
if [ "$PLATFORM" = "gpu" ]; then
  export GROVE_NO_TRAIN_LOCK="${GROVE_NO_TRAIN_LOCK:-1}"
fi

# ---------------------------------------------------------------------------
# Prerequisite checks
# ---------------------------------------------------------------------------

echo "=== Real Autoresearch — grove multi-agent ==="
echo "Platform:   $PLATFORM"
echo "Nexus:      $NEXUS_URL"
echo "Timeout:    ${AGENT_TIMEOUT}s per session"
echo "Max restarts: ${MAX_RESTARTS:-unlimited}"
echo ""

# Check basic prerequisites
check_prereqs acpx bun

# Verify Nexus is reachable
echo "Checking Nexus at $NEXUS_URL..."
if ! curl -sf "${NEXUS_URL}/health" >/dev/null 2>&1; then
  echo "Error: Nexus not reachable at $NEXUS_URL"
  echo "  Start Nexus on port $NEXUS_PORT, or set NEXUS_PORT to the correct port."
  exit 1
fi
echo "  Nexus: OK"
echo ""

# ---------------------------------------------------------------------------
# Initialize grove (if not already initialized)
# ---------------------------------------------------------------------------

if [ ! -d ".grove" ]; then
  echo "Initializing grove with Nexus backend..."
  grove_cli init "Optimize GPT Training" \
    --nexus-url "$NEXUS_URL"
  cp "$SCRIPT_DIR/grove.md" ./GROVE.md
  echo ""
fi

# Copy train-locked.sh into working directory
cp "$SCRIPT_DIR/train-locked.sh" ./train-locked.sh
chmod +x ./train-locked.sh

# ---------------------------------------------------------------------------
# Launch agents
# ---------------------------------------------------------------------------

echo "=== Starting agents ==="
echo "Monitor progress: grove frontier / grove tree / grove tui"
echo "Logs: $LOG_DIR/"
echo ""

mkdir -p "$LOG_DIR"

# Load prompts from external files
RESEARCHER_PROMPT="$(cat "$SCRIPT_DIR/prompts/researcher.md")"
REVIEWER_PROMPT="$(cat "$SCRIPT_DIR/prompts/reviewer.md")"
REPRODUCER_PROMPT="$(cat "$SCRIPT_DIR/prompts/reproducer.md")"

# Agent A — ML Researcher
# shellcheck disable=SC2086 # Intentional word splitting: CMD contains "acpx --approve-all claude"
run_agent "researcher" "$LOG_DIR" "$MAX_RESTARTS" "$AGENT_TIMEOUT" \
  $RESEARCHER_CMD \
  --mcp grove-mcp \
  --mcp @grove/ask-user \
  "$RESEARCHER_PROMPT" &
PID_A=$!

# Agent B — Code Reviewer (no GPU needed, runs concurrently)
# shellcheck disable=SC2086
run_agent "reviewer" "$LOG_DIR" "$MAX_RESTARTS" "$AGENT_TIMEOUT" \
  $REVIEWER_CMD \
  --mcp grove-mcp \
  --mcp @grove/ask-user \
  "$REVIEWER_PROMPT" &
PID_B=$!

# Agent C — Reproducer
# shellcheck disable=SC2086
run_agent "reproducer" "$LOG_DIR" "$MAX_RESTARTS" "$AGENT_TIMEOUT" \
  $REPRODUCER_CMD \
  --mcp grove-mcp \
  "$REPRODUCER_PROMPT" &
PID_C=$!

echo "Agent A (Researcher):  PID $PID_A"
echo "Agent B (Reviewer):    PID $PID_B"
echo "Agent C (Reproducer):  PID $PID_C"
echo ""
echo "Waiting for all agents to complete..."

# ---------------------------------------------------------------------------
# Wait and report
# ---------------------------------------------------------------------------

FAIL=0
wait $PID_A 2>/dev/null; RC_A=$?
wait $PID_B 2>/dev/null; RC_B=$?
wait $PID_C 2>/dev/null; RC_C=$?

echo ""
if [ $RC_A -ne 0 ]; then echo "Agent A (Researcher)  FAILED (exit $RC_A)"; FAIL=1; fi
if [ $RC_B -ne 0 ]; then echo "Agent B (Reviewer)    FAILED (exit $RC_B)"; FAIL=1; fi
if [ $RC_C -ne 0 ]; then echo "Agent C (Reproducer)  FAILED (exit $RC_C)"; FAIL=1; fi

if [ $FAIL -ne 0 ]; then
  echo "=== Some agents failed (check $LOG_DIR/ for details) ==="
else
  echo "=== All agents completed successfully ==="
fi

show_results
