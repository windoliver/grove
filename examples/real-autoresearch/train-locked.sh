#!/bin/bash
# train-locked.sh — Run training with flock serialization.
#
# On Apple Silicon, unified memory is shared between CPU and GPU.
# Only one training job should run at a time to avoid OOM.
# This wrapper uses flock to serialize concurrent training invocations.
#
# On GPU platforms (H100, A100), the lock is a no-op (can be disabled
# with GROVE_NO_TRAIN_LOCK=1).
#
# Usage:
#   ./train-locked.sh            # runs: uv run train.py
#   ./train-locked.sh --lr 1e-3  # passes args through to train.py

set -uo pipefail

LOCK_FILE="${GROVE_TRAIN_LOCK:-/tmp/grove-training.lock}"

if [ "${GROVE_NO_TRAIN_LOCK:-0}" = "1" ]; then
  exec uv run train.py "$@"
fi

exec flock "$LOCK_FILE" uv run train.py "$@"
