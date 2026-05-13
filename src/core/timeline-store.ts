import type { TimelineEventEntity, WorkBlockEntity } from "./entity.js";
import type { TimelineEvent, WorkBlock, WorkBlockStatus } from "./timeline.js";

export interface WorkBlockQuery {
  readonly sessionId?: string | undefined;
  readonly status?: WorkBlockStatus | readonly WorkBlockStatus[] | undefined;
  readonly actorId?: string | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}

export interface TimelineEventQuery {
  readonly sessionId?: string | undefined;
  readonly afterRv?: string | undefined;
  readonly limit?: number | undefined;
  readonly workBlockId?: string | undefined;
}

export type WorkBlockPatch = Partial<
  Pick<
    WorkBlock,
    | "status"
    | "startedAt"
    | "completedAt"
    | "inputRefs"
    | "outputRefs"
    | "evidenceRefs"
    | "approvalRefs"
    | "contributionCids"
    | "artifactHashes"
    | "claimIds"
    | "costSummary"
    | "links"
    | "context"
  >
>;

export type TimelineEventInput = Omit<TimelineEvent, "resourceVersion" | "recordedAt"> &
  Partial<Pick<TimelineEvent, "recordedAt">>;

export interface TimelineStore {
  readonly storeIdentity?: string | undefined;
  putWorkBlock(block: WorkBlock): Promise<WorkBlock>;
  patchWorkBlock(workBlockId: string, patch: WorkBlockPatch): Promise<WorkBlock>;
  getWorkBlock(workBlockId: string): Promise<WorkBlock | undefined>;
  listWorkBlocks(query?: WorkBlockQuery): Promise<readonly WorkBlock[]>;
  listWorkBlockEntities(query?: WorkBlockQuery): Promise<readonly WorkBlockEntity[]>;
  appendTimelineEvent(input: TimelineEventInput): Promise<TimelineEvent>;
  getTimelineEvent(eventId: string): Promise<TimelineEvent | undefined>;
  listTimelineEvents(query?: TimelineEventQuery): Promise<readonly TimelineEvent[]>;
  listTimelineEventEntities(query?: TimelineEventQuery): Promise<readonly TimelineEventEntity[]>;
  currentTimelineResourceVersion(sessionId?: string): Promise<string>;
  close(): void;
}
