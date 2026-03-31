/**
 * Fixed-capacity ring buffer with O(1) push and O(1) random access.
 *
 * Used by AgentLogBuffer to retain the last N log lines per agent
 * without array shifting or unbounded growth.
 *
 * When full, the oldest item is evicted on push.
 * slice() returns a contiguous view — handles the internal wrap transparently.
 */

export class RingBuffer<T> {
  private readonly buffer: (T | undefined)[];
  private head = 0;
  private _size = 0;
  readonly capacity: number;

  constructor(capacity: number) {
    if (capacity <= 0) {
      throw new Error(`RingBuffer capacity must be > 0, got ${capacity}`);
    }
    this.capacity = capacity;
    this.buffer = new Array<T | undefined>(capacity);
  }

  /** Number of items currently in the buffer. */
  get size(): number {
    return this._size;
  }

  /** Whether the buffer is empty. */
  get isEmpty(): boolean {
    return this._size === 0;
  }

  /** Add an item. If at capacity, evicts the oldest item. O(1). */
  push(item: T): void {
    const index = (this.head + this._size) % this.capacity;
    this.buffer[index] = item;
    if (this._size < this.capacity) {
      this._size++;
    } else {
      // Buffer is full — advance head to evict oldest
      this.head = (this.head + 1) % this.capacity;
    }
  }

  /**
   * Get an item by logical index (0 = oldest retained item).
   * Returns undefined if index is out of bounds. O(1).
   */
  get(index: number): T | undefined {
    if (index < 0 || index >= this._size) return undefined;
    return this.buffer[(this.head + index) % this.capacity];
  }

  /**
   * Return a slice of items from logical index `start` (inclusive)
   * to `end` (exclusive). Handles wrap boundary transparently.
   *
   * Negative start is clamped to 0. End beyond size is clamped.
   * Returns empty array if start >= end.
   */
  slice(start: number, end: number): T[] {
    const s = Math.max(0, start);
    const e = Math.min(end, this._size);
    if (s >= e) return [];

    const result = new Array<T>(e - s);
    for (let i = 0; i < e - s; i++) {
      result[i] = this.buffer[(this.head + s + i) % this.capacity] as T;
    }
    return result;
  }

  /** Return all items as an array (oldest first). */
  toArray(): T[] {
    return this.slice(0, this._size);
  }

  /** Remove all items, resetting the buffer to empty. */
  clear(): void {
    this.head = 0;
    this._size = 0;
    // Don't bother nulling slots — they'll be overwritten on push
  }
}
