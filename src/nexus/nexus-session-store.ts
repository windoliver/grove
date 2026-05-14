/**
 * Nexus VFS-backed session store.
 *
 * Stores sessions as JSON files at /zones/{zoneId}/sessions/{id}.json.
 * Legacy contribution links are stored at /zones/{zoneId}/sessions/{id}.contributions.json.
 * New links are marker files under /zones/{zoneId}/sessions/{id}.contributions/.
 */

import { randomUUID } from "node:crypto";
import { StateConflictError } from "../core/errors.js";
import {
  appendDeletionAudit,
  DEFAULT_SESSION_FINALIZERS,
  Finalizer,
  type Finalizer as KnownFinalizer,
  type OwnerRef,
  type SessionFinalizer,
} from "../core/lifecycle-metadata.js";
import type {
  AppendSessionRoleSkillResult,
  CreateSessionInput,
  RuntimeSkillSessionStore,
  Session,
  SessionDeleteBlocker,
  SessionDeleteOptions,
  SessionDeleteResult,
  SessionQuery,
  SessionStore,
} from "../core/session.js";
import { appendSkillToSessionConfigTopology, appendSkillToTopology } from "../core/session.js";
import type { ClaimStore } from "../core/store.js";
import type { NexusClient } from "./client.js";
import { NexusConflictError } from "./errors.js";
import { NexusClaimStore } from "./nexus-claim-store.js";
import { decodeSegment, encodeSegment } from "./vfs-paths.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

type PersistedSessionRecord = Omit<Session, "uid" | "finalizers" | "deletionAudit"> &
  Partial<Pick<Session, "uid" | "finalizers" | "deletionAudit">>;

interface SessionContributionLink {
  readonly cid: string;
  readonly ownerRef: OwnerRef;
  readonly addedAt: string;
}

interface ContributionMarker {
  readonly cid: string;
  readonly ownerRef?: OwnerRef | undefined;
  readonly addedAt?: string | undefined;
}

interface ContributionSidecarV2 {
  readonly version: 2;
  readonly items: readonly SessionContributionLink[];
}

interface LoadedContributionLinks {
  readonly items: readonly SessionContributionLink[];
  readonly isLegacy: boolean;
}

interface PersistedSessionRecordWithEtag {
  readonly persisted: PersistedSessionRecord;
  readonly etag: string;
}

interface DeleteStateSessionWrite {
  readonly session: Session;
  readonly etag: string;
}

export interface NexusSessionStoreOptions {
  readonly claimStore?: ClaimStore | undefined;
  readonly closeRuntime?: ((session: Session) => Promise<void>) | undefined;
}

function ownerRefForSession(session: Pick<Session, "id" | "uid">): OwnerRef {
  return { kind: "session", id: session.id, uid: session.uid };
}

function normalizeSessionFinalizers(
  finalizers: readonly SessionFinalizer[] | undefined,
): readonly SessionFinalizer[] {
  return finalizers === undefined ? [] : [...finalizers];
}

function resolveDeleteFinalizers(
  finalizers: readonly SessionFinalizer[] | undefined,
): readonly SessionFinalizer[] {
  return finalizers === undefined ? [...DEFAULT_SESSION_FINALIZERS] : [...finalizers];
}

function isKnownSessionFinalizer(finalizer: string): finalizer is KnownFinalizer {
  return (DEFAULT_SESSION_FINALIZERS as readonly string[]).includes(finalizer);
}

function forceWarning(sessionId: string): string {
  return `force delete skipped finalizer waits for session ${sessionId}`;
}

function isCasConflict(error: unknown): boolean {
  return (
    error instanceof NexusConflictError ||
    (typeof error === "object" &&
      error !== null &&
      "name" in error &&
      error.name === "StateConflictError")
  );
}

function isSessionContributionLink(value: unknown): value is SessionContributionLink {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  const ownerRef = record.ownerRef;
  if (typeof record.cid !== "string" || typeof record.addedAt !== "string") return false;
  if (typeof ownerRef !== "object" || ownerRef === null) return false;
  const ownerRefRecord = ownerRef as Record<string, unknown>;
  return (
    ownerRefRecord.kind === "session" &&
    typeof ownerRefRecord.id === "string" &&
    typeof ownerRefRecord.uid === "string"
  );
}

