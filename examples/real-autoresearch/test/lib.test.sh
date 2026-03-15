#!/bin/bash
# lib.test.sh — Tests for shared bash functions in examples/lib.sh.
#
# Usage: bash examples/real-autoresearch/test/lib.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_PASS=0
TEST_FAIL=0

# --- Test helpers ---

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo "  PASS: $label"
    TEST_PASS=$((TEST_PASS + 1))
  else
    echo "  FAIL: $label (expected '$expected', got '$actual')"
    TEST_FAIL=$((TEST_FAIL + 1))
  fi
}

assert_contains() {
  local label="$1" needle="$2" haystack="$3"
  if echo "$haystack" | grep -q "$needle"; then
    echo "  PASS: $label"
    TEST_PASS=$((TEST_PASS + 1))
  else
    echo "  FAIL: $label (expected to contain '$needle')"
    TEST_FAIL=$((TEST_FAIL + 1))
  fi
}

# --- Source lib.sh ---

PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"  # used by lib.sh
export PROJECT_ROOT
# shellcheck source=../../lib.sh
source "$SCRIPT_DIR/../../lib.sh"

echo "=== Testing examples/lib.sh ==="
echo ""

# --- Test detect_platform ---

echo "detect_platform:"

# Test auto-detection (should return apple-silicon on ARM64 Mac)
result="$(detect_platform)"
case "$(uname -m)" in
  arm64) assert_eq "auto-detect arm64" "apple-silicon" "$result" ;;
  *)     assert_eq "auto-detect x86" "gpu" "$result" ;;
esac

# Test env var override
GROVE_PLATFORM="gpu" result="$(detect_platform)"
assert_eq "env override to gpu" "gpu" "$result"
unset GROVE_PLATFORM

GROVE_PLATFORM="apple-silicon"
export GROVE_PLATFORM
result="$(detect_platform)"
assert_eq "env override to apple-silicon" "apple-silicon" "$result"
unset GROVE_PLATFORM

echo ""

# --- Test grove_cli function exists ---

echo "grove_cli:"
# Just verify the function is defined (can't run without dist/)
if declare -f grove_cli >/dev/null 2>&1; then
  echo "  PASS: grove_cli function defined"
  TEST_PASS=$((TEST_PASS + 1))
else
  echo "  FAIL: grove_cli function not defined"
  TEST_FAIL=$((TEST_FAIL + 1))
fi

echo ""

# --- Test run_agent with a quick command ---

echo "run_agent:"

TEMP_LOG_DIR="$(mktemp -d)"

# Test that run_agent captures output and tracks restarts
run_agent "test-agent" "$TEMP_LOG_DIR" 1 5 echo "hello from agent" >/dev/null 2>&1
exit_code=$?
assert_eq "run_agent exits cleanly on success" "0" "$exit_code"

log_content="$(cat "$TEMP_LOG_DIR/test-agent.log" 2>/dev/null || echo "")"
assert_contains "log contains session info" "Session #1" "$log_content"
assert_contains "log contains agent output" "hello from agent" "$log_content"

# Test max_restarts enforcement (reduce sleep by using a quick-failing command)
# Override sleep to make test fast
run_agent "fail-agent" "$TEMP_LOG_DIR" 2 2 bash -c "exit 1" >/dev/null 2>&1 &
FAIL_PID=$!
# Replace the 10s sleep — send output to background and wait with our own timeout
wait $FAIL_PID 2>/dev/null
exit_code=$?
assert_eq "run_agent stops after max_restarts" "1" "$exit_code"

fail_log="$(cat "$TEMP_LOG_DIR/fail-agent.log" 2>/dev/null || echo "")"
assert_contains "fail log has session 1" "Session #1" "$fail_log"
assert_contains "fail log has session 2" "Session #2" "$fail_log"
assert_contains "fail log has max restarts msg" "Max restarts" "$fail_log"

rm -rf "$TEMP_LOG_DIR"

echo ""

# --- Summary ---

echo "=== Results: $TEST_PASS passed, $TEST_FAIL failed ==="
if [ "$TEST_FAIL" -gt 0 ]; then
  exit 1
fi
