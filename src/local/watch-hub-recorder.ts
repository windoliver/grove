/**
 * WatchHubRecorder — typed adapter that bridges domain writes (Contribution,
 * Claim, AgentSession) to `WatchHub.recordWrite` (#388 PR2).
 *
 * Local mode publishes to a process-local `WatchHub`; the existing remote
 * path goes through `OperationDeps.onEntityWrite` → server-side hub. This
 * helper centralizes the entity projection so each store/runtime caller
 * doesn't repeat the boilerplate.
 *
 * Recorder calls swallow throws from `recordWrite` — a downstream subscriber
 * failure must not poison the write path. Throws are logged once to stderr.
 */

import type { AgentSession } from "../core/agent-runtime.js";
import {
  agentSessionToEntity,
  claimToEntity,
  contributionToEntity,
  timelineEventToEntity,
  workBlockToEntity,
} from "../core/entity.js";
import type { Claim, Contribution } from "../core/models.js";
import type { TimelineEvent, WorkBlock } from "../core/timeline.js";
import { timelineEventForAgentSession } from "../core/timeline-projector.js";
import type { TimelineEventInput, TimelineStore } from "../core/timeline-store.js";
import type { WatchOp } from "../core/watch-events.js";
import type { WatchHub } from "../core/watch-hub.js";

export interface WatchHubRecorder {
  contribution(op: WatchOp, c: Contribution): void;
  claim(op: WatchOp, c: Claim): void;
  agentSession(op: WatchOp, s: AgentSession): void;
  workBlock(op: WatchOp, block: WorkBlock): void;
  timelineEvent(op: "ADDED", event: TimelineEvent): void;
}

export interface CreateWatchHubRecorderOptions {
  readonly hub: WatchHub;
  readonly namespace: string;
  readonly timelineStore?: TimelineStore | undefined;
  /**
   * Injectable clock for `claimToEntity` lease-aware projection. Defaults to
   * wall-clock; tests can pass a fake.
   */
  readonly now?: () => number;
}

export function createWatchHubRecorder(opts: CreateWatchHubRecorderOptions): WatchHubRecorder {
  const { hub, namespace, timelineStore } = opts;
  const now = opts.now ?? (() => Date.now());

  const safeRecord = (
    kind: "Contribution" | "Claim" | "AgentSession" | "WorkBlock" | "TimelineEvent",
    op: WatchOp,
    entity:
      | ReturnType<typeof contributionToEntity>
      | ReturnType<typeof claimToEntity>
      | ReturnType<typeof agentSessionToEntity>
      | ReturnType<typeof workBlockToEntity>
      | ReturnType<typeof timelineEventToEntity>,
  ): void => {
    try {
      hub.recordWrite({ kind, namespace, op, entity });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[watch-hub-recorder] recordWrite(${kind}, ${op}) failed: ${detail}\n`);
    }
  };

  return {
    contribution(op, c) {
      safeRecord("Contribution", op, contributionToEntity(c, namespace));
    },
    claim(op, c) {
      safeRecord("Claim", op, claimToEntity(c, now, namespace));
    },
    agentSession(op, s) {
      safeRecord("AgentSession", op, agentSessionToEntity(s, undefined, namespace));
      if (timelineStore !== undefined) {
        appendTimelineEvent(timelineStore, timelineEventForAgentSession(s, op));
      }
    },
    workBlock(op, block) {
      safeRecord("WorkBlock", op, workBlockToEntity(block, namespace));
    },
    timelineEvent(op, event) {
      safeRecord("TimelineEvent", op, timelineEventToEntity(event, namespace));
    },
  };
}

function appendTimelineEvent(timelineStore: TimelineStore, event: TimelineEventInput): void {
  timelineStore.appendTimelineEvent(event).catch((err: unknown) => {
    const detail = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[watch-hub-recorder] timeline append failed: ${detail}\n`);
  });
}
