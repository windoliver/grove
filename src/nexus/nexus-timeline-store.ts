import type { TimelineEventEntity, WorkBlockEntity } from "../core/entity.js";
import { timelineEventToEntity, workBlockToEntity } from "../core/entity.js";
import { NotFoundError, StateConflictError } from "../core/errors.js";
import type { TimelineEvent, WorkBlock } from "../core/timeline.js";
import { timelineScope } from "../core/timeline.js";
import { parseTimelineEvent, parseWorkBlock } from "../core/timeline-schemas.js";
import type {
  TimelineEventInput,
  TimelineEventQuery,
  TimelineStore,
  WorkBlockPatch,
  WorkBlockQuery,
} from "../core/timeline-store.js";
import type { WatchEntity, WatchKind, WatchOp } from "../core/watch-events.js";
import { batchParallel } from "./batch.js";
import type { NexusClient, WriteOptions, WriteResult } from "./client.js";
import { type ResolvedNexusConfig, resolveConfig } from "./config.js";
import { NexusConflictError } from "./errors.js";
import { listAllPages } from "./list-pages.js";
import type { NexusWatchPublisher } from "./nexus-watch-publisher.js";
import { withRetry, withSemaphore } from "./retry.js";
import { Semaphore } from "./semaphore.js";
import {
  encodeSegment,
  timelineCursorPath,
  timelineEventByIdPath,
  timelineEventPath,
  timelineEventsDir,
  workBlockPath,
  workBlockSessionIndexPath,
  workBlockStatusIndexPath,
  workBlocksDir,
} from "./vfs-paths.js";

const DEFAULT_MAX_CURSOR_RETRIES = 8;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface NexusTimelineStoreConfig {
  readonly client: NexusClient;
  readonly zoneId: string;
  readonly watchPublisher?: NexusWatchPublisher | undefined;
  readonly maxCursorRetries?: number | undefined;
}

interface CursorRecord {
  readonly currentRv: number;
}

interface TimelineClosedResourceVersion {
  readonly resourceVersion: string;
  readonly kind: "event" | "skipped";
  readonly eventId?: string | undefined;
  readonly closedAt: string;
}

interface WorkBlockWithMeta {
  readonly block: WorkBlock;
  readonly etag: string;
}

export class NexusTimelineStore implements TimelineStore {
  readonly storeIdentity: string;

  private readonly config: NexusTimelineStoreConfig;
  private readonly resolvedConfig: ResolvedNexusConfig;
  private readonly client: NexusClient;
  private readonly zoneId: string;
  private readonly semaphore: Semaphore;
  private readonly maxCursorRetries: number;

  constructor(config: NexusTimelineStoreConfig) {
    this.config = config;
    this.resolvedConfig = resolveConfig(config);
    this.client = config.client;
    this.zoneId = config.zoneId;
    this.semaphore = new Semaphore(this.resolvedConfig.maxConcurrency);
    this.maxCursorRetries = config.maxCursorRetries ?? DEFAULT_MAX_CURSOR_RETRIES;
    this.storeIdentity = `nexus:${this.zoneId}:timeline`;
  }

  async putWorkBlock(block: WorkBlock): Promise<WorkBlock> {
    const parsed = parseWorkBlock(block);
    const existing = await this.getWorkBlock(parsed.workBlockId);
    const content = encodeJson(parsed);
    const files = [
      {
        path: workBlockPath(this.zoneId, parsed.workBlockId),
        content,
      },
      ...workBlockIndexFiles(this.zoneId, parsed, content),
    ];

    await withRetry(
      () => withSemaphore(this.semaphore, () => this.client.writeBatch(files)),
      "putWorkBlock",
      this.resolvedConfig,
    );

    await this.cleanupWorkBlockIndexes(existing, parsed);
    await this.publish(
      "WorkBlock",
      existing === undefined ? "ADDED" : "MODIFIED",
      parsed.workBlockId,
      parsed.revision,
      workBlockToEntity(parsed, this.zoneId),
    );
    return parsed;
  }

