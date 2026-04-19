export type Policy = "never" | "coalesce_text_deltas" | "drop_oldest_on_full";

export interface ChannelOptions<T> {
  capacity: number;
  classify: (event: T) => Policy;
  coalesceKey?: (event: T) => string | null;
  coalesce?: (existing: T, incoming: T) => T;
  invalidatesCoalesceKey?: (event: T) => string | null;
  onDrop?: (event: T, reason: "evicted" | "coalesced" | "no_capacity" | "closed") => void;
}

export interface ChannelStats {
  pushed: number;
  coalesced: number;
  evicted: number;
  droppedByPolicy: Map<Policy, number>;
}

export class BoundedEventChannel<T> {
  private readonly opts: ChannelOptions<T>;
  private readonly buffer: (T | undefined)[];
  private readonly policyAt: (Policy | undefined)[];
  private head = 0;
  private tail = 0;
  private size = 0;
  private readonly coalesceTails = new Map<string, number>();
  /**
   * FIFO queue of pending `next()` resolvers. Although the channel is
   * documented as single-consumer, defensive consumers may issue concurrent
   * `next()` calls (e.g. a wrapper that prefetches one ahead). A single
   * resolver slot would silently overwrite earlier waiters and hang their
   * promises. The queue resolves in arrival order on push fast-path / close.
   */
  private readonly waitQueue: Array<(value: IteratorResult<T>) => void> = [];
  private closed = false;
  private readonly _stats: ChannelStats = {
    pushed: 0,
    coalesced: 0,
    evicted: 0,
    droppedByPolicy: new Map(),
  };
  private readonly unbounded: boolean;

  constructor(opts: ChannelOptions<T>) {
    this.opts = opts;
    this.unbounded = !Number.isFinite(opts.capacity);
    const initial = this.unbounded ? 16 : opts.capacity;
    this.buffer = new Array(initial);
    this.policyAt = new Array(initial);
  }

  push(event: T): void {
    if (this.closed) {
      this.opts.onDrop?.(event, "closed");
      return;
    }
    this._stats.pushed++;
    const policy = this.opts.classify(event);

    if (policy === "coalesce_text_deltas") {
      const key = this.opts.coalesceKey?.(event) ?? null;
      if (key !== null && this.coalesceTails.has(key) && this.opts.coalesce) {
        const idx = this.coalesceTails.get(key) as number;
        this.buffer[idx] = this.opts.coalesce(this.buffer[idx] as T, event);
        this._stats.coalesced++;
        this.opts.onDrop?.(event, "coalesced");
        return;
      }
      // No existing tail for this key → buffer as a new entry. A new chunked
      // delta is the *start* of a text run; losing it would drop the opening
      // of a sentence. Treat like never-policy when full: evict oldest
      // drop-eligible victim, or drop incoming if no victim exists. Without
      // this guard, _appendTail would overflow the bounded ring (size grows
      // past capacity, head/tail wrap mid-buffer, undefined emissions).
      if (!this.unbounded && this.size === this.buffer.length) {
        const victimIdx = this._findOldestDropEligibleIdx();
        if (victimIdx === -1) {
          const prev = this._stats.droppedByPolicy.get("coalesce_text_deltas") ?? 0;
          this._stats.droppedByPolicy.set("coalesce_text_deltas", prev + 1);
          this.opts.onDrop?.(event, "no_capacity");
          return;
        }
        const victim = this.buffer[victimIdx] as T;
        this._evictAt(victimIdx);
        this._stats.evicted++;
        this.opts.onDrop?.(victim, "evicted");
      }
      const tailIdxBefore = this.tail;
      this._appendTail(event, policy);
      // Only record tail if event was actually buffered (not fast-pathed).
      if (this.size > 0 && this.policyAt[tailIdxBefore] === policy && key !== null) {
        this.coalesceTails.set(key, tailIdxBefore);
      }
      return;
    }

    if (policy === "never") {
      const invKey = this.opts.invalidatesCoalesceKey?.(event) ?? null;

      if (!this.unbounded && this.size === this.buffer.length) {
        const victimIdx = this._findOldestDropEligibleIdx();
        if (victimIdx === -1) {
          // Incoming dropped — do NOT invalidate the coalesce tail. The
          // prior chunk is still in the buffer, and consumers will see it
          // continue to coalesce with subsequent chunks. Invalidating here
          // would orphan that tail and force every following chunk to seek
          // a fresh slot, multiplying text loss under sustained pressure.
          const prev = this._stats.droppedByPolicy.get("never") ?? 0;
          this._stats.droppedByPolicy.set("never", prev + 1);
          this.opts.onDrop?.(event, "no_capacity");
          return;
        }
        const victim = this.buffer[victimIdx] as T;
        this._evictAt(victimIdx);
        this._stats.evicted++;
        this.opts.onDrop?.(victim, "evicted");
      }
      this._appendTail(event, policy);
      // Event was either buffered or fast-path delivered — consumer will see
      // the terminal, so any prior coalesce tail is now semantically stale.
      if (invKey !== null) this.coalesceTails.delete(invKey);
      return;
    }

    if (policy === "drop_oldest_on_full") {
      if (!this.unbounded && this.size === this.buffer.length) {
        // Policy-aware victim selection: head may be a `never` event (e.g.
        // tool_call buffered earlier). Evicting it to make room for a low-
        // priority `raw`/`token_usage` would lose a semantic event. Walk
        // for an oldest drop-eligible slot instead. If none exists (every
        // slot is `never` or `coalesce`), drop the incoming low-priority
        // event to preserve bounded memory + semantic events.
        const victimIdx = this._findOldestDropEligibleIdx();
        if (victimIdx === -1) {
          const prev = this._stats.droppedByPolicy.get("drop_oldest_on_full") ?? 0;
          this._stats.droppedByPolicy.set("drop_oldest_on_full", prev + 1);
          this.opts.onDrop?.(event, "no_capacity");
          return;
        }
        const victim = this.buffer[victimIdx] as T;
        this._evictAt(victimIdx);
        this._stats.evicted++;
        this.opts.onDrop?.(victim, "evicted");
      }
      this._appendTail(event, policy);
      return;
    }
  }

