import { describe, expect, test } from "bun:test";
import { ClaimStatus, ContributionKind } from "../../core/models.js";
import { OutcomeStatus } from "../../core/outcome.js";
import { makeClaim, makeContribution } from "../../core/test-helpers.js";
import { type DagNodeStatus, deriveDagStatus } from "./derive-dag-status.js";

const NOW = Date.parse("2026-05-11T12:00:00Z");
const PAST = new Date(NOW - 60_000).toISOString();
const FUTURE = new Date(NOW + 60_000).toISOString();

describe("deriveDagStatus", () => {
  test("returns 'done' when outcome is accepted", () => {
    const c = makeContribution({ summary: "x" });
    const status = deriveDagStatus({
      contribution: c,
      outcome: { cid: c.cid, status: OutcomeStatus.Accepted, evaluatedAt: PAST, evaluatedBy: "op" },
      claim: undefined,
      hasReviewChild: false,
      now: NOW,
    });
    expect(status).toBe<DagNodeStatus>("done");
  });

  test("returns 'failed' for rejected/crashed/invalidated", () => {
    const c = makeContribution({ summary: "x" });
    for (const s of [OutcomeStatus.Rejected, OutcomeStatus.Crashed, OutcomeStatus.Invalidated]) {
      expect(
        deriveDagStatus({
          contribution: c,
          outcome: { cid: c.cid, status: s, evaluatedAt: PAST, evaluatedBy: "op" },
          claim: undefined,
          hasReviewChild: false,
          now: NOW,
        }),
      ).toBe<DagNodeStatus>("failed");
    }
  });

  test("returns 'running' for active claim with future lease", () => {
    const c = makeContribution({ summary: "x" });
    const claim = makeClaim({
      status: ClaimStatus.Active,
      leaseExpiresAt: FUTURE,
      targetRef: c.cid,
    });
    const status = deriveDagStatus({
      contribution: c,
      outcome: undefined,
      claim,
      hasReviewChild: false,
      now: NOW,
    });
    expect(status).toBe<DagNodeStatus>("running");
  });

  test("returns 'blocked' for active claim with expired lease", () => {
    const c = makeContribution({ summary: "x" });
    const claim = makeClaim({ status: ClaimStatus.Active, leaseExpiresAt: PAST, targetRef: c.cid });
    const status = deriveDagStatus({
      contribution: c,
      outcome: undefined,
      claim,
      hasReviewChild: false,
      now: NOW,
    });
    expect(status).toBe<DagNodeStatus>("blocked");
  });

  test("returns 'awaiting-review' for work-kind with no outcome, no active claim, no review child", () => {
    const c = makeContribution({ kind: ContributionKind.Work, summary: "x" });
    const status = deriveDagStatus({
      contribution: c,
      outcome: undefined,
      claim: undefined,
      hasReviewChild: false,
      now: NOW,
    });
    expect(status).toBe<DagNodeStatus>("awaiting-review");
  });

  test("returns 'idle' for work-kind with no outcome but has review child", () => {
    const c = makeContribution({ kind: ContributionKind.Work, summary: "x" });
    const status = deriveDagStatus({
      contribution: c,
      outcome: undefined,
      claim: undefined,
      hasReviewChild: true,
      now: NOW,
    });
    expect(status).toBe<DagNodeStatus>("idle");
  });

  test("returns 'idle' for non-work-kind with no outcome and no claim", () => {
    const c = makeContribution({ kind: ContributionKind.Review, summary: "x" });
    const status = deriveDagStatus({
      contribution: c,
      outcome: undefined,
      claim: undefined,
      hasReviewChild: false,
      now: NOW,
    });
    expect(status).toBe<DagNodeStatus>("idle");
  });

  test("outcome overrides claim — done wins over running", () => {
    const c = makeContribution({ summary: "x" });
    const claim = makeClaim({
      status: ClaimStatus.Active,
      leaseExpiresAt: FUTURE,
      targetRef: c.cid,
    });
    const status = deriveDagStatus({
      contribution: c,
      outcome: { cid: c.cid, status: OutcomeStatus.Accepted, evaluatedAt: PAST, evaluatedBy: "op" },
      claim,
      hasReviewChild: false,
      now: NOW,
    });
    expect(status).toBe<DagNodeStatus>("done");
  });

  test("ignores released / expired / completed claims", () => {
    const c = makeContribution({ summary: "x" });
    for (const s of [ClaimStatus.Released, ClaimStatus.Expired, ClaimStatus.Completed]) {
      const claim = makeClaim({ status: s, leaseExpiresAt: FUTURE, targetRef: c.cid });
      expect(
        deriveDagStatus({
          contribution: c,
          outcome: undefined,
          claim,
          hasReviewChild: false,
          now: NOW,
        }),
      ).not.toBe<DagNodeStatus>("running");
    }
  });
});
