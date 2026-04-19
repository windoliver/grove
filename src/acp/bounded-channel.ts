export type Policy = "never" | "coalesce_text_deltas" | "drop_oldest_on_full";

export interface ChannelOptions<T> {
  capacity: number;
  classify: (event: T) => Policy;
  coalesceKey?: (event: T) => string | null;
  coalesce?: (existing: T, incoming: T) => T;
  invalidatesCoalesceKey?: (event: T) => string | null;
  onDrop?: (event: T, reason: "evicted" | "coalesced" | "no_capacity") => void;
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
  private pendingResolver: ((value: IteratorResult<T>) => void) | null = null;
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
      this.opts.onDrop?.(event, "no_capacity");
      return;
    }
    this._stats.pushed++;
    // Minimal: append-only. Policy logic added in later tasks.
    this._appendTail(event, this.opts.classify(event));
  }

  close(): void {
    this.closed = true;
    if (this.pendingResolver && this.size === 0) {
      const r = this.pendingResolver;
      this.pendingResolver = null;
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
          self.pendingResolver = resolve;
        });
      },
      async return(): Promise<IteratorResult<T>> {
        self.closed = true;
        return { value: undefined as unknown as T, done: true };
      },
    };
  }

  private _appendTail(event: T, policy: Policy): void {
    if (this.pendingResolver) {
      const r = this.pendingResolver;
      this.pendingResolver = null;
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
