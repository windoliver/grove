#!/usr/bin/env python3
"""Mock training script for CI/testing — no GPU required.

Simulates a 2-second training run and outputs synthetic metrics
in the same format as autoresearch's train.py.

Usage:
    uv run test/mock-train.py
    uv run test/mock-train.py --crash          # simulate a crash
    uv run test/mock-train.py --nan            # simulate diverged training
    uv run test/mock-train.py --val-bpb 0.95   # override val_bpb
"""

import argparse
import random
import sys
import time


def main():
    parser = argparse.ArgumentParser(description="Mock training for grove testing")
    parser.add_argument("--crash", action="store_true", help="Simulate a crash")
    parser.add_argument("--nan", action="store_true", help="Simulate NaN val_bpb")
    parser.add_argument("--val-bpb", type=float, default=None, help="Override val_bpb")
    parser.add_argument("--delay", type=float, default=2.0, help="Simulated training time (seconds)")
    args = parser.parse_args()

    print("Starting training...")
    print(f"  device: mock-cpu")
    print(f"  batch_size: 64")
    print(f"  lr: 3e-4")

    time.sleep(args.delay)

    if args.crash:
        print("CUDA error: out of memory", file=sys.stderr)
        sys.exit(1)

    if args.nan:
        val_bpb = float("nan")
    elif args.val_bpb is not None:
        val_bpb = args.val_bpb
    else:
        # Random improvement in realistic range
        val_bpb = round(random.uniform(0.90, 1.10), 4)

    peak_vram = round(random.uniform(0.05, 0.15), 2)

    print(f"\nTraining complete.")
    print(f"  val_bpb: {val_bpb}")
    print(f"  peak_vram_gb: {peak_vram}")
    print(f"  steps: 150")
    print(f"  wall_time: {args.delay:.1f}s")


if __name__ == "__main__":
    main()