  async patchWorkBlock(workBlockId: string, patch: WorkBlockPatch): Promise<WorkBlock> {
    for (let attempt = 0; attempt < this.maxCursorRetries; attempt++) {
      const existing = await this.readWorkBlockWithMeta(workBlockId);
      if (existing === undefined) {
        throw new NotFoundError({ resource: "WorkBlock", identifier: workBlockId });
      }

      const patched = parseWorkBlock({
        ...existing.block,
        ...patch,
        updatedAt: nextUpdatedAt(existing.block.updatedAt),
        revision: existing.block.revision + 1,
      });
      const content = encodeJson(patched);
      let writeResult: WriteResult;

      try {
        writeResult = await withRetry(
          () =>
            withSemaphore(this.semaphore, () =>
              this.client.write(workBlockPath(this.zoneId, workBlockId), content, {
                ifMatch: existing.etag,
              }),
            ),
          "patchWorkBlock:write",
          this.resolvedConfig,
        );
      } catch (error) {
        if (error instanceof NexusConflictError) continue;
        throw error;
      }

      await this.writeWorkBlockIndexes(patched, content);
      await this.cleanupWorkBlockIndexes(existing.block, patched);
      const current = await this.readWorkBlockWithMeta(workBlockId);
      if (current === undefined || current.etag !== writeResult.etag) {
        await this.cleanupSupersededWorkBlockIndexes(patched, current?.block);
        return patched;
      }

      await this.publish(
        "WorkBlock",
        "MODIFIED",
        patched.workBlockId,
        patched.revision,
        workBlockToEntity(patched, this.zoneId),
      );
      return patched;
    }

    throw new StateConflictError({
      resource: "WorkBlock",
      reason: "max patch retries exhausted",
    });
  }

  async getWorkBlock(workBlockId: string): Promise<WorkBlock | undefined> {
    const data = await withRetry(
      () =>
        withSemaphore(this.semaphore, () =>
          this.client.read(workBlockPath(this.zoneId, workBlockId)),
        ),
      "getWorkBlock",
      this.resolvedConfig,
    );
    return data === undefined ? undefined : decodeWorkBlock(data);
  }

  async listWorkBlocks(query?: WorkBlockQuery): Promise<readonly WorkBlock[]> {
    const entries = await listAllPages(
      this.client,
      this.semaphore,
      this.resolvedConfig,
      workBlocksDir(this.zoneId),
    );
    const files = entries.filter((entry) => !entry.isDirectory && entry.path.endsWith(".json"));
    const blocks = await batchParallel(
      files,
      async (entry) => {
        const data = await withRetry(
          () => withSemaphore(this.semaphore, () => this.client.read(entry.path)),
          "listWorkBlocks:read",
          this.resolvedConfig,
        );
        return data === undefined ? undefined : decodeWorkBlock(data);
      },
      this.resolvedConfig.maxConcurrency,
    );

    const filtered = blocks.filter((block): block is WorkBlock => {
      if (block === undefined) return false;
      if (query?.sessionId !== undefined && block.sessionId !== query.sessionId) return false;
      if (query?.actorId !== undefined && block.actor.agentId !== query.actorId) return false;
      if (query?.status !== undefined) {
        const statuses = Array.isArray(query.status) ? query.status : [query.status];
        if (!statuses.includes(block.status)) return false;
      }
      return true;
    });

    filtered.sort(compareWorkBlockRecencyDesc);
    const offset = query?.offset ?? 0;
    const limit = query?.limit ?? filtered.length;
    return filtered.slice(offset, offset + limit);
  }

  async listWorkBlockEntities(query?: WorkBlockQuery): Promise<readonly WorkBlockEntity[]> {
    const blocks = await this.listWorkBlocks(query);
    return blocks.map((block) => workBlockToEntity(block, this.zoneId));
  }

  async appendTimelineEvent(input: TimelineEventInput): Promise<TimelineEvent> {
    const existing = await this.getTimelineEvent(input.eventId);
    if (existing !== undefined) {
      const materialized = await this.materializeOrderedTimelineEvent(existing);
      if (materialized) {
        await this.publish(
          "TimelineEvent",
          "ADDED",
          existing.eventId,
          Number(existing.resourceVersion),
          timelineEventToEntity(existing, this.zoneId),
        );
      }
      return existing;
    }

    const scope = timelineScope(input.sessionId);
    const resourceVersion = await this.allocateCursor(scope);
    const event = parseTimelineEvent({
      ...input,
      resourceVersion,
      recordedAt: input.recordedAt ?? new Date().toISOString(),
    });
    const content = encodeJson(event);
    const byIdPath = timelineEventByIdPath(this.zoneId, event.eventId);

    try {
      await withRetry(
        () =>
          withSemaphore(this.semaphore, () =>
            this.client.write(byIdPath, content, { ifNoneMatch: "*" }),
          ),
        "appendTimelineEvent:by-id",
        this.resolvedConfig,
      );
    } catch (error) {
      if (error instanceof NexusConflictError) {
        const existingAfterConflict = await this.getTimelineEvent(input.eventId);
        if (existingAfterConflict !== undefined) {
          const existingScope = timelineScope(existingAfterConflict.sessionId);
          if (
            scope !== existingScope ||
            event.resourceVersion !== existingAfterConflict.resourceVersion
          ) {
            await this.closeTimelineResourceVersion(scope, {
              resourceVersion: event.resourceVersion,
              kind: "skipped",
              closedAt: new Date().toISOString(),
            });
          }
          const materialized = await this.materializeOrderedTimelineEvent(existingAfterConflict);
          if (materialized) {
            await this.publish(
              "TimelineEvent",
              "ADDED",
              existingAfterConflict.eventId,
              Number(existingAfterConflict.resourceVersion),
              timelineEventToEntity(existingAfterConflict, this.zoneId),
            );
          }
          return existingAfterConflict;
        }
      }
      throw error;
    }

    const materialized = await this.materializeOrderedTimelineEvent(event);
    if (materialized) {
      await this.publish(
        "TimelineEvent",
        "ADDED",
        event.eventId,
        Number(event.resourceVersion),
        timelineEventToEntity(event, this.zoneId),
      );
    }
    return event;
  }

