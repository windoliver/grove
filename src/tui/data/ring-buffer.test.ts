/**
 * TDD tests for RingBuffer<T>.
 *
 * Written BEFORE the implementation — edge cases at the wrap boundary
 * are the primary concern.
 */

import { describe, expect, test } from "bun:test";
import { RingBuffer } from "./ring-buffer.js";

// ===========================================================================
// Construction
// ===========================================================================

describe("RingBuffer construction", () => {
  test("creates empty buffer with given capacity", () => {
    const buf = new RingBuffer<string>(10);
    expect(buf.size).toBe(0);
    expect(buf.capacity).toBe(10);
    expect(buf.isEmpty).toBe(true);
  });

  test("capacity of 1 is valid", () => {
    const buf = new RingBuffer<number>(1);
    expect(buf.capacity).toBe(1);
    expect(buf.size).toBe(0);
  });

  test("throws on capacity <= 0", () => {
    expect(() => new RingBuffer(0)).toThrow();
    expect(() => new RingBuffer(-1)).toThrow();
  });
});

// ===========================================================================
// Push + size
// ===========================================================================

describe("push and size", () => {
  test("push increases size up to capacity", () => {
    const buf = new RingBuffer<number>(3);
    buf.push(1);
    expect(buf.size).toBe(1);
    buf.push(2);
    expect(buf.size).toBe(2);
    buf.push(3);
    expect(buf.size).toBe(3);
  });

  test("push beyond capacity evicts oldest, size stays at capacity", () => {
    const buf = new RingBuffer<number>(3);
    buf.push(1);
    buf.push(2);
    buf.push(3);
    buf.push(4); // evicts 1
    expect(buf.size).toBe(3);
  });

  test("push many items beyond capacity maintains correct size", () => {
    const buf = new RingBuffer<number>(5);
    for (let i = 0; i < 100; i++) {
      buf.push(i);
    }
    expect(buf.size).toBe(5);
  });

  test("isEmpty is false after push", () => {
    const buf = new RingBuffer<string>(5);
    buf.push("a");
    expect(buf.isEmpty).toBe(false);
  });
});

// ===========================================================================
// get (by logical index)
// ===========================================================================

describe("get", () => {
  test("get returns items in insertion order", () => {
    const buf = new RingBuffer<string>(5);
    buf.push("a");
    buf.push("b");
    buf.push("c");
    expect(buf.get(0)).toBe("a");
    expect(buf.get(1)).toBe("b");
    expect(buf.get(2)).toBe("c");
  });

  test("get after wrap returns items in correct order (oldest first)", () => {
    const buf = new RingBuffer<number>(3);
    buf.push(1);
    buf.push(2);
    buf.push(3);
    buf.push(4); // evicts 1 → [2, 3, 4]
    expect(buf.get(0)).toBe(2);
    expect(buf.get(1)).toBe(3);
    expect(buf.get(2)).toBe(4);
  });

  test("get with out-of-bounds index returns undefined", () => {
    const buf = new RingBuffer<number>(3);
    buf.push(1);
    expect(buf.get(-1)).toBeUndefined();
    expect(buf.get(1)).toBeUndefined();
    expect(buf.get(100)).toBeUndefined();
  });

  test("get on empty buffer returns undefined", () => {
    const buf = new RingBuffer<number>(5);
    expect(buf.get(0)).toBeUndefined();
  });

  test("get after multiple wraps returns correct values", () => {
    const buf = new RingBuffer<number>(3);
    // Push 1..9, buffer should contain [7, 8, 9]
    for (let i = 1; i <= 9; i++) {
      buf.push(i);
    }
    expect(buf.get(0)).toBe(7);
    expect(buf.get(1)).toBe(8);
    expect(buf.get(2)).toBe(9);
  });
});

// ===========================================================================
// slice
// ===========================================================================

