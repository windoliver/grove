#!/bin/bash
# setup-mac.sh — One-time setup for Apple Silicon (MLX) autoresearch.
#
# Installs dependencies and prepares the autoresearch-mlx repo.
# Idempotent — safe to run multiple times.
#
# Usage:
#   ./examples/real-autoresearch/setup-mac.sh [--autoresearch-dir /path/to/autoresearch-mlx]

set -uo pipefail

AUTORESEARCH_DIR="${1:-${AUTORESEARCH_DIR:-../autoresearch-mlx}}"

echo "=== Apple Silicon (MLX) Setup ==="
echo "autoresearch-mlx dir: $AUTORESEARCH_DIR"
echo ""

# --- System dependencies ---

echo "Checking system dependencies..."

if ! command -v uv >/dev/null 2>&1; then
  echo "Installing uv..."
  curl -LsSf https://astral.sh/uv/install.sh | sh
  # Source the env so uv is available in this session
  # shellcheck disable=SC1091
  [ -f "$HOME/.local/bin/env" ] && source "$HOME/.local/bin/env"
else
  echo "  uv: $(uv --version)"
fi

if ! command -v bun >/dev/null 2>&1; then
  echo "Installing bun..."
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
else
  echo "  bun: $(bun --version)"
fi

if ! command -v acpx >/dev/null 2>&1; then
  echo "Installing acpx..."
  npm install -g acpx@latest
else
  echo "  acpx: $(acpx --version 2>/dev/null || echo 'installed')"
fi

echo ""

# --- autoresearch-mlx ---

if [ -d "$AUTORESEARCH_DIR" ]; then
  echo "autoresearch-mlx already cloned at $AUTORESEARCH_DIR"
else
  echo "Cloning autoresearch-mlx..."
  git clone https://github.com/trevin-creator/autoresearch-mlx "$AUTORESEARCH_DIR"
fi

echo "Syncing Python dependencies..."
(cd "$AUTORESEARCH_DIR" && uv sync)

# --- Prepare training data ---

if [ -d "$AUTORESEARCH_DIR/data" ] && [ "$(ls -A "$AUTORESEARCH_DIR/data" 2>/dev/null)" ]; then
  echo "Training data already prepared."
else
  echo "Preparing training data (one-time, ~2 min)..."
  (cd "$AUTORESEARCH_DIR" && uv run prepare.py)
fi

echo ""

# --- Grove ---

GROVE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [ ! -f "$GROVE_DIR/dist/cli/main.js" ]; then
  echo "Building grove..."
  (cd "$GROVE_DIR" && bun install && bun run build)
else
  echo "Grove already built."
fi

echo ""

# --- Verification ---

echo "=== Verification ==="
local_ok=1

if command -v uv >/dev/null 2>&1; then echo "  uv:    OK"; else echo "  uv:    MISSING"; local_ok=0; fi
if command -v bun >/dev/null 2>&1; then echo "  bun:   OK"; else echo "  bun:   MISSING"; local_ok=0; fi
if command -v acpx >/dev/null 2>&1; then echo "  acpx:  OK"; else echo "  acpx:  MISSING"; local_ok=0; fi
if [ -f "$GROVE_DIR/dist/cli/main.js" ]; then echo "  grove: OK"; else echo "  grove: NOT BUILT"; local_ok=0; fi
if [ -d "$AUTORESEARCH_DIR" ]; then echo "  repo:  OK ($AUTORESEARCH_DIR)"; else echo "  repo:  MISSING"; local_ok=0; fi
if [ -d "$AUTORESEARCH_DIR/data" ]; then echo "  data:  OK"; else echo "  data:  NOT PREPARED"; local_ok=0; fi

echo ""
if [ "$local_ok" -eq 1 ]; then
  echo "Setup complete. Ready to run:"
  echo "  cd $AUTORESEARCH_DIR"
  echo "  NEXUS_PORT=1001 ../grove/examples/real-autoresearch/launch.sh"
else
  echo "Setup incomplete — fix the issues above and re-run."
  exit 1
fi