  async getTimelineEvent(eventId: string): Promise<TimelineEvent | undefined> {
    const data = await withRetry(
      () =>
        withSemaphore(this.semaphore, () =>
          this.client.read(timelineEventByIdPath(this.zoneId, eventId)),
        ),
      "getTimelineEvent",
      this.resolvedConfig,
    );
    return data === undefined ? undefined : decodeTimelineEvent(data);
  }

  async listTimelineEvents(query?: TimelineEventQuery): Promise<readonly TimelineEvent[]> {
    const scope = timelineScope(query?.sessionId);
    const entries = await listAllPages(
      this.client,
      this.semaphore,
      this.resolvedConfig,
      timelineEventsDir(this.zoneId, scope),
    );
    const files = entries.filter((entry) => !entry.isDirectory && entry.path.endsWith(".json"));
    const events = await batchParallel(
      files,
      async (entry) => {
        const data = await withRetry(
          () => withSemaphore(this.semaphore, () => this.client.read(entry.path)),
          "listTimelineEvents:read",
          this.resolvedConfig,
        );
        return data === undefined ? undefined : decodeTimelineEvent(data);
      },
      this.resolvedConfig.maxConcurrency,
    );

    const afterRv = query?.afterRv === undefined ? undefined : BigInt(query.afterRv);
    const filtered = events.filter((event): event is TimelineEvent => {
      if (event === undefined) return false;
      if (afterRv !== undefined && BigInt(event.resourceVersion) <= afterRv) return false;
      if (query?.workBlockId !== undefined && event.workBlockId !== query.workBlockId) return false;
      return true;
    });

    filtered.sort(compareTimelineEventRvAsc);
    return filtered.slice(0, query?.limit ?? filtered.length);
  }

  async listTimelineEventEntities(
    query?: TimelineEventQuery,
  ): Promise<readonly TimelineEventEntity[]> {
    const events = await this.listTimelineEvents(query);
    return events.map((event) => timelineEventToEntity(event, this.zoneId));
  }

  async currentTimelineResourceVersion(sessionId?: string): Promise<string> {
    const data = await withRetry(
      () =>
        withSemaphore(this.semaphore, () =>
          this.client.read(timelineCommittedCursorPath(this.zoneId, timelineScope(sessionId))),
        ),
      "currentTimelineResourceVersion",
      this.resolvedConfig,
    );
    if (data === undefined) return "0";
    return String(decodeCursor(data).currentRv);
  }

  close(): void {
    // Nexus client lifecycle is owned by the caller.
  }

  private async allocateCursor(scope: string): Promise<string> {
    const path = timelineCursorPath(this.zoneId, scope);

    for (let attempt = 0; attempt < this.maxCursorRetries; attempt++) {
      const loaded = await withRetry(
        () => withSemaphore(this.semaphore, () => this.client.readWithMeta(path)),
        "allocateTimelineCursor:read",
        this.resolvedConfig,
      );
      const currentRv = loaded === undefined ? 0 : decodeCursor(loaded.content).currentRv;
      const nextRv = currentRv + 1;
      const options: WriteOptions =
        loaded === undefined ? { ifNoneMatch: "*" } : { ifMatch: loaded.etag };

      try {
        await withRetry(
          () =>
            withSemaphore(this.semaphore, () =>
              this.client.write(path, encodeJson({ currentRv: nextRv }), options),
            ),
          "allocateTimelineCursor:write",
          this.resolvedConfig,
        );
        return String(nextRv);
      } catch (error) {
        if (!(error instanceof NexusConflictError)) throw error;
      }
    }

    throw new StateConflictError({
      resource: "TimelineCursor",
      reason: "max cursor retries exhausted",
    });
  }

