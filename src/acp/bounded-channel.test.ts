import { expect, test } from "bun:test";
import { BoundedEventChannel, type Policy } from "./bounded-channel.js";

interface TestEvent {
  kind: "drop" | "keep" | "delta_a" | "delta_b" | "terminal_a";
  text?: string;
  id: number;
}

function classify(e: TestEvent): Policy {
  if (e.kind === "keep" || e.kind === "terminal_a") return "never";
  if (e.kind === "delta_a" || e.kind === "delta_b") return "coalesce_text_deltas";
  return "drop_oldest_on_full";
}

function coalesceKey(e: TestEvent): string | null {
  if (e.kind === "delta_a" || e.kind === "delta_b") return e.kind;
  return null;
}

function coalesce(existing: TestEvent, incoming: TestEvent): TestEvent {
  return { ...existing, text: (existing.text ?? "") + (incoming.text ?? "") };
}

function invalidatesCoalesceKey(e: TestEvent): string | null {
  if (e.kind === "terminal_a") return "delta_a";
  return null;
}

function makeChannel(capacity = 4) {
  return new BoundedEventChannel<TestEvent>({
    capacity,
    classify,
    coalesceKey,
    coalesce,
    invalidatesCoalesceKey,
  });
}

test("push 3 then drain returns 3 in FIFO order", async () => {
  const ch = makeChannel();
  ch.push({ kind: "drop", id: 1 });
  ch.push({ kind: "drop", id: 2 });
  ch.push({ kind: "drop", id: 3 });
  ch.close();
  const got: TestEvent[] = [];
  for await (const e of ch) got.push(e);
  expect(got.map((e) => e.id)).toEqual([1, 2, 3]);
});
