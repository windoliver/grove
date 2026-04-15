/**
 * Tests for the handoff delivery state machine.
 *
 * Exhaustively tests canTransition() for all valid and invalid transitions.
 * Test-driven: these tests define the contract before implementation details.
 */

import { describe, expect, test } from "bun:test";
import { HandoffStatus, canTransition } from "./handoff.js";

const { PendingPickup, Delivered, Processed, Replied, Expired, DeadLettered } = HandoffStatus;

describe("canTransition", () => {
  // --- Happy path ---

  test("pending_pickup → delivered (IPC delivery confirmed)", () => {
    expect(canTransition(PendingPickup, Delivered)).toBe(true);
  });

  test("delivered → processed (agent acknowledged receipt)", () => {
    expect(canTransition(Delivered, Processed)).toBe(true);
  });

  test("processed → replied (agent produced response contribution)", () => {
    expect(canTransition(Processed, Replied)).toBe(true);
  });

  // --- Shortcut: delivered → replied (skip processed) ---

  test("delivered → replied (direct reply without explicit processing ACK)", () => {
    expect(canTransition(Delivered, Replied)).toBe(true);
  });

  // --- Failure paths ---

  test("pending_pickup → dead_lettered (IPC delivery failed after retries)", () => {
    expect(canTransition(PendingPickup, DeadLettered)).toBe(true);
  });

  test("pending_pickup → expired (TTL expired before delivery)", () => {
    expect(canTransition(PendingPickup, Expired)).toBe(true);
  });

  test("delivered → expired (agent didn't reply within deadline)", () => {
    expect(canTransition(Delivered, Expired)).toBe(true);
  });

  test("delivered → dead_lettered (post-delivery IPC failure)", () => {
    expect(canTransition(Delivered, DeadLettered)).toBe(true);
  });

  test("processed → expired (agent processing but didn't reply in time)", () => {
    expect(canTransition(Processed, Expired)).toBe(true);
  });

  // --- Terminal states: no outgoing transitions ---

  test("replied is terminal — cannot transition to anything", () => {
    expect(canTransition(Replied, PendingPickup)).toBe(false);
    expect(canTransition(Replied, Delivered)).toBe(false);
    expect(canTransition(Replied, Processed)).toBe(false);
    expect(canTransition(Replied, Expired)).toBe(false);
    expect(canTransition(Replied, DeadLettered)).toBe(false);
  });

  test("expired is terminal — cannot transition to anything", () => {
    expect(canTransition(Expired, PendingPickup)).toBe(false);
    expect(canTransition(Expired, Delivered)).toBe(false);
    expect(canTransition(Expired, Processed)).toBe(false);
    expect(canTransition(Expired, Replied)).toBe(false);
    expect(canTransition(Expired, DeadLettered)).toBe(false);
  });

  test("dead_lettered is terminal — cannot transition to anything", () => {
    expect(canTransition(DeadLettered, PendingPickup)).toBe(false);
    expect(canTransition(DeadLettered, Delivered)).toBe(false);
    expect(canTransition(DeadLettered, Processed)).toBe(false);
    expect(canTransition(DeadLettered, Replied)).toBe(false);
    expect(canTransition(DeadLettered, Expired)).toBe(false);
  });

  // --- Invalid transitions ---

  test("self-loops are invalid", () => {
    expect(canTransition(PendingPickup, PendingPickup)).toBe(false);
    expect(canTransition(Delivered, Delivered)).toBe(false);
    expect(canTransition(Processed, Processed)).toBe(false);
    expect(canTransition(Replied, Replied)).toBe(false);
    expect(canTransition(Expired, Expired)).toBe(false);
    expect(canTransition(DeadLettered, DeadLettered)).toBe(false);
  });

  test("cannot skip forward: pending_pickup → processed (must go through delivered)", () => {
    expect(canTransition(PendingPickup, Processed)).toBe(false);
  });

  test("cannot skip forward: pending_pickup → replied (must go through delivered)", () => {
    expect(canTransition(PendingPickup, Replied)).toBe(false);
  });

  test("cannot go backward: delivered → pending_pickup", () => {
    expect(canTransition(Delivered, PendingPickup)).toBe(false);
  });

  test("cannot go backward: processed → delivered", () => {
    expect(canTransition(Processed, Delivered)).toBe(false);
  });

  test("cannot go backward: processed → pending_pickup", () => {
    expect(canTransition(Processed, PendingPickup)).toBe(false);
  });

  test("processed → dead_lettered is invalid (already past delivery)", () => {
    expect(canTransition(Processed, DeadLettered)).toBe(false);
  });
});

describe("HandoffStatus enum values", () => {
  test("all expected statuses are defined", () => {
    expect(HandoffStatus.PendingPickup).toBe("pending_pickup");
    expect(HandoffStatus.Delivered).toBe("delivered");
    expect(HandoffStatus.Processed).toBe("processed");
    expect(HandoffStatus.Replied).toBe("replied");
    expect(HandoffStatus.Expired).toBe("expired");
    expect(HandoffStatus.DeadLettered).toBe("dead_lettered");
  });

  test("enum has exactly 6 values", () => {
    expect(Object.keys(HandoffStatus)).toHaveLength(6);
  });
});