function isContributionSidecarV2(value: unknown): value is ContributionSidecarV2 {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.version === 2 &&
    Array.isArray(record.items) &&
    record.items.every(isSessionContributionLink)
  );
}

export class NexusSessionStore implements SessionStore, RuntimeSkillSessionStore {
  private readonly client: NexusClient;
  private readonly zoneId: string;
  private readonly closeRuntime: ((session: Session) => Promise<void>) | undefined;
  private readonly injectedClaimStore: ClaimStore | undefined;
  private lazyClaimStore: ClaimStore | undefined;
  private readonly legacyUidBySessionId = new Map<string, string>();

  constructor(client: NexusClient, zoneId: string, options?: NexusSessionStoreOptions) {
    this.client = client;
    this.zoneId = zoneId;
    this.injectedClaimStore = options?.claimStore;
    this.closeRuntime = options?.closeRuntime;
  }

  private sessionPath(id: string): string {
    return `/zones/${this.zoneId}/sessions/${id}.json`;
  }

  private contributionsPath(id: string): string {
    return `/zones/${this.zoneId}/sessions/${id}.contributions.json`;
  }

  private contributionMarkersDir(id: string): string {
    return `/zones/${this.zoneId}/sessions/${id}.contributions`;
  }

  private contributionMarkerPath(id: string, cid: string): string {
    return `${this.contributionMarkersDir(id)}/${encodeSegment(cid)}`;
  }

  private normalizeSessionRecord(session: PersistedSessionRecord): {
    readonly session: Session;
    readonly needsUidBackfill: boolean;
  } {
    const uid = session.uid ?? this.legacyUidBySessionId.get(session.id) ?? session.id;
    this.legacyUidBySessionId.set(session.id, uid);
    const finalizers = normalizeSessionFinalizers(session.finalizers);
    const deletionAudit = session.deletionAudit ?? [];
    const contributionCount = session.contributionCount ?? 0;
    const normalized: Session = {
      ...session,
      uid,
      finalizers,
      deletionAudit,
      contributionCount,
    };
    return { session: normalized, needsUidBackfill: session.uid !== uid };
  }

  private async writeSessionRecord(
    session: Session,
    options?: { readonly ifMatch?: string | undefined },
  ): Promise<string> {
    const result = await this.client.write(
      this.sessionPath(session.id),
      encoder.encode(JSON.stringify(session)),
      options,
    );
    return result.etag;
  }

  private async readPersistedSessionRecord(
    id: string,
  ): Promise<PersistedSessionRecord | undefined> {
    try {
      const data = await this.client.read(this.sessionPath(id));
      if (data === undefined) return undefined;
      return JSON.parse(decoder.decode(data)) as PersistedSessionRecord;
    } catch {
      return undefined;
    }
  }

  private async readPersistedSessionRecordWithEtag(
    id: string,
  ): Promise<PersistedSessionRecordWithEtag | undefined> {
    try {
      const data = await this.client.readWithMeta(this.sessionPath(id));
      if (data === undefined) return undefined;
      return {
        persisted: JSON.parse(decoder.decode(data.content)) as PersistedSessionRecord,
        etag: data.etag,
      };
    } catch {
      return undefined;
    }
  }