  private async readWorkBlockWithMeta(workBlockId: string): Promise<WorkBlockWithMeta | undefined> {
    const data = await withRetry(
      () =>
        withSemaphore(this.semaphore, () =>
          this.client.readWithMeta(workBlockPath(this.zoneId, workBlockId)),
        ),
      "readWorkBlockWithMeta",
      this.resolvedConfig,
    );
    if (data === undefined) return undefined;
    return {
      block: decodeWorkBlock(data.content),
      etag: data.etag,
    };
  }

  private async materializeOrderedTimelineEvent(event: TimelineEvent): Promise<boolean> {
    const content = encodeJson(event);
    const scope = timelineScope(event.sessionId);
    try {
      await withRetry(
        () =>
          withSemaphore(this.semaphore, () =>
            this.client.write(
              timelineEventPath(this.zoneId, scope, event.resourceVersion, event.eventId),
              content,
              { ifNoneMatch: "*" },
            ),
          ),
        "materializeOrderedTimelineEvent",
        this.resolvedConfig,
      );
    } catch (error) {
      if (!(error instanceof NexusConflictError)) throw error;
    }

    const closed = await this.closeTimelineResourceVersion(scope, {
      resourceVersion: event.resourceVersion,
      kind: "event",
      eventId: event.eventId,
      closedAt: new Date().toISOString(),
    });
    return closed;
  }

  private async closeTimelineResourceVersion(
    scope: string,
    marker: TimelineClosedResourceVersion,
  ): Promise<boolean> {
    let created = false;
    try {
      await withRetry(
        () =>
          withSemaphore(this.semaphore, () =>
            this.client.write(
              timelineClosedResourceVersionPath(this.zoneId, scope, marker.resourceVersion),
              encodeJson(marker),
              { ifNoneMatch: "*" },
            ),
          ),
        "closeTimelineResourceVersion",
        this.resolvedConfig,
      );
      created = true;
    } catch (error) {
      if (!(error instanceof NexusConflictError)) throw error;
    }

    await this.advanceCommittedTimelineCursor(scope);
    return created;
  }

  private async advanceCommittedTimelineCursor(scope: string): Promise<void> {
    const path = timelineCommittedCursorPath(this.zoneId, scope);

    for (let attempt = 0; attempt < this.maxCursorRetries; attempt++) {
      const loaded = await withRetry(
        () => withSemaphore(this.semaphore, () => this.client.readWithMeta(path)),
        "advanceCommittedTimelineCursor:read",
        this.resolvedConfig,
      );
      const currentRv = loaded === undefined ? 0 : decodeCursor(loaded.content).currentRv;
      const nextRv = await this.highestContiguousClosedResourceVersion(scope, currentRv);
      if (nextRv === currentRv) return;

      const options: WriteOptions =
        loaded === undefined ? { ifNoneMatch: "*" } : { ifMatch: loaded.etag };

      try {
        await withRetry(
          () =>
            withSemaphore(this.semaphore, () =>
              this.client.write(path, encodeJson({ currentRv: nextRv }), options),
            ),
          "advanceCommittedTimelineCursor:write",
          this.resolvedConfig,
        );
        return;
      } catch (error) {
        if (!(error instanceof NexusConflictError)) throw error;
      }
    }

    throw new StateConflictError({
      resource: "TimelineCommittedCursor",
      reason: "max cursor retries exhausted",
    });
  }

  private async highestContiguousClosedResourceVersion(
    scope: string,
    currentRv: number,
  ): Promise<number> {
    let nextRv = currentRv;
    while (
      await withRetry(
        () =>
          withSemaphore(this.semaphore, () =>
            this.client.exists(
              timelineClosedResourceVersionPath(this.zoneId, scope, String(nextRv + 1)),
            ),
          ),
        "highestContiguousClosedResourceVersion",
        this.resolvedConfig,
      )
    ) {
      nextRv++;
    }
    return nextRv;
  }

  private async writeWorkBlockIndexes(block: WorkBlock, content: Uint8Array): Promise<void> {
    await withRetry(
      () =>
        withSemaphore(this.semaphore, () =>
          this.client.writeBatch(workBlockIndexFiles(this.zoneId, block, content)),
        ),
      "writeWorkBlockIndexes",
      this.resolvedConfig,
    );
  }

