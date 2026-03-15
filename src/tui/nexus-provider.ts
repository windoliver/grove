/**
 * Nexus data provider for the TUI.
 *
 * Wraps NexusContributionStore, NexusClaimStore, NexusOutcomeStore,
 * and NexusCas to implement TuiDataProvider + TuiOutcomeProvider +
 * TuiArtifactProvider + TuiVfsProvider. Used when running `grove tui --nexus <url>`.
 */

import type { Bounty } from "../core/bounty.js";
import type { BountyQuery } from "../core/bounty-store.js";
import type { Frontier, FrontierQuery } from "../core/frontier.js";
import { DefaultFrontierCalculator } from "../core/frontier.js";
import type { PeerInfo } from "../core/gossip/types.js";
import { computeCid } from "../core/manifest.js";
import type { AgentIdentity, Claim, Contribution } from "../core/models.js";
import {
  answerQuestion as answerQuestionOp,
  listPendingQuestions,
} from "../core/operations/ask-user-bus.js";
import { getSessionCosts as getSessionCostsOp } from "../core/operations/cost-tracking.js";
import { readInbox } from "../core/operations/messaging.js";
import type { OutcomeRecord, OutcomeStatus } from "../core/outcome.js";
import type { ContributionQuery, ThreadSummary } from "../core/store.js";
import type { WorkspaceManager } from "../core/workspace.js";
import { getActivePR } from "../github/active-pr.js";
import type { NexusClient } from "../nexus/client.js";
import type { NexusConfig } from "../nexus/config.js";
import { resolveConfig } from "../nexus/config.js";
import { NexusBountyStore } from "../nexus/nexus-bounty-store.js";
import { NexusClaimStore } from "../nexus/nexus-claim-store.js";
import { NexusContributionStore } from "../nexus/nexus-contribution-store.js";
import { NexusOutcomeStore } from "../nexus/nexus-outcome-store.js";
import { casMetaPath, casPath } from "../nexus/vfs-paths.js";
import type {
  ActivityQuery,
  ArtifactMeta,
  ClaimInput,
  ClaimsQuery,
  ContributionDetail,
  DagData,
  DashboardData,
  FsEntry,
  GitHubPRSummary,
  GroveMetadata,
  InboxMessage,
  OperatorStats,
  PaginatedQuery,
  PendingQuestion,
  ProviderCapabilities,
  SessionCostSummary,
  TuiArtifactProvider,
  TuiAskUserProvider,
  TuiCostProvider,
  TuiDataProvider,
  TuiGitHubProvider,
  TuiMessagingProvider,
  TuiOutcomeProvider,
  TuiVfsProvider,
} from "./provider.js";
import {
  activityFromStore,
  claimsFromStore,
  contributionDetailFromStore,
  dagFromStore,
  diffArtifactsFromBuffers,
  outcomeStatsFromStore,
} from "./provider-shared.js";
import { buildFrontierSummary } from "./provider-utils.js";

/** Configuration for the Nexus provider. */
export interface NexusProviderConfig {
  readonly nexusConfig: NexusConfig;
  readonly groveName?: string | undefined;
  /** Optional workspace manager for local workspace lifecycle (hybrid mode). */
  readonly workspaceManager?: WorkspaceManager | undefined;
  readonly backendLabel?: string | undefined;
  /**
   * Optional URL of a co-located grove server.
   * When provided, gossip peer data is fetched from the server's
   * `/api/gossip/peers` endpoint (gossip is server-to-server, not
   * stored in Nexus VFS).
   */
  readonly serverUrl?: string | undefined;
}