  private async writeDeleteStateSessionRecord(
    session: Session,
    expectedEtag: string,
  ): Promise<DeleteStateSessionWrite | undefined> {
    let desired = session;
    let etag = expectedEtag;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const nextEtag = await this.writeSessionRecord(desired, { ifMatch: etag });
        return { session: desired, etag: nextEtag };
      } catch (error) {
        if (!isCasConflict(error)) throw error;
        const latest = await this.readPersistedSessionRecordWithEtag(session.id);
        if (latest === undefined) return undefined;
        const latestSession = this.normalizeSessionRecord(latest.persisted).session;
        const latestFinalizers = resolveDeleteFinalizers(latest.persisted.finalizers);
        const desiredFinalizers = new Set(desired.finalizers);
        const deletionAudit = [...(latestSession.deletionAudit ?? [])];
        for (const event of desired.deletionAudit ?? []) {
          if (
            deletionAudit.some(
              (existing) =>
                existing.at === event.at &&
                existing.actor === event.actor &&
                existing.warning === event.warning,
            )
          ) {
            continue;
          }
          deletionAudit.push(event);
        }
        desired = {
          ...latestSession,
          deletionTimestamp: desired.deletionTimestamp ?? latestSession.deletionTimestamp,
          finalizers: latestFinalizers.filter(
            (finalizer) => desiredFinalizers.has(finalizer) || !isKnownSessionFinalizer(finalizer),
          ),
          deletionAudit,
        };
        etag = latest.etag;
      }
    }

    throw new StateConflictError({
      resource: "Session",
      reason: "delete state write conflict",
      message: `Could not persist delete state for session '${session.id}' after concurrent updates; retry the delete request`,
    });
  }

  private async readContributionLinks(
    sessionId: string,
    session?: Pick<Session, "id" | "uid" | "createdAt">,
  ): Promise<LoadedContributionLinks> {
    const fallbackOwnerRef = ownerRefForSession({
      id: sessionId,
      uid: session?.uid ?? sessionId,
    });
    const defaultOwnerRef = session !== undefined ? ownerRefForSession(session) : fallbackOwnerRef;
    const defaultAddedAt = session?.createdAt ?? new Date().toISOString();
    const items: SessionContributionLink[] = [];
    const seen = new Set<string>();
    let isLegacy = false;

    const addItem = (item: SessionContributionLink): void => {
      if (seen.has(item.cid)) return;
      seen.add(item.cid);
      items.push(item);
    };

    try {
      const data = await this.client.read(this.contributionsPath(sessionId));
      if (data !== undefined) {
        const parsed = JSON.parse(decoder.decode(data)) as unknown;
        if (Array.isArray(parsed)) {
          isLegacy = true;
          for (const cid of parsed) {
            if (typeof cid !== "string") continue;
            addItem({ cid, ownerRef: defaultOwnerRef, addedAt: defaultAddedAt });
          }
        } else if (isContributionSidecarV2(parsed)) {
          for (const item of parsed.items) addItem(item);
        }
      }
    } catch {
      // Ignore malformed or missing legacy sidecar.
    }

    try {
      const markers = await this.client.list(this.contributionMarkersDir(sessionId));
      for (const entry of markers.files) {
        if (entry.isDirectory) continue;
        try {
          const data = await this.client.read(entry.path);
          if (data !== undefined) {
            const marker = JSON.parse(decoder.decode(data)) as Partial<ContributionMarker>;
            if (typeof marker.cid === "string") {
              addItem({
                cid: marker.cid,
                ownerRef: marker.ownerRef ?? defaultOwnerRef,
                addedAt: marker.addedAt ?? defaultAddedAt,
              });
              continue;
            }
          }
        } catch {
          // Fall through to filename-derived CID for older/partial markers.
        }
        addItem({
          cid: decodeSegment(entry.name),
          ownerRef: defaultOwnerRef,
          addedAt: defaultAddedAt,
        });
      }
    } catch {
      // Marker directory may not exist on legacy sessions.
    }

    return { items, isLegacy };
  }

  private async writeContributionLinks(
    sessionId: string,
    items: readonly SessionContributionLink[],
  ): Promise<void> {
    const sidecar: ContributionSidecarV2 = { version: 2, items };
    await this.client.write(
      this.contributionsPath(sessionId),
      encoder.encode(JSON.stringify(sidecar)),
    );
  }

  private async deleteContributionLinks(sessionId: string): Promise<void> {
    await this.client.delete(this.contributionsPath(sessionId));
    try {
      const markers = await this.client.list(this.contributionMarkersDir(sessionId));
      for (const entry of markers.files) {
        if (!entry.isDirectory) await this.client.delete(entry.path);
      }
      await this.client.delete(this.contributionMarkersDir(sessionId));
    } catch {
      // Marker directory may not exist on legacy sessions.
    }
  }

  private async getClaimStore(): Promise<ClaimStore> {
    if (this.injectedClaimStore !== undefined) return this.injectedClaimStore;
    if (this.lazyClaimStore !== undefined) return this.lazyClaimStore;
    this.lazyClaimStore = new NexusClaimStore({
      client: this.client,
      zoneId: this.zoneId,
    });
    return this.lazyClaimStore;
  }

  private buildRemainingFinalizerBlockers(
    finalizers: readonly SessionFinalizer[],
  ): readonly SessionDeleteBlocker[] {
    return finalizers.map((finalizer) => ({
      finalizer,
      message: isKnownSessionFinalizer(finalizer)
        ? finalizer === Finalizer.CloseRuntime
          ? "runtime cleanup pending"
          : "finalizer still pending"
        : "unknown finalizer pending",
    }));
  }

  async createSession(input: CreateSessionInput): Promise<Session> {
    const id = randomUUID().slice(0, 8);
    const createdAt = new Date().toISOString();
    const session: Session = {
      id,
      uid: randomUUID(),
      goal: input.goal,
      presetName: input.presetName,
      topology: input.topology,
      status: "active",
      createdAt,
      finalizers: DEFAULT_SESSION_FINALIZERS,
      deletionAudit: [],
      contributionCount: 0,
      config: input.config,
    };
    await this.writeSessionRecord(session);
    return session;
  }

  /** Write an existing session record (preserving its ID) — used for mirroring. */
  async putSession(session: Session): Promise<void> {
    const normalized = this.normalizeSessionRecord(session);
    await this.writeSessionRecord(normalized.session);
  }

  /**
   * Read only the session metadata record, without loading contribution counts.
   *
   * MCP startup only needs config/topology/preset fields; avoiding the
   * contribution sidecar read keeps that hot path O(1) in session size.
   */
  async getSessionRecord(id: string): Promise<Session | undefined> {
    const loaded = await this.readPersistedSessionRecordWithEtag(id);
    if (loaded === undefined) return undefined;
    const normalized = this.normalizeSessionRecord(loaded.persisted);
    if (normalized.needsUidBackfill) {
      try {
        await this.client.write(
          this.sessionPath(id),
          encoder.encode(
            JSON.stringify({
              ...loaded.persisted,
              uid: normalized.session.uid,
            }),
          ),
          { ifMatch: loaded.etag },
        );
      } catch {
        // Preserve a stable in-memory uid even if a legacy rewrite fails.
      }
    }
    return normalized.session;
  }

  async getSession(id: string): Promise<Session | undefined> {
    const session = await this.getSessionRecord(id);
    if (!session) return undefined;
    const cids = await this.getContributions(id);
    return { ...session, contributionCount: cids.length };
  }

  async updateSession(
    id: string,
    updates: Partial<Pick<Session, "status" | "completedAt" | "stopReason" | "stopStatus">>,
  ): Promise<void> {
    const loaded = await this.readPersistedSessionRecordWithEtag(id);
    if (loaded === undefined) return;
    const existing = this.normalizeSessionRecord(loaded.persisted).session;
    try {
      await this.writeSessionRecord({ ...existing, ...updates }, { ifMatch: loaded.etag });
    } catch (error) {
      if (!isCasConflict(error)) throw error;
      const latest = await this.readPersistedSessionRecordWithEtag(id);
      if (latest === undefined) return;
      throw error;
    }
  }

  async appendSessionRoleSkill(
    id: string,
    roleName: string,
    skillName: string,
  ): Promise<AppendSessionRoleSkillResult> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const loaded = await this.readPersistedSessionRecordWithEtag(id);
      if (loaded === undefined) return "session_missing";
      const existing = this.normalizeSessionRecord(loaded.persisted).session;
      if (existing.topology === undefined) return "role_missing";

      const topologyResult = appendSkillToTopology(existing.topology, roleName, skillName);
      const configResult = appendSkillToSessionConfigTopology(existing.config, roleName, skillName);

      if (!topologyResult.foundRole) return "role_missing";
      if (!topologyResult.changed && !configResult.changed) return "already_present";

      const nextPersisted: PersistedSessionRecord = {
        ...loaded.persisted,
        uid: existing.uid,
        topology: topologyResult.topology,
        config: configResult.config,
      };

      try {
        await this.client.write(
          this.sessionPath(id),
          encoder.encode(JSON.stringify(nextPersisted)),
          { ifMatch: loaded.etag },
        );
        return "appended";
      } catch (error) {
        if (!isCasConflict(error)) throw error;
      }
    }

    throw new Error("appendSessionRoleSkill retry loop exhausted");
  }

  async listSessions(query?: SessionQuery): Promise<readonly Session[]> {
    try {
      const result = await this.client.list(`/zones/${this.zoneId}/sessions`);
      const sessions: Session[] = [];
      for (const file of result.files) {
        if (!file.name.endsWith(".json") || file.name.endsWith(".contributions.json")) continue;
        const sessionId = file.name.replace(/\.json$/, "");
        const session = await this.getSessionRecord(sessionId);
        if (session === undefined) continue;
        if (query?.status !== undefined) {
          if (session.status !== query.status) continue;
        } else if (!query?.includeArchived && session.status === "archived") {
          continue;
        }
        if (query?.presetName !== undefined && session.presetName !== query.presetName) continue;
        const contributions = await this.getContributions(session.id);
        sessions.push({ ...session, contributionCount: contributions.length });
      }
      return sessions.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    } catch {
      return [];
    }
  }

  async deleteSession(id: string, options?: SessionDeleteOptions): Promise<SessionDeleteResult> {
    const loaded = await this.readPersistedSessionRecordWithEtag(id);
    if (loaded === undefined) {
      return {
        sessionId: id,
        deleted: false,
        forced: false,
        blockers: [{ finalizer: Finalizer.ReleaseSlots, message: "session not found" }],
      };
    }
    const persisted = loaded.persisted;
    let currentEtag = loaded.etag;
    const session = this.normalizeSessionRecord(persisted).session;

    const ownerRef = ownerRefForSession(session);
    const startingFinalizers = resolveDeleteFinalizers(persisted.finalizers);
    const deletionTimestamp = session.deletionTimestamp ?? new Date().toISOString();

    if (options?.force === true) {
      const warning = forceWarning(id);
      const terminating: Session = {
        ...session,
        finalizers: startingFinalizers,
        deletionTimestamp,
        deletionAudit: appendDeletionAudit(session.deletionAudit, {
          at: new Date().toISOString(),
          actor: options.actor ?? "unknown",
          warning,
        }),
      };
      const terminatingEtag = await this.writeDeleteStateSessionRecord(terminating, currentEtag);
      if (terminatingEtag === undefined) {
        return {
          sessionId: id,
          deleted: true,
          forced: true,
          blockers: [],
          warning,
        };
      }

      const claimStore = await this.getClaimStore();
      const cleanupErrors: string[] = [];
      try {
        await claimStore.releaseOwnedBy(ownerRef);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
      try {
        await claimStore.deleteTerminalOwnedBy(ownerRef);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
      try {
        await this.deleteContributionLinks(id);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }

      await this.client.delete(this.sessionPath(id));
      return {
        sessionId: id,
        deleted: true,
        forced: true,
        blockers: [],
        warning,
        ...(cleanupErrors.length > 0 ? { cleanupErrors } : {}),
      };
    }

    let current: Session = {
      ...session,
      finalizers: [...startingFinalizers],
      deletionTimestamp,
      deletionAudit: session.deletionAudit ?? [],
    };
    const initialDeleteWrite = await this.writeDeleteStateSessionRecord(current, currentEtag);
    if (initialDeleteWrite === undefined) {
      return {
        sessionId: id,
        deleted: true,
        forced: false,
        blockers: [],
      };
    }
    current = initialDeleteWrite.session;
    currentEtag = initialDeleteWrite.etag;

    const claimStore = await this.getClaimStore();
    for (const finalizer of DEFAULT_SESSION_FINALIZERS) {
      if (!current.finalizers.includes(finalizer)) continue;

      try {
        if (finalizer === Finalizer.ReleaseSlots) {
          await claimStore.releaseOwnedBy(ownerRef);
          await claimStore.deleteTerminalOwnedBy(ownerRef);
        } else if (finalizer === Finalizer.DrainContribs) {
          await this.deleteContributionLinks(id);
        } else if (finalizer === Finalizer.CloseRuntime && this.closeRuntime !== undefined) {
          await this.closeRuntime(current);
        }
      } catch (error) {
        return {
          sessionId: id,
          deleted: false,
          forced: false,
          blockers: [
            {
              finalizer,
              message: error instanceof Error ? error.message : String(error),
            },
          ],
        };
      }

      current = {
        ...current,
        finalizers: current.finalizers.filter((value) => value !== finalizer),
      };
      const nextWrite = await this.writeDeleteStateSessionRecord(current, currentEtag);
      if (nextWrite === undefined) {
        return {
          sessionId: id,
          deleted: true,
          forced: false,
          blockers: [],
        };
      }
      current = nextWrite.session;
      currentEtag = nextWrite.etag;
    }

    if (current.finalizers.length > 0) {
      return {
        sessionId: id,
        deleted: false,
        forced: false,
        blockers: this.buildRemainingFinalizerBlockers(current.finalizers),
      };
    }

    await this.client.delete(this.sessionPath(id));
    return {
      sessionId: id,
      deleted: true,
      forced: false,
      blockers: [],
    };
  }

  async listSessionDeleteBlockers(id: string): Promise<readonly SessionDeleteBlocker[]> {
    const persisted = await this.readPersistedSessionRecord(id);
    if (persisted === undefined) {
      return [{ finalizer: Finalizer.ReleaseSlots, message: "session not found" }];
    }
    const session = this.normalizeSessionRecord(persisted).session;

    const finalizers = resolveDeleteFinalizers(persisted.finalizers);
    const ownerRef = ownerRefForSession(session);
    const blockers: SessionDeleteBlocker[] = [];

    const claimStore = await this.getClaimStore();
    const activeOwnedClaims = await claimStore.listClaims({
      status: "active",
      ownerRef,
    });
    if (activeOwnedClaims.length > 0) {
      blockers.push({
        finalizer: Finalizer.ReleaseSlots,
        message: `${activeOwnedClaims.length} active owned claim${
          activeOwnedClaims.length === 1 ? "" : "s"
        } remain`,
      });
    }

    const links = await this.getContributions(id);
    if (links.length > 0) {
      blockers.push({
        finalizer: Finalizer.DrainContribs,
        message: `${links.length} session contribution link${links.length === 1 ? "" : "s"} remain`,
      });
    }

    if (this.closeRuntime !== undefined && finalizers.includes(Finalizer.CloseRuntime)) {
      blockers.push({
        finalizer: Finalizer.CloseRuntime,
        message: "runtime cleanup pending",
      });
    }

    for (const finalizer of finalizers) {
      if (isKnownSessionFinalizer(finalizer)) continue;
      blockers.push({
        finalizer,
        message: "unknown finalizer pending",
      });
    }

    return blockers;
  }

  async archiveSession(id: string): Promise<void> {
    await this.updateSession(id, {
      status: "archived",
      completedAt: new Date().toISOString(),
    });
  }

  async addContribution(sessionId: string, cid: string): Promise<void> {
    const session = await this.getSessionRecord(sessionId);
    const loaded = await this.readContributionLinks(sessionId, session ?? undefined);
    const items = [...loaded.items];
    const ownerRef =
      session !== undefined
        ? ownerRefForSession(session)
        : { kind: "session" as const, id: sessionId, uid: sessionId };
    if (!items.some((item) => item.cid === cid)) {
      const item: SessionContributionLink = {
        cid,
        ownerRef,
        addedAt: new Date().toISOString(),
      };
      items.push(item);
      try {
        const marker: ContributionMarker = item;
        await this.client.write(
          this.contributionMarkerPath(sessionId, cid),
          encoder.encode(JSON.stringify(marker)),
          { ifNoneMatch: "*" },
        );
      } catch (error) {
        if (!(error instanceof NexusConflictError)) throw error;
      }
    }
    if (loaded.isLegacy) {
      await this.writeContributionLinks(sessionId, items);
    }
  }

  async getContributions(sessionId: string): Promise<readonly string[]> {
    try {
      const loaded = await this.readContributionLinks(sessionId);
      return loaded.items.map((item) => item.cid);
    } catch {
      return [];
    }
  }
}
