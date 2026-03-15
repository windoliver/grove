#!/bin/bash
# train-locked.sh — Run training with serialization lock.
#
# On Apple Silicon, unified memory is shared between CPU and GPU.
# Only one training job should run at a time to avoid OOM.
# This wrapper serializes concurrent training invocations.
#
# Uses flock on Linux, mkdir-based lock on macOS (flock is Linux-only).
#
# On GPU platforms (H100, A100), the lock is a no-op (can be disabled
# with GROVE_NO_TRAIN_LOCK=1).
#
# Usage:
#   ./train-locked.sh            # runs: uv run train.py
#   ./train-locked.sh --lr 1e-3  # passes args through to train.py

set -uo pipefail

LOCK_DIR="${GROVE_TRAIN_LOCK:-/tmp/grove-training.lock.d}"

if [ "${GROVE_NO_TRAIN_LOCK:-0}" = "1" ]; then
  exec uv run train.py "$@"
fi

# Portable lock: mkdir is atomic on all POSIX systems.
# Spin until we acquire the lock, then run training, then release.
_acquire() {
  while ! mkdir "$LOCK_DIR" 2>/dev/null; do
    sleep 0.5
  done
  # Store PID so stale locks can be detected
  echo $$ > "$LOCK_DIR/pid"
}

_release() {
  rm -rf "$LOCK_DIR"
}

# Clean up on exit (normal, error, or signal)
trap _release EXIT

_acquire
uv run train.py "$@"