describe("slice", () => {
  test("slice returns a range of items", () => {
    const buf = new RingBuffer<string>(10);
    buf.push("a");
    buf.push("b");
    buf.push("c");
    buf.push("d");
    expect(buf.slice(1, 3)).toEqual(["b", "c"]);
  });

  test("slice across wrap boundary returns correct items", () => {
    const buf = new RingBuffer<number>(4);
    // Push 1..6 → buffer contains [3, 4, 5, 6], head wraps
    for (let i = 1; i <= 6; i++) {
      buf.push(i);
    }
    expect(buf.slice(0, 4)).toEqual([3, 4, 5, 6]);
    expect(buf.slice(1, 3)).toEqual([4, 5]);
  });

  test("slice with start=0, end=size returns all items", () => {
    const buf = new RingBuffer<number>(3);
    buf.push(10);
    buf.push(20);
    buf.push(30);
    expect(buf.slice(0, 3)).toEqual([10, 20, 30]);
  });

  test("slice with end beyond size is clamped", () => {
    const buf = new RingBuffer<number>(5);
    buf.push(1);
    buf.push(2);
    expect(buf.slice(0, 100)).toEqual([1, 2]);
  });

  test("slice with start >= end returns empty", () => {
    const buf = new RingBuffer<number>(5);
    buf.push(1);
    buf.push(2);
    expect(buf.slice(2, 2)).toEqual([]);
    expect(buf.slice(3, 1)).toEqual([]);
  });

  test("slice with negative start is treated as 0", () => {
    const buf = new RingBuffer<number>(5);
    buf.push(1);
    buf.push(2);
    expect(buf.slice(-1, 2)).toEqual([1, 2]);
  });

  test("slice on empty buffer returns empty", () => {
    const buf = new RingBuffer<number>(5);
    expect(buf.slice(0, 5)).toEqual([]);
  });

  test("slice viewport window from end (tail pattern)", () => {
    const buf = new RingBuffer<number>(100);
    for (let i = 0; i < 100; i++) {
      buf.push(i);
    }
    // Viewport: last 30 lines
    const viewport = buf.slice(buf.size - 30, buf.size);
    expect(viewport.length).toBe(30);
    expect(viewport[0]).toBe(70);
    expect(viewport[29]).toBe(99);
  });

  test("slice viewport with scroll offset from end", () => {
    const buf = new RingBuffer<number>(100);
    for (let i = 0; i < 100; i++) {
      buf.push(i);
    }
    // Scrolled up 10 lines, viewport=30
    const offset = 10;
    const viewportSize = 30;
    const end = buf.size - offset;
    const start = end - viewportSize;
    const viewport = buf.slice(start, end);
    expect(viewport.length).toBe(30);
    expect(viewport[0]).toBe(60);
    expect(viewport[29]).toBe(89);
  });
});

// ===========================================================================
// Capacity = 1 (edge case)
// ===========================================================================

describe("capacity = 1", () => {
  test("holds one item at a time", () => {
    const buf = new RingBuffer<string>(1);
    buf.push("a");
    expect(buf.size).toBe(1);
    expect(buf.get(0)).toBe("a");

    buf.push("b"); // evicts "a"
    expect(buf.size).toBe(1);
    expect(buf.get(0)).toBe("b");
  });

  test("slice on capacity-1 buffer", () => {
    const buf = new RingBuffer<string>(1);
    buf.push("x");
    expect(buf.slice(0, 1)).toEqual(["x"]);
  });
});

// ===========================================================================
// Large buffer (realistic scale)
// ===========================================================================

describe("large buffer (10K items)", () => {
  test("push 10K items into 10K buffer — all retained", () => {
    const buf = new RingBuffer<number>(10_000);
    for (let i = 0; i < 10_000; i++) {
      buf.push(i);
    }
    expect(buf.size).toBe(10_000);
    expect(buf.get(0)).toBe(0);
    expect(buf.get(9_999)).toBe(9_999);
  });

  test("push 20K items into 10K buffer — oldest 10K evicted", () => {
    const buf = new RingBuffer<number>(10_000);
    for (let i = 0; i < 20_000; i++) {
      buf.push(i);
    }
    expect(buf.size).toBe(10_000);
    expect(buf.get(0)).toBe(10_000);
    expect(buf.get(9_999)).toBe(19_999);
  });

  test("slice viewport from large buffer is fast", () => {
    const buf = new RingBuffer<number>(10_000);
    for (let i = 0; i < 10_000; i++) {
      buf.push(i);
    }
    const start = performance.now();
    for (let i = 0; i < 1000; i++) {
      buf.slice(buf.size - 30, buf.size);
    }
    const elapsed = performance.now() - start;
    // 1000 viewport slices should complete in < 50ms
    expect(elapsed).toBeLessThan(50);
  });
});

// ===========================================================================
// clear
// ===========================================================================

describe("clear", () => {
  test("clear resets buffer to empty", () => {
    const buf = new RingBuffer<number>(5);
    buf.push(1);
    buf.push(2);
    buf.push(3);
    buf.clear();
    expect(buf.size).toBe(0);
    expect(buf.isEmpty).toBe(true);
    expect(buf.get(0)).toBeUndefined();
  });

  test("buffer is reusable after clear", () => {
    const buf = new RingBuffer<number>(3);
    buf.push(1);
    buf.push(2);
    buf.push(3);
    buf.clear();
    buf.push(10);
    buf.push(20);
    expect(buf.size).toBe(2);
    expect(buf.get(0)).toBe(10);
    expect(buf.get(1)).toBe(20);
  });
});

// ===========================================================================
// toArray
// ===========================================================================

describe("toArray", () => {
  test("returns all items in order", () => {
    const buf = new RingBuffer<number>(5);
    buf.push(1);
    buf.push(2);
    buf.push(3);
    expect(buf.toArray()).toEqual([1, 2, 3]);
  });

  test("returns all items after wrap", () => {
    const buf = new RingBuffer<number>(3);
    for (let i = 1; i <= 5; i++) {
      buf.push(i);
    }
    expect(buf.toArray()).toEqual([3, 4, 5]);
  });

  test("returns empty array for empty buffer", () => {
    const buf = new RingBuffer<number>(5);
    expect(buf.toArray()).toEqual([]);
  });
});
