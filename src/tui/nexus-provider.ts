/**
 * Nexus data provider for the TUI.
 *
 * Extends {@link StoreBackedProvider} and adds Nexus-specific capabilities:
 * artifacts (via Nexus VFS CAS), VFS browsing, bounties, and gossip peers.
 * Used when running `grove tui --nexus <url>`.
 */

import type { Bounty } from "../core/bounty.js";
import type { BountyQuery } from "../core/bounty-store.js";
import { DefaultFrontierCalculator } from "../core/frontier.js";
import type { PeerInfo } from "../core/gossip/types.js";
import type { Contribution } from "../core/models.js";
import type { WorkspaceManager } from "../core/workspace.js";
import type { GoalSessionStore } from "../local/sqlite-goal-session-store.js";
import type { NexusClient } from "../nexus/client.js";
import type { NexusConfig } from "../nexus/config.js";
import { resolveConfig } from "../nexus/config.js";
import { NexusBountyStore } from "../nexus/nexus-bounty-store.js";
import { NexusClaimStore } from "../nexus/nexus-claim-store.js";
import { NexusContributionStore } from "../nexus/nexus-contribution-store.js";
import { NexusOutcomeStore } from "../nexus/nexus-outcome-store.js";
import { casMetaPath, casPath } from "../nexus/vfs-paths.js";
import type {
  ArtifactMeta,
  FsEntry,
  GoalData,
  ProviderCapabilities,
  SessionRecord,
  TuiArtifactProvider,
  TuiBountyProvider,
  TuiGossipProvider,
  TuiVfsProvider,
} from "./provider.js";
import {
  addContributionToSessionHttp,
  archiveSessionHttp,
  createSessionHttp,
  fetchGoalHttp,
  getSessionHttp,
  listSessionsHttp,
  setGoalHttp,
} from "./provider-shared.js";
import { StoreBackedProvider } from "./store-backed-provider.js";

/** Configuration for the Nexus provider. */
export interface NexusProviderConfig {
  readonly nexusConfig: NexusConfig;
  readonly groveName?: string | undefined;
  /** Optional workspace manager for local workspace lifecycle (hybrid mode). */
  readonly workspaceManager?: WorkspaceManager | undefined;
  readonly backendLabel?: string | undefined;
  /**
   * Optional URL of a co-located grove server.
   * When provided, goal/session state and gossip peer data are fetched
   * from the server's HTTP API so that all agents share the same state.
   */
  readonly serverUrl?: string | undefined;
  /** Optional goal/session store — only used when no serverUrl is available. */
  readonly goalSessionStore?: GoalSessionStore | undefined;
}

