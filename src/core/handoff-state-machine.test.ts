/**
 * Tests for the handoff delivery state machine.
 *
 * Exhaustively tests canTransition() for all valid and invalid transitions.
 * Test-driven: these tests define the contract before implementation details.
 */

import { describe, expect, test } from "bun:test";
import { canTransition, HandoffStatus } from "./handoff.js";

const {
  PendingPickup,
  Delivered,
  Processed,
  Replied,
  Expired,
  DeadLettered,
  Cancelled,
  ManuallyResolved,
} = HandoffStatus;

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

  // --- Operator terminal paths ---

  test("unresolved and failed handoffs can be cancelled by an operator", () => {
    expect(canTransition(PendingPickup, Cancelled)).toBe(true);
    expect(canTransition(Delivered, Cancelled)).toBe(true);
    expect(canTransition(Processed, Cancelled)).toBe(true);
    expect(canTransition(Expired, Cancelled)).toBe(true);
    expect(canTransition(DeadLettered, Cancelled)).toBe(true);
  });

  test("unresolved and failed handoffs can be manually resolved by an operator", () => {
    expect(canTransition(PendingPickup, ManuallyResolved)).toBe(true);
    expect(canTransition(Delivered, ManuallyResolved)).toBe(true);
    expect(canTransition(Processed, ManuallyResolved)).toBe(true);
    expect(canTransition(Expired, ManuallyResolved)).toBe(true);
    expect(canTransition(DeadLettered, ManuallyResolved)).toBe(true);
  });

  // --- Terminal states ---

  test("replied is terminal — cannot transition to anything", () => {
    expect(canTransition(Replied, PendingPickup)).toBe(false);
    expect(canTransition(Replied, Delivered)).toBe(false);
    expect(canTransition(Replied, Processed)).toBe(false);
    expect(canTransition(Replied, Expired)).toBe(false);
    expect(canTransition(Replied, DeadLettered)).toBe(false);
    expect(canTransition(Replied, Cancelled)).toBe(false);
    expect(canTransition(Replied, ManuallyResolved)).toBe(false);
  });

  test("expired can only transition to operator terminal statuses", () => {
    expect(canTransition(Expired, PendingPickup)).toBe(false);
    expect(canTransition(Expired, Delivered)).toBe(false);
    expect(canTransition(Expired, Processed)).toBe(false);
    expect(canTransition(Expired, Replied)).toBe(false);
    expect(canTransition(Expired, DeadLettered)).toBe(false);
    expect(canTransition(Expired, Cancelled)).toBe(true);
    expect(canTransition(Expired, ManuallyResolved)).toBe(true);
  });

  test("dead_lettered can only transition to operator terminal statuses", () => {
    expect(canTransition(DeadLettered, PendingPickup)).toBe(false);
    expect(canTransition(DeadLettered, Delivered)).toBe(false);
    expect(canTransition(DeadLettered, Processed)).toBe(false);
    expect(canTransition(DeadLettered, Replied)).toBe(false);
    expect(canTransition(DeadLettered, Expired)).toBe(false);
    expect(canTransition(DeadLettered, Cancelled)).toBe(true);
    expect(canTransition(DeadLettered, ManuallyResolved)).toBe(true);
  });

  test("cancelled is terminal", () => {
    expect(canTransition(Cancelled, PendingPickup)).toBe(false);
    expect(canTransition(Cancelled, Delivered)).toBe(false);
    expect(canTransition(Cancelled, Processed)).toBe(false);
    expect(canTransition(Cancelled, Replied)).toBe(false);
    expect(canTransition(Cancelled, Expired)).toBe(false);
    expect(canTransition(Cancelled, DeadLettered)).toBe(false);
    expect(canTransition(Cancelled, ManuallyResolved)).toBe(false);
  });

  test("manually_resolved is terminal", () => {
    expect(canTransition(ManuallyResolved, PendingPickup)).toBe(false);
    expect(canTransition(ManuallyResolved, Delivered)).toBe(false);
    expect(canTransition(ManuallyResolved, Processed)).toBe(false);
    expect(canTransition(ManuallyResolved, Replied)).toBe(false);
    expect(canTransition(ManuallyResolved, Expired)).toBe(false);
    expect(canTransition(ManuallyResolved, DeadLettered)).toBe(false);
    expect(canTransition(ManuallyResolved, Cancelled)).toBe(false);
  });

  // --- Invalid transitions ---

  test("self-loops are invalid", () => {
    expect(canTransition(PendingPickup, PendingPickup)).toBe(false);
    expect(canTransition(Delivered, Delivered)).toBe(false);
    expect(canTransition(Processed, Processed)).toBe(false);
    expect(canTransition(Replied, Replied)).toBe(false);
    expect(canTransition(Expired, Expired)).toBe(false);
    expect(canTransition(DeadLettered, DeadLettered)).toBe(false);
    expect(canTransition(Cancelled, Cancelled)).toBe(false);
    expect(canTransition(ManuallyResolved, ManuallyResolved)).toBe(false);
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
    expect(HandoffStatus.Cancelled).toBe("cancelled");
    expect(HandoffStatus.ManuallyResolved).toBe("manually_resolved");
  });

  test("enum has exactly 8 values", () => {
    expect(Object.keys(HandoffStatus)).toHaveLength(8);
  });
});
