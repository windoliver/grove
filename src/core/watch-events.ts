/**
 * Shared types for the watch protocol (#292).
 *
 * The watch RV is a monotonic per-(namespace, kind) sequence held by the
 * server's WatchHub. It is distinct from Entity.resourceVersion (per-row
 * revision) — see docs/superpowers/specs/2026-04-27-a5-watch-protocol-design.md.
 */

import type { AgentSessionEntity, ClaimEntity, ContributionEntity } from "./entity.js";

export type WatchKind = "Contribution" | "Claim" | "AgentSession";

export type WatchOp = "ADDED" | "MODIFIED" | "DELETED";

export type WatchEntity = ContributionEntity | ClaimEntity | AgentSessionEntity;

/** A watch-stream event emitted by the hub to subscribers. */
export interface WatchEvent {
  readonly rv: bigint;
  readonly op: WatchOp;
  readonly kind: WatchKind;
  readonly namespace: string;
  readonly entity: WatchEntity;
}

/** Argument shape for `WatchHub.recordWrite` / `OperationDeps.onEntityWrite`. */
export type EntityWriteEvent = Omit<WatchEvent, "rv">;

/** Thrown by `WatchHub.subscribe` when `fromRv` falls outside the ring buffer. */
export class StaleResourceVersionError extends Error {
  readonly code = 410;
  readonly namespace: string;
  readonly kind: WatchKind;
  readonly fromRv: bigint;
  readonly oldestRv: bigint;

  constructor(namespace: string, kind: WatchKind, fromRv: bigint, oldestRv: bigint) {
    super(
      `resourceVersion ${fromRv} is older than the oldest buffered event ${oldestRv} for ${namespace}/${kind}`,
    );
    this.name = "StaleResourceVersionError";
    this.namespace = namespace;
    this.kind = kind;
    this.fromRv = fromRv;
    this.oldestRv = oldestRv;
  }
}