/** TUI data provider backed by Nexus VFS. */
export class NexusDataProvider
  extends StoreBackedProvider
  implements TuiArtifactProvider, TuiVfsProvider, TuiBountyProvider, TuiGossipProvider
{
  readonly capabilities: ProviderCapabilities;

  protected readonly mode = "nexus";

  private readonly client: NexusClient;
  private readonly zoneId: string;
  private readonly bountyStore: NexusBountyStore;
  private readonly serverUrl: string | undefined;

  constructor(config: NexusProviderConfig) {
    const store = new NexusContributionStore(config.nexusConfig);
    const claims = new NexusClaimStore(config.nexusConfig);
    const outcomes = new NexusOutcomeStore(config.nexusConfig);
    const frontier = new DefaultFrontierCalculator(store);
    super({
      contributionStore: store,
      claimStore: claims,
      frontier,
      groveName: config.groveName ?? "nexus",
      outcomeStore: outcomes,
      workspace: config.workspaceManager,
      backendLabel: config.backendLabel ?? "nexus",
      goalSessionStore: config.goalSessionStore,
    });

    // Goals/sessions are available when a co-located server provides the shared
    // HTTP API, or as a fallback via a local SQLite store.
    const hasGoalSession = !!config.serverUrl || !!config.goalSessionStore;
    this.capabilities = {
      outcomes: true,
      artifacts: true,
      vfs: true,
      messaging: true,
      costTracking: true,
      askUser: true,
      github: true,
      bounties: true,
      gossip: true,
      goals: hasGoalSession,
      sessions: hasGoalSession,
    };

    this.bountyStore = new NexusBountyStore(config.nexusConfig);
    this.serverUrl = config.serverUrl?.replace(/\/+$/, "");

    const resolved = resolveConfig(config.nexusConfig);
    this.client = resolved.client;
    this.zoneId = resolved.zoneId;
  }

  // ---------------------------------------------------------------------------
  // TuiArtifactProvider
  // ---------------------------------------------------------------------------

  async getArtifact(cid: string, name: string): Promise<Buffer> {
    const contribution = await this.store.get(cid);
    if (!contribution) {
      throw new Error(`Contribution not found: ${cid}`);
    }

    const contentHash = contribution.artifacts[name];
    if (contentHash === undefined) {
      throw new Error(`Artifact '${name}' not found on contribution ${cid}`);
    }

    const blobPath = casPath(this.zoneId, contentHash);
    const data = await this.client.read(blobPath);
    if (data === undefined) {
      throw new Error(
        `Artifact blob not found in Nexus CAS for contribution ${cid}, artifact '${name}' (hash: ${contentHash})`,
      );
    }

    return Buffer.from(data);
  }

  async getArtifactMeta(cid: string, name: string): Promise<ArtifactMeta> {
    const contribution = await this.store.get(cid);
    if (!contribution) {
      throw new Error(`Contribution not found: ${cid}`);
    }

    const contentHash = contribution.artifacts[name];
    if (contentHash === undefined) {
      throw new Error(`Artifact '${name}' not found on contribution ${cid}`);
    }

    const blobPath = casPath(this.zoneId, contentHash);
    const meta = await this.client.stat(blobPath);
    if (meta) {
      // Try reading the sidecar .meta file for media type
      const metaFilePath = casMetaPath(this.zoneId, contentHash);
      const metaData = await this.client.read(metaFilePath).catch(() => undefined);
      let mediaType: string | undefined;
      if (metaData !== undefined) {
        try {
          const parsed = JSON.parse(new TextDecoder().decode(metaData)) as {
            mediaType?: string;
          };
          mediaType = parsed.mediaType;
        } catch {
          // Ignore malformed sidecar
        }
      }

      return {
        sizeBytes: meta.size,
        mediaType: mediaType ?? meta.contentType,
      };
    }

    return { sizeBytes: 0 };
  }

  async search(query: string): Promise<readonly Contribution[]> {
    return this.store.search(query);
  }

  // ---------------------------------------------------------------------------
  // TuiBountyProvider
  // ---------------------------------------------------------------------------

  async listBounties(query?: BountyQuery): Promise<readonly Bounty[]> {
    return this.bountyStore.listBounties(query);
  }

  // ---------------------------------------------------------------------------
  // TuiGossipProvider
  // ---------------------------------------------------------------------------

  async getGossipPeers(): Promise<readonly PeerInfo[]> {
    // Gossip is a server-to-server protocol; Nexus VFS does not store peer
    // state. When a co-located grove server URL is available, fetch live
    // peer data from its /api/gossip/peers endpoint.
    if (this.serverUrl) {
      try {
        const resp = await fetch(`${this.serverUrl}/api/gossip/peers`);
        if (resp.ok) {
          const body = (await resp.json()) as { peers: readonly PeerInfo[] };
          return body.peers;
        }
      } catch {
        // Server unreachable or gossip not enabled — fall through
      }
    }
    return [];
  }

  // ---------------------------------------------------------------------------
  // Goal/session — delegate to co-located server HTTP API when available
  // so that all agents share the same state (not machine-local SQLite).
  // ---------------------------------------------------------------------------

  override async getGoal(): Promise<GoalData | undefined> {
    if (this.serverUrl) {
      try {
        return await fetchGoalHttp(this.serverUrl);
      } catch {
        /* server unreachable — fall through to local store */
      }
    }
    return super.getGoal();
  }

  override async setGoal(goal: string, acceptance: readonly string[]): Promise<GoalData> {
    if (this.serverUrl) {
      return setGoalHttp(this.serverUrl, goal, acceptance);
    }
    return super.setGoal(goal, acceptance);
  }

  override async listSessions(query?: {
    status?: "active" | "archived";
  }): Promise<readonly SessionRecord[]> {
    if (this.serverUrl) {
      try {
        return await listSessionsHttp(this.serverUrl, query);
      } catch {
        /* fall through */
      }
    }
    return super.listSessions(query);
  }

  override async createSession(
    input: import("./provider.js").SessionInput,
  ): Promise<SessionRecord> {
    if (this.serverUrl) {
      return createSessionHttp(this.serverUrl, input);
    }
    return super.createSession(input);
  }

  override async getSession(sessionId: string): Promise<SessionRecord | undefined> {
    if (this.serverUrl) {
      try {
        return await getSessionHttp(this.serverUrl, sessionId);
      } catch {
        /* fall through */
      }
    }
    return super.getSession(sessionId);
  }

  override async archiveSession(sessionId: string): Promise<void> {
    if (this.serverUrl) {
      return archiveSessionHttp(this.serverUrl, sessionId);
    }
    return super.archiveSession(sessionId);
  }

  override async addContributionToSession(sessionId: string, cid: string): Promise<void> {
    if (this.serverUrl) {
      return addContributionToSessionHttp(this.serverUrl, sessionId, cid);
    }
    return super.addContributionToSession(sessionId, cid);
  }

  // ---------------------------------------------------------------------------
  // TuiVfsProvider
  // ---------------------------------------------------------------------------

  async listPath(path: string): Promise<readonly FsEntry[]> {
    const vfsPath = `/zones/${this.zoneId}${path.startsWith("/") ? path : `/${path}`}`;
    const result = await this.client.list(vfsPath, { details: true });

    return result.files.map((entry) => ({
      name: entry.name,
      type: entry.isDirectory ? ("directory" as const) : ("file" as const),
      sizeBytes: entry.size,
    }));
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  protected override closeExtra(): void {
    this.bountyStore.close();
    // workspace is closed by the base class
  }
}
