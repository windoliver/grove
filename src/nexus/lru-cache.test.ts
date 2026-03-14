import { describe, expect, test } from "bun:test";

import { LruCache } from "./lru-cache.js";

describe("LruCache", () => {
  test("get returns undefined for a missing key", () => {
    const cache = new LruCache<number>(5);
    expect(cache.get("missing")).toBeUndefined();
  });

  test("set and get round-trip a value", () => {
    const cache = new LruCache<string>(5);
    cache.set("a", "alpha");
    expect(cache.get("a")).toBe("alpha");
  });

  test("size reflects the number of entries", () => {
    const cache = new LruCache<number>(10);
    expect(cache.size).toBe(0);
    cache.set("a", 1);
    expect(cache.size).toBe(1);
    cache.set("b", 2);
    expect(cache.size).toBe(2);
  });

  test("evicts the least recently used entry when capacity is exceeded", () => {
    const cache = new LruCache<number>(3);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    // Cache is full: [a, b, c]
    cache.set("d", 4);
    // "a" should have been evicted
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(2);
    expect(cache.get("c")).toBe(3);
    expect(cache.get("d")).toBe(4);
    expect(cache.size).toBe(3);
  });

  test("get promotes an entry to most recently used", () => {
    const cache = new LruCache<number>(3);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    // Access "a" to promote it
    cache.get("a");
    // Now LRU order is [b, c, a]; inserting "d" should evict "b"
    cache.set("d", 4);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe(1);
    expect(cache.get("c")).toBe(3);
    expect(cache.get("d")).toBe(4);
  });

  test("set with an existing key updates value and promotes it", () => {
    const cache = new LruCache<string>(3);
    cache.set("a", "old");
    cache.set("b", "B");
    cache.set("c", "C");
    // Update "a" — should move to most recent position
    cache.set("a", "new");
    expect(cache.get("a")).toBe("new");
    // LRU order is now [b, c, a]; adding "d" should evict "b"
    cache.set("d", "D");
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe("new");
    expect(cache.size).toBe(3);
  });

  test("delete removes an entry and returns true", () => {
    const cache = new LruCache<number>(5);
    cache.set("x", 10);
    expect(cache.delete("x")).toBe(true);
    expect(cache.get("x")).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  test("delete returns false for a non-existent key", () => {
    const cache = new LruCache<number>(5);
    expect(cache.delete("nope")).toBe(false);
  });

  test("clear removes all entries", () => {
    const cache = new LruCache<number>(5);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("c")).toBeUndefined();
  });

  test("cache with maxSize 1 keeps only the latest entry", () => {
    const cache = new LruCache<number>(1);
    cache.set("a", 1);
    expect(cache.get("a")).toBe(1);
    cache.set("b", 2);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(2);
    expect(cache.size).toBe(1);
  });

  test("overwriting does not increase size", () => {
    const cache = new LruCache<number>(3);
    cache.set("a", 1);
    cache.set("a", 2);
    cache.set("a", 3);
    expect(cache.size).toBe(1);
    expect(cache.get("a")).toBe(3);
  });

  test("eviction order respects get-based promotion", () => {
    const cache = new LruCache<number>(4);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    cache.set("d", 4);
    // Access in reverse to invert the LRU order
    cache.get("a"); // promote a
    cache.get("b"); // promote b
    // LRU order is now: [c, d, a, b]
    cache.set("e", 5); // evicts "c"
    cache.set("f", 6); // evicts "d"

    expect(cache.get("c")).toBeUndefined();
    expect(cache.get("d")).toBeUndefined();
    expect(cache.get("a")).toBe(1);
    expect(cache.get("b")).toBe(2);
    expect(cache.get("e")).toBe(5);
    expect(cache.get("f")).toBe(6);
  });

  test("works with complex object values", () => {
    interface Payload {
      id: number;
      data: string[];
    }
    const cache = new LruCache<Payload>(2);
    cache.set("item1", { id: 1, data: ["a", "b"] });
    cache.set("item2", { id: 2, data: ["c"] });
    expect(cache.get("item1")).toEqual({ id: 1, data: ["a", "b"] });
    expect(cache.get("item2")).toEqual({ id: 2, data: ["c"] });
  });

  test("delete frees a slot — does not trigger eviction on next set", () => {
    const cache = new LruCache<number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.delete("a");
    // Slot freed; adding "c" should not evict "b"
    cache.set("c", 3);
    expect(cache.get("b")).toBe(2);
    expect(cache.get("c")).toBe(3);
    expect(cache.size).toBe(2);
  });

  test("handles many insertions and evictions gracefully", () => {
    const cache = new LruCache<number>(10);
    for (let i = 0; i < 1000; i++) {
      cache.set(`key-${i}`, i);
    }
    // Only the last 10 entries should remain
    expect(cache.size).toBe(10);
    for (let i = 990; i < 1000; i++) {
      expect(cache.get(`key-${i}`)).toBe(i);
    }
    for (let i = 0; i < 990; i++) {
      expect(cache.get(`key-${i}`)).toBeUndefined();
    }
  });

  test("get on a missing key does not affect size or ordering", () => {
    const cache = new LruCache<number>(3);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    // Access a non-existent key
    cache.get("zzz");
    expect(cache.size).toBe(3);
    // LRU order should be unchanged: [a, b, c]
    cache.set("d", 4); // evicts "a"
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(2);
  });

  test("set after clear works correctly", () => {
    const cache = new LruCache<string>(2);
    cache.set("a", "1");
    cache.set("b", "2");
    cache.clear();
    cache.set("c", "3");
    expect(cache.size).toBe(1);
    expect(cache.get("c")).toBe("3");
    expect(cache.get("a")).toBeUndefined();
  });
});
