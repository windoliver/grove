/**
 * Remote data provider for the TUI.
 *
 * Fetches data from a grove-server HTTP API. Used when running
 * `grove tui --url http://server:4515`.
 */

import type { Bounty } from "../core/bounty.js";
import type { BountyQuery } from "../core/bounty-store.js";
import type { Frontier, FrontierQuery } from "../core/frontier.js";
import type { PeerInfo } from "../core/gossip/types.js";
import type { Claim, Contribution } from "../core/models.js";
import type { OutcomeRecord, OutcomeStatus } from "../core/outcome.js";
import {
  parseBounties,
  parseClaim,
  parseClaims,
  parseContribution,
  parseContributions,
  parseFrontier,
  parseOutcomeRecord,
  parseOutcomeRecords,
  parseOutcomeStats,
  parsePeerInfos,
  parseThreadSummaries,
} from "../core/schemas.js";
import type { ContributionQuery, ThreadNode, ThreadSummary } from "../core/store.js";
import type {
  ActivityQuery,
  ArtifactMeta,
  ClaimInput,
  ClaimsQuery,
  ContributionDetail,
  DagData,
  DashboardData,
  GroveMetadata,
  OperatorStats,
  PaginatedQuery,
  ProviderCapabilities,
  TuiArtifactProvider,
  TuiDataProvider,
  TuiOutcomeProvider,
} from "./provider.js";
import { diffArtifactsFromBuffers } from "./provider-shared.js";
import { buildFrontierSummary } from "./provider-utils.js";