/** TUI data provider backed by Nexus VFS. */
export class NexusDataProvider
  implements
    TuiDataProvider,
    TuiOutcomeProvider,
    TuiArtifactProvider,
    TuiVfsProvider,
    TuiMessagingProvider,
    TuiCostProvider,
    TuiAskUserProvider,
    TuiGitHubProvider
{
  readonly capabilities: ProviderCapabilities = {
    outcomes: true,
    artifacts: true,
    vfs: true,
    messaging: true,
    costTracking: true,
    askUser: true,
    github: true,
  };

  private readonly store: NexusContributionStore;
  private readonly claims: NexusClaimStore;
  private readonly outcomes: NexusOutcomeStore;
  private readonly bountyStore: NexusBountyStore;
  private readonly frontier: DefaultFrontierCalculator;
  private readonly client: NexusClient;
  private readonly zoneId: string;
  private readonly name: string;
  private readonly workspace: WorkspaceManager | undefined;
  private readonly label: string;
  private readonly serverUrl: string | undefined;

  constructor(config: NexusProviderConfig) {
    this.store = new NexusContributionStore(config.nexusConfig);
    this.claims = new NexusClaimStore(config.nexusConfig);
    this.outcomes = new NexusOutcomeStore(config.nexusConfig);
    this.bountyStore = new NexusBountyStore(config.nexusConfig);
    this.frontier = new DefaultFrontierCalculator(this.store);
    this.name = config.groveName ?? "nexus";
    this.serverUrl = config.serverUrl;
    this.workspace = config.workspaceManager;
    this.label = config.backendLabel ?? "nexus";

    const resolved = resolveConfig(config.nexusConfig);
    this.client = resolved.client;
    this.zoneId = resolved.zoneId;
  }

  // ---------------------------------------------------------------------------
  // TuiDataProvider
  // ---------------------------------------------------------------------------

  async getDashboard(): Promise<DashboardData> {
    const [contributionCount, activeClaims, recentContributions, frontier] = await Promise.all([
      this.store.count(),
      this.claims.activeClaims(),
      this.store.list({ limit: 10 }),
      this.frontier.compute({ limit: 3 }),
    ]);

    const metadata: GroveMetadata = {
      name: this.name,
      contributionCount,
      activeClaimCount: activeClaims.length,
      mode: "nexus",
      backendLabel: this.label,
    };

    return {
      metadata,
      activeClaims,
      recentContributions,
      frontierSummary: buildFrontierSummary(frontier),
    };
  }

  async getContributions(
    query?: ContributionQuery & PaginatedQuery,
  ): Promise<readonly Contribution[]> {
    return this.store.list(query);
  }

  async getContribution(cid: string): Promise<ContributionDetail | undefined> {
    return contributionDetailFromStore(this.store, cid);
  }

  async getClaims(query?: ClaimsQuery): Promise<readonly Claim[]> {
    return claimsFromStore(this.claims, query);
  }

  async getFrontier(query?: FrontierQuery): Promise<Frontier> {
    return this.frontier.compute(query);
  }

  async getActivity(query?: ActivityQuery): Promise<readonly Contribution[]> {
    return activityFromStore(this.store, query);
  }

  async getDag(rootCid?: string): Promise<DagData> {
    return dagFromStore(this.store, rootCid);
  }

  async getHotThreads(limit = 20): Promise<readonly ThreadSummary[]> {
    return this.store.hotThreads({ limit });
  }

  // ---------------------------------------------------------------------------
  // Lifecycle (spawn / kill)
  // ---------------------------------------------------------------------------

  async createClaim(input: ClaimInput): Promise<Claim> {
    const now = new Date();
    const claim: Claim = {
      claimId: crypto.randomUUID(),
      targetRef: input.targetRef,
      agent: input.agent,
      status: "active",
      intentSummary: input.intentSummary,
      createdAt: now.toISOString(),
      heartbeatAt: now.toISOString(),
      leaseExpiresAt: new Date(now.getTime() + input.leaseDurationMs).toISOString(),
      ...(input.context !== undefined ? { context: input.context } : {}),
    };
    return this.claims.claimOrRenew(claim);
  }

  async checkoutWorkspace(targetRef: string, agent: AgentIdentity): Promise<string> {
    if (!this.workspace) {
      throw new Error("Workspace manager not available");
    }
    try {
      const info = await this.workspace.checkout(targetRef, { agent });
      return info.workspacePath;
    } catch {
      // For TUI-spawned agents, targetRef is a spawnId (not a contribution CID).
      // Fall back to a bare workspace directory.
      const info = await this.workspace.createBareWorkspace(targetRef, { agent });
      return info.workspacePath;
    }
  }

  async heartbeatClaim(claimId: string, leaseDurationMs?: number): Promise<Claim> {
    return this.claims.heartbeat(claimId, leaseDurationMs);
  }

  async releaseClaim(claimId: string): Promise<void> {
    await this.claims.release(claimId);
  }

  async cleanWorkspace(targetRef: string, agentId: string): Promise<void> {
    if (!this.workspace) return;
    try {
      await this.workspace.cleanWorkspace(targetRef, agentId);
    } catch {
      // Workspace might already be cleaned or not exist
    }
  }

  // ---------------------------------------------------------------------------
  // TuiOutcomeProvider
  // ---------------------------------------------------------------------------

  async getOutcome(cid: string): Promise<OutcomeRecord | undefined> {
    return this.outcomes.get(cid);
  }

  async getOutcomes(cids: readonly string[]): Promise<ReadonlyMap<string, OutcomeRecord>> {
    return this.outcomes.getBatch(cids);
  }

  async getOutcomeStats(): Promise<OperatorStats> {
    return outcomeStatsFromStore(this.outcomes);
  }

  async listOutcomes(query?: { status?: OutcomeStatus }): Promise<readonly OutcomeRecord[]> {
    return this.outcomes.list(query);
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

  async diffArtifacts(
    parentCid: string,
    childCid: string,
    name: string,
  ): Promise<{ readonly parent: string; readonly child: string }> {
    const [parentBuf, childBuf] = await Promise.all([
      this.getArtifact(parentCid, name),
      this.getArtifact(childCid, name),
    ]);
    return diffArtifactsFromBuffers(parentBuf, childBuf);
  }

  async search(query: string): Promise<readonly Contribution[]> {
    return this.store.search(query);
  }

  // ---------------------------------------------------------------------------
  // TuiMessagingProvider
  // ---------------------------------------------------------------------------

  async getInboxMessages(query?: {
    recipient?: string;
    limit?: number;
  }): Promise<readonly InboxMessage[]> {
    const messages = await readInbox(this.store, {
      recipient: query?.recipient,
      limit: query?.limit,
    });
    return messages.map((m) => ({
      cid: m.cid,
      from: {
        agentId: m.from.agentId,
        ...(m.from.agentName !== undefined ? { agentName: m.from.agentName } : {}),
      },
      body: m.body,
      recipients: m.recipients,
      createdAt: m.createdAt,
    }));
  }

  // ---------------------------------------------------------------------------
  // TuiCostProvider
  // ---------------------------------------------------------------------------

  async getSessionCosts(): Promise<SessionCostSummary> {
    const costs = await getSessionCostsOp(this.store);
    return {
      totalCostUsd: costs.totalCostUsd,
      totalTokens: costs.totalInputTokens + costs.totalOutputTokens,
      byAgent: costs.byAgent.map((a) => ({
        agentId: a.agentId,
        ...(a.agentName !== undefined ? { agentName: a.agentName } : {}),
        costUsd: a.totalCostUsd,
        tokens: a.totalInputTokens + a.totalOutputTokens,
        ...(a.latestContextPercent !== undefined ? { contextPercent: a.latestContextPercent } : {}),
      })),
    };
  }

  // ---------------------------------------------------------------------------
  // TuiAskUserProvider
  // ---------------------------------------------------------------------------

  async getPendingQuestions(): Promise<readonly PendingQuestion[]> {
    const questions = await listPendingQuestions(this.store);
    return questions.map((q) => ({
      cid: q.cid,
      ...(q.agent.agentName !== undefined ? { agentName: q.agent.agentName } : {}),
      question: q.question,
      ...(q.options !== undefined ? { options: q.options } : {}),
      createdAt: q.createdAt,
    }));
  }

  async answerQuestion(questionCid: string, answer: string): Promise<void> {
    const operator = { agentId: "tui-operator", agentName: "operator" };
    await answerQuestionOp(this.store, { questionCid, answer, operator }, computeCid);
  }

  // ---------------------------------------------------------------------------
  // TuiGitHubProvider
  // ---------------------------------------------------------------------------

  async getActivePR(): Promise<GitHubPRSummary | undefined> {
    return getActivePR();
  }

  // ---------------------------------------------------------------------------
  // Bounties (duck-typed — detected by bounties-panel.tsx at runtime)
  // ---------------------------------------------------------------------------

  async listBounties(query?: BountyQuery): Promise<readonly Bounty[]> {
    return this.bountyStore.listBounties(query);
  }

  // ---------------------------------------------------------------------------
  // Gossip (duck-typed — detected by gossip-panel.tsx at runtime)
  // ---------------------------------------------------------------------------

  async getGossipPeers(): Promise<readonly PeerInfo[]> {
    // Gossip is a server-to-server protocol; Nexus VFS does not store peer
    // state. When a co-located grove server URL is available, fetch live
    // peer data from its /api/gossip/peers endpoint.
    if (this.serverUrl) {
      try {
        const resp = await fetch(`${this.serverUrl.replace(/\/+$/, "")}/api/gossip/peers`);
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

  close(): void {
    this.store.close();
    this.claims.close();
    this.outcomes.close();
    this.bountyStore.close();
    this.workspace?.close();
  }
}