  close(): void {
    this.closed = true;
    while (this.waitQueue.length > 0) {
      const r = this.waitQueue.shift() as (value: IteratorResult<T>) => void;
      r({ value: undefined as unknown as T, done: true });
    }
  }

  stats(): ChannelStats {
    return {
      pushed: this._stats.pushed,
      coalesced: this._stats.coalesced,
      evicted: this._stats.evicted,
      droppedByPolicy: new Map(this._stats.droppedByPolicy),
    };
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    const self = this;
    return {
      async next(): Promise<IteratorResult<T>> {
        if (self.size > 0) {
          const ev = self.buffer[self.head] as T;
          self.buffer[self.head] = undefined;
          self.policyAt[self.head] = undefined;
          for (const [k, idx] of self.coalesceTails) {
            if (idx === self.head) self.coalesceTails.delete(k);
          }
          self.head = (self.head + 1) % self.buffer.length;
          self.size--;
          return { value: ev, done: false };
        }
        if (self.closed) return { value: undefined as unknown as T, done: true };
        return new Promise<IteratorResult<T>>((resolve) => {
          self.waitQueue.push(resolve);
        });
      },
      async return(): Promise<IteratorResult<T>> {
        // return() is an abort signal (e.g. for-await break). Unlike close(),
        // which says "no more pushes, drain what's buffered", return() says
        // "consumer is gone, discard everything." Without this, a subsequent
        // next() (same iterator) or a fresh iterator on the same channel
        // would still see stale buffered events because next() checks
        // size > 0 before checking closed.
        self.closed = true;
        for (let i = 0; i < self.buffer.length; i++) {
          self.buffer[i] = undefined;
          self.policyAt[i] = undefined;
        }
        self.head = 0;
        self.tail = 0;
        self.size = 0;
        self.coalesceTails.clear();
        while (self.waitQueue.length > 0) {
          const r = self.waitQueue.shift() as (value: IteratorResult<T>) => void;
          r({ value: undefined as unknown as T, done: true });
        }
        return { value: undefined as unknown as T, done: true };
      },
    };
  }

  private _appendTail(event: T, policy: Policy): void {
    if (this.waitQueue.length > 0) {
      const r = this.waitQueue.shift() as (value: IteratorResult<T>) => void;
      r({ value: event, done: false });
      return;
    }
    if (this.unbounded && this.size === this.buffer.length) {
      this._grow();
    }
    this.buffer[this.tail] = event;
    this.policyAt[this.tail] = policy;
    this.tail = (this.tail + 1) % this.buffer.length;
    this.size++;
  }

  private _findOldestDropEligibleIdx(): number {
    const cap = this.buffer.length;
    for (let i = 0; i < this.size; i++) {
      const idx = (this.head + i) % cap;
      if (this.policyAt[idx] === "drop_oldest_on_full") return idx;
    }
    return -1;
  }

  private _evictAt(idx: number): void {
    this.buffer[idx] = undefined;
    this.policyAt[idx] = undefined;
    for (const [k, i] of this.coalesceTails) {
      if (i === idx) this.coalesceTails.delete(k);
    }
    if (idx === this.head) {
      this.head = (this.head + 1) % this.buffer.length;
      this.size--;
      return;
    }
    const cap = this.buffer.length;
    let cur = idx;
    while (true) {
      const next = (cur + 1) % cap;
      if (next === this.tail) break;
      this.buffer[cur] = this.buffer[next];
      this.policyAt[cur] = this.policyAt[next];
      for (const [k, i] of this.coalesceTails) {
        if (i === next) this.coalesceTails.set(k, cur);
      }
      cur = next;
    }
    this.tail = (this.tail - 1 + cap) % cap;
    this.buffer[this.tail] = undefined;
    this.policyAt[this.tail] = undefined;
    this.size--;
  }

  private _grow(): void {
    const oldCap = this.buffer.length;
    const newCap = oldCap * 2;
    const newBuf: (T | undefined)[] = new Array(newCap);
    const newPol: (Policy | undefined)[] = new Array(newCap);
    for (let i = 0; i < this.size; i++) {
      const idx = (this.head + i) % oldCap;
      newBuf[i] = this.buffer[idx];
      newPol[i] = this.policyAt[idx];
    }
    this.buffer.length = 0;
    this.policyAt.length = 0;
    for (let i = 0; i < newCap; i++) {
      this.buffer.push(newBuf[i]);
      this.policyAt.push(newPol[i]);
    }
    this.head = 0;
    this.tail = this.size;
    this.coalesceTails.clear();
  }
}