/** TUI data provider backed by a remote grove-server HTTP API. */
export class RemoteDataProvider
  implements TuiDataProvider, TuiOutcomeProvider, TuiArtifactProvider
{
  readonly capabilities: ProviderCapabilities = {
    outcomes: true,
    artifacts: true,
    vfs: false,
  };

  private readonly baseUrl: string;
  private readonly label: string;

  constructor(baseUrl: string, backendLabel?: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.label = backendLabel ?? `remote (${this.baseUrl})`;
  }

  async getDashboard(): Promise<DashboardData> {
    const [metadata, activeClaims, recentContributions, frontier] = await Promise.all([
      this.fetchGroveMetadata(),
      this.getClaims({ status: "active" }),
      this.getContributions({ limit: 10 }),
      this.getFrontier({ limit: 3 }),
    ]);

    const frontierSummary = buildFrontierSummary(frontier);

    return {
      metadata,
      activeClaims,
      recentContributions,
      frontierSummary,
    };
  }

  async getContributions(
    query?: ContributionQuery & PaginatedQuery,
  ): Promise<readonly Contribution[]> {
    const params = new URLSearchParams();
    if (query?.kind) params.set("kind", query.kind);
    if (query?.mode) params.set("mode", query.mode);
    if (query?.tags?.length) params.set("tags", query.tags.join(","));
    if (query?.agentId) params.set("agentId", query.agentId);
    if (query?.limit) params.set("limit", String(query.limit));
    if (query?.offset) params.set("offset", String(query.offset));

    const qs = params.toString();
    const resp = await fetch(`${this.baseUrl}/api/contributions${qs ? `?${qs}` : ""}`);
    if (!resp.ok) throw new Error(`HTTP ${String(resp.status)}: ${resp.statusText}`);
    return parseContributions(await resp.json());
  }

  async getContribution(cid: string): Promise<ContributionDetail | undefined> {
    const resp = await fetch(`${this.baseUrl}/api/contributions/${encodeURIComponent(cid)}`);
    if (resp.status === 404) return undefined;
    if (!resp.ok) throw new Error(`HTTP ${String(resp.status)}: ${resp.statusText}`);
    const contribution = parseContribution(await resp.json());

    const [ancestorsResp, childrenResp, threadResp] = await Promise.all([
      fetch(`${this.baseUrl}/api/dag/${encodeURIComponent(cid)}/ancestors`),
      fetch(`${this.baseUrl}/api/dag/${encodeURIComponent(cid)}/children`),
      fetch(`${this.baseUrl}/api/threads/${encodeURIComponent(cid)}`),
    ]);

    const ancestors = ancestorsResp.ok ? parseContributions(await ancestorsResp.json()) : [];
    const children = childrenResp.ok ? parseContributions(await childrenResp.json()) : [];

    let thread: ThreadNode[] = [];
    if (threadResp.ok) {
      const body = (await threadResp.json()) as {
        nodes: readonly { cid: string; depth: number; contribution: unknown }[];
      };
      thread = body.nodes.map((n) => ({
        contribution: parseContribution(n.contribution),
        depth: n.depth,
      }));
    }

    return { contribution, ancestors, children, thread };
  }

  async getClaims(query?: ClaimsQuery): Promise<readonly Claim[]> {
    const params = new URLSearchParams();
    if (query?.status === "active") params.set("status", "active");
    if (query?.agentId) params.set("agentId", query.agentId);

    const qs = params.toString();
    const resp = await fetch(`${this.baseUrl}/api/claims${qs ? `?${qs}` : ""}`);
    if (!resp.ok) throw new Error(`HTTP ${String(resp.status)}: ${resp.statusText}`);
    const body = (await resp.json()) as { claims: unknown };
    return parseClaims(body.claims);
  }

  async createClaim(input: ClaimInput): Promise<Claim> {
    const resp = await fetch(`${this.baseUrl}/api/claims`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!resp.ok) throw new Error(`HTTP ${String(resp.status)}: ${resp.statusText}`);
    return parseClaim(await resp.json());
  }

  async releaseClaim(claimId: string): Promise<void> {
    const resp = await fetch(`${this.baseUrl}/api/claims/${encodeURIComponent(claimId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "release" }),
    });
    if (!resp.ok) throw new Error(`HTTP ${String(resp.status)}: ${resp.statusText}`);
  }

  async getFrontier(query?: FrontierQuery): Promise<Frontier> {
    const params = new URLSearchParams();
    if (query?.limit) params.set("limit", String(query.limit));
    if (query?.tags?.length) params.set("tags", query.tags.join(","));
    if (query?.kind) params.set("kind", query.kind);
    if (query?.mode) params.set("mode", query.mode);

    const qs = params.toString();
    const resp = await fetch(`${this.baseUrl}/api/frontier${qs ? `?${qs}` : ""}`);
    if (!resp.ok) throw new Error(`HTTP ${String(resp.status)}: ${resp.statusText}`);
    return parseFrontier(await resp.json());
  }

  async getActivity(query?: ActivityQuery): Promise<readonly Contribution[]> {
    return this.getContributions({
      kind: query?.kind,
      tags: query?.tags ? [...query.tags] : undefined,
      agentId: query?.agentId,
      limit: query?.limit ?? 100,
      offset: query?.offset,
    });
  }

  async getDag(rootCid?: string): Promise<DagData> {
    if (rootCid) {
      const [ancestorsResp, childrenResp, rootResp] = await Promise.all([
        fetch(`${this.baseUrl}/api/dag/${encodeURIComponent(rootCid)}/ancestors`),
        fetch(`${this.baseUrl}/api/dag/${encodeURIComponent(rootCid)}/children`),
        fetch(`${this.baseUrl}/api/contributions/${encodeURIComponent(rootCid)}`),
      ]);

      const contributions: Contribution[] = [];
      if (rootResp.ok) contributions.push(parseContribution(await rootResp.json()));
      if (ancestorsResp.ok) contributions.push(...parseContributions(await ancestorsResp.json()));
      if (childrenResp.ok) contributions.push(...parseContributions(await childrenResp.json()));

      const seen = new Set<string>();
      const unique = contributions.filter((c) => {
        if (seen.has(c.cid)) return false;
        seen.add(c.cid);
        return true;
      });

      return { contributions: unique };
    }

    // Server caps at 100 per request
    const contributions = await this.getContributions({ limit: 100 });
    return { contributions };
  }

  async getHotThreads(limit = 20): Promise<readonly ThreadSummary[]> {
    const params = new URLSearchParams({ limit: String(limit) });
    const resp = await fetch(`${this.baseUrl}/api/threads?${params.toString()}`);
    if (!resp.ok) throw new Error(`HTTP ${String(resp.status)}: ${resp.statusText}`);
    const body = (await resp.json()) as { threads: unknown };
    return parseThreadSummaries(body.threads);
  }

  // ---------------------------------------------------------------------------
  // TuiOutcomeProvider
  // ---------------------------------------------------------------------------

  async getOutcome(cid: string): Promise<OutcomeRecord | undefined> {
    const resp = await fetch(`${this.baseUrl}/api/outcomes/${encodeURIComponent(cid)}`);
    if (resp.status === 404 || resp.status === 501) return undefined;
    if (!resp.ok) throw new Error(`HTTP ${String(resp.status)}: ${resp.statusText}`);
    return parseOutcomeRecord(await resp.json());
  }

  async getOutcomes(cids: readonly string[]): Promise<ReadonlyMap<string, OutcomeRecord>> {
    const map = new Map<string, OutcomeRecord>();
    const results = await Promise.allSettled(cids.map((cid) => this.getOutcome(cid)));
    for (let i = 0; i < cids.length; i++) {
      const result = results[i];
      if (result?.status === "fulfilled" && result.value) {
        const cid = cids[i];
        if (cid) map.set(cid, result.value);
      }
    }
    return map;
  }

  async getOutcomeStats(): Promise<OperatorStats> {
    try {
      const resp = await fetch(`${this.baseUrl}/api/outcomes/stats`);
      if (resp.ok) {
        const stats = parseOutcomeStats(await resp.json());
        return {
          totalContributions: stats.total,
          outcomeBreakdown: {
            accepted: stats.accepted,
            rejected: stats.rejected,
            crashed: stats.crashed,
            invalidated: stats.invalidated,
          },
          acceptanceRate: stats.acceptanceRate,
          byAgent: [],
        };
      }
    } catch {
      // Fallback
    }
    return {
      totalContributions: 0,
      outcomeBreakdown: { accepted: 0, rejected: 0, crashed: 0, invalidated: 0 },
      acceptanceRate: 0,
      byAgent: [],
    };
  }

  async listOutcomes(query?: { status?: OutcomeStatus }): Promise<readonly OutcomeRecord[]> {
    const params = new URLSearchParams();
    if (query?.status) params.set("status", query.status);
    const qs = params.toString();
    try {
      const resp = await fetch(`${this.baseUrl}/api/outcomes${qs ? `?${qs}` : ""}`);
      if (resp.ok) return parseOutcomeRecords(await resp.json());
    } catch {
      // Fallback
    }
    return [];
  }

  // ---------------------------------------------------------------------------
  // TuiArtifactProvider
  // ---------------------------------------------------------------------------

  async getArtifact(cid: string, name: string): Promise<Buffer> {
    const resp = await fetch(
      `${this.baseUrl}/api/contributions/${encodeURIComponent(cid)}/artifacts/${encodeURIComponent(name)}`,
    );
    if (!resp.ok) throw new Error(`HTTP ${String(resp.status)}: ${resp.statusText}`);
    const arrayBuffer = await resp.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  async getArtifactMeta(cid: string, name: string): Promise<ArtifactMeta> {
    const resp = await fetch(
      `${this.baseUrl}/api/contributions/${encodeURIComponent(cid)}/artifacts/${encodeURIComponent(name)}/meta`,
    );
    if (!resp.ok) throw new Error(`HTTP ${String(resp.status)}: ${resp.statusText}`);
    // ArtifactMeta is a simple local type — lightweight validation sufficient
    return (await resp.json()) as ArtifactMeta;
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
    const resp = await fetch(`${this.baseUrl}/api/search?q=${encodeURIComponent(query)}`);
    if (!resp.ok) throw new Error(`HTTP ${String(resp.status)}: ${resp.statusText}`);
    const body = (await resp.json()) as { results: unknown };
    return parseContributions(body.results);
  }

  // ---------------------------------------------------------------------------
  // Bounties (duck-typed — detected by bounties-panel.tsx at runtime)
  // ---------------------------------------------------------------------------

  async listBounties(query?: BountyQuery): Promise<readonly Bounty[]> {
    const params = new URLSearchParams();
    if (query?.status) {
      const s = query.status;
      params.set("status", typeof s === "string" ? s : [...s].join(","));
    }
    if (query?.creatorAgentId) params.set("creatorAgentId", query.creatorAgentId);
    if (query?.limit) params.set("limit", String(query.limit));

    const qs = params.toString();
    try {
      const resp = await fetch(`${this.baseUrl}/api/bounties${qs ? `?${qs}` : ""}`);
      if (resp.ok) {
        const body = (await resp.json()) as { bounties: unknown };
        return parseBounties(body.bounties);
      }
    } catch {
      // Fallback — server may not have bounty routes
    }
    return [];
  }

  // ---------------------------------------------------------------------------
  // Gossip (duck-typed — detected by gossip-panel.tsx at runtime)
  // ---------------------------------------------------------------------------

  async getGossipPeers(): Promise<readonly PeerInfo[]> {
    try {
      const resp = await fetch(`${this.baseUrl}/api/gossip/peers`);
      if (resp.ok) {
        const body = (await resp.json()) as { peers: unknown };
        return parsePeerInfos(body.peers);
      }
    } catch {
      // Fallback — gossip may not be enabled
    }
    return [];
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async fetchGroveMetadata(): Promise<GroveMetadata> {
    try {
      const resp = await fetch(`${this.baseUrl}/api/grove`);
      if (resp.ok) {
        const data = (await resp.json()) as {
          name?: string;
          stats?: {
            contributions?: number;
            activeClaims?: number;
          };
        };
        return {
          name: data.name ?? "remote",
          contributionCount: data.stats?.contributions ?? 0,
          activeClaimCount: data.stats?.activeClaims ?? 0,
          mode: "remote",
          backendLabel: this.label,
        };
      }
    } catch {
      // Fallback
    }

    return {
      name: this.baseUrl,
      contributionCount: 0,
      activeClaimCount: 0,
      mode: "remote",
      backendLabel: this.label,
    };
  }

  close(): void {
    // No resources to release for HTTP client
  }
}
