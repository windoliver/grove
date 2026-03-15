#!/bin/bash
# lib.sh — Shared bash functions for grove example launchers.
#
# Source this file from example launch scripts:
#   source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

# ---------------------------------------------------------------------------
# Globals (set by sourcing script)
# ---------------------------------------------------------------------------

# PROJECT_ROOT must be set by the sourcing script before calling any function.
# SCRIPT_DIR must be set by the sourcing script.

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Run grove CLI via bun (binaries aren't globally linked after build).
grove_cli() { bun run "$PROJECT_ROOT/dist/cli/main.js" "$@"; }

# ---------------------------------------------------------------------------
# Prerequisite checks
# ---------------------------------------------------------------------------

# Verify that required tools are available.
# Args: tool names to check (e.g., check_prereqs acpx bun)
check_prereqs() {
  local missing=0
  for cmd in "$@"; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
      echo "Error: $cmd not found."
      case "$cmd" in
        acpx)   echo "  Install with: npm install -g acpx@latest" ;;
        bun)    echo "  Install with: curl -fsSL https://bun.sh/install | bash" ;;
        uv)     echo "  Install with: curl -LsSf https://astral.sh/uv/install.sh | sh" ;;
        gemini) echo "  Install with: npm install -g @anthropic-ai/gemini-cli" ;;
      esac
      missing=1
    fi
  done

  if [ ! -f "$PROJECT_ROOT/dist/cli/main.js" ]; then
    echo "Error: dist/ not found. Run 'bun run build' first."
    missing=1
  fi

  if [ "$missing" -eq 1 ]; then
    exit 1
  fi
}

# ---------------------------------------------------------------------------
# Platform detection
# ---------------------------------------------------------------------------

# Detect platform: "apple-silicon" or "gpu".
# Override with GROVE_PLATFORM env var.
detect_platform() {
  if [ -n "${GROVE_PLATFORM:-}" ]; then
    echo "$GROVE_PLATFORM"
    return
  fi
  case "$(uname -m)" in
    arm64) echo "apple-silicon" ;;
    *)     echo "gpu" ;;
  esac
}

# ---------------------------------------------------------------------------
# Portable timeout — macOS doesn't ship GNU timeout
# ---------------------------------------------------------------------------

# Run a command with a timeout. Uses GNU timeout if available, otherwise
# falls back to a background-process + kill approach.
_run_with_timeout() {
  local secs="$1"
  shift

  # Prefer GNU timeout (Linux, or Homebrew coreutils on macOS)
  if command -v timeout >/dev/null 2>&1; then
    timeout "$secs" "$@"
    return $?
  elif command -v gtimeout >/dev/null 2>&1; then
    gtimeout "$secs" "$@"
    return $?
  fi

  # Portable fallback: run in a new process group, kill the whole group
  # after the deadline. This ensures child processes (e.g., agent CLIs
  # that spawn subprocesses) are also terminated, preventing duplicate
  # agents after a Ralph loop restart.
  set -m  # enable job control so "$@" runs in its own process group
  "$@" &
  local pid=$!
  (
    sleep "$secs"
    # Kill the entire process group (negative PID), not just the leader
    kill -- -"$pid" 2>/dev/null
  ) &
  local watchdog=$!
  set +m  # restore
  wait "$pid" 2>/dev/null
  local rc=$?
  kill "$watchdog" 2>/dev/null
  wait "$watchdog" 2>/dev/null
  return $rc
}

# ---------------------------------------------------------------------------
# Ralph loop — auto-restart stalled agents
# ---------------------------------------------------------------------------

# Run an agent command in a loop with restart tracking.
#
# Usage: run_agent <name> <log_dir> <max_restarts> <timeout_sec> <command...>
#
# Logs restarts to <log_dir>/<name>.log with timestamps and exit codes.
# Set max_restarts to 0 for unlimited.
run_agent() {
  local name="$1"
  local log_dir="$2"
  local max_restarts="$3"
  local timeout_sec="$4"
  shift 4

  local log_file="${log_dir}/${name}.log"
  local restart_count=0

  mkdir -p "$log_dir"

  while true; do
    restart_count=$((restart_count + 1))

    if [ "$max_restarts" -gt 0 ] && [ "$restart_count" -gt "$max_restarts" ]; then
      echo "[$name] Max restarts ($max_restarts) reached. Stopping." | tee -a "$log_file"
      return 1
    fi

    echo "[$name] Session #${restart_count} starting at $(date)" | tee -a "$log_file"
    _run_with_timeout "$timeout_sec" "$@" >> "$log_file" 2>&1
    local exit_code=$?
    echo "[$name] Session #${restart_count} ended at $(date) with exit code $exit_code" | tee -a "$log_file"

    if [ "$exit_code" -eq 0 ]; then
      echo "[$name] Agent exited cleanly." | tee -a "$log_file"
      return 0
    fi

    echo "[$name] Restarting in 10s..." | tee -a "$log_file"
    sleep 10
  done
}

# ---------------------------------------------------------------------------
# Results display
# ---------------------------------------------------------------------------

# Show grove frontier, tree, and claims.
show_results() {
  echo ""
  echo "--- Frontier (final results) ---"
  grove_cli frontier 2>/dev/null || echo "(grove CLI not available)"

  echo ""
  echo "--- Collaboration DAG ---"
  grove_cli tree 2>/dev/null || echo "(grove CLI not available)"

  echo ""
  echo "--- Claims ---"
  grove_cli claims 2>/dev/null || echo "(grove CLI not available)"
}