  private async cleanupWorkBlockIndexes(
    previous: WorkBlock | undefined,
    next: WorkBlock,
  ): Promise<void> {
    if (previous === undefined) return;

    const nextPaths = new Set(workBlockIndexPaths(this.zoneId, next));
    const stalePaths = workBlockIndexPaths(this.zoneId, previous).filter(
      (path) => !nextPaths.has(path),
    );

    await this.deleteWorkBlockIndexPaths(stalePaths);
  }

  private async cleanupSupersededWorkBlockIndexes(
    superseded: WorkBlock,
    current: WorkBlock | undefined,
  ): Promise<void> {
    const currentPaths =
      current === undefined
        ? new Set<string>()
        : new Set(workBlockIndexPaths(this.zoneId, current));
    const stalePaths = workBlockIndexPaths(this.zoneId, superseded).filter(
      (path) => !currentPaths.has(path),
    );
    await this.deleteWorkBlockIndexPaths(stalePaths);
  }

  private async deleteWorkBlockIndexPaths(paths: readonly string[]): Promise<void> {
    await batchParallel(
      paths,
      async (path) => {
        await withRetry(
          () => withSemaphore(this.semaphore, () => this.client.delete(path)),
          "cleanupWorkBlockIndexes",
          this.resolvedConfig,
        );
      },
      this.resolvedConfig.maxConcurrency,
    );
  }

  private async publish(
    kind: WatchKind,
    op: WatchOp,
    entityId: string,
    generation: number,
    entity: WatchEntity,
  ): Promise<void> {
    await this.config.watchPublisher?.publish({
      kind,
      namespace: this.zoneId,
      op,
      entityId,
      generation,
      entity,
      emittedAt: new Date().toISOString(),
    });
  }
}

function workBlockIndexPaths(zoneId: string, block: WorkBlock): readonly string[] {
  const paths = [
    workBlockStatusIndexPath(zoneId, block.status, block.updatedAt, block.workBlockId),
  ];
  if (block.sessionId !== undefined) {
    paths.push(
      workBlockSessionIndexPath(zoneId, block.sessionId, block.updatedAt, block.workBlockId),
    );
  }
  return paths;
}

function workBlockIndexFiles(
  zoneId: string,
  block: WorkBlock,
  content: Uint8Array,
): readonly {
  readonly path: string;
  readonly content: Uint8Array;
}[] {
  return workBlockIndexPaths(zoneId, block).map((path) => ({ path, content }));
}

function timelineCommittedCursorPath(zoneId: string, scope: string): string {
  return `/zones/${encodeSegment(zoneId)}/timeline/committed-cursors/${encodeSegment(scope)}.json`;
}

function timelineClosedResourceVersionPath(
  zoneId: string,
  scope: string,
  resourceVersion: string,
): string {
  return `/zones/${encodeSegment(zoneId)}/timeline/closed/${encodeSegment(scope)}/${resourceVersion.padStart(20, "0")}.json`;
}

function encodeJson(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

function decodeJson(data: Uint8Array): unknown {
  return JSON.parse(decoder.decode(data)) as unknown;
}

function decodeWorkBlock(data: Uint8Array): WorkBlock {
  return parseWorkBlock(decodeJson(data));
}

function decodeTimelineEvent(data: Uint8Array): TimelineEvent {
  return parseTimelineEvent(decodeJson(data));
}

function decodeCursor(data: Uint8Array): CursorRecord {
  const value = decodeJson(data);
  if (
    typeof value !== "object" ||
    value === null ||
    !("currentRv" in value) ||
    typeof value.currentRv !== "number" ||
    !Number.isInteger(value.currentRv) ||
    value.currentRv < 0
  ) {
    throw new Error("Invalid timeline cursor record");
  }
  return { currentRv: value.currentRv };
}

function compareWorkBlockRecencyDesc(a: WorkBlock, b: WorkBlock): number {
  const byTime = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  if (byTime !== 0) return byTime;
  return a.workBlockId.localeCompare(b.workBlockId);
}

function compareTimelineEventRvAsc(a: TimelineEvent, b: TimelineEvent): number {
  const aRv = BigInt(a.resourceVersion);
  const bRv = BigInt(b.resourceVersion);
  if (aRv < bRv) return -1;
  if (aRv > bRv) return 1;
  return a.eventId.localeCompare(b.eventId);
}

function nextUpdatedAt(previousUpdatedAt: string): string {
  const previousMs = Date.parse(previousUpdatedAt);
  const nowMs = Date.now();
  const nextMs = Number.isFinite(previousMs) ? Math.max(nowMs, previousMs + 1) : nowMs;
  return new Date(nextMs).toISOString();
}
