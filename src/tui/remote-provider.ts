/**
 * Remote data provider for the TUI.
 *
 * Fetches data from a grove-server HTTP API. Used when running
 * `grove tui --url http://server:4515`.
 */

import type { Frontier, FrontierQuery } from "../core/frontier.js";
import type { Claim, Contribution } from "../core/models.js";
import type { ContributionQuery, ThreadNode, ThreadSummary } from "../core/store.js";
import type {
  ActivityQuery,
  ClaimsQuery,
  ContributionDetail,
  DagData,
  DashboardData,
  FrontierSummary,
  GroveMetadata,
  PaginatedQuery,
  TuiDataProvider,
} from "./provider.js";

/** TUI data provider backed by a remote grove-server HTTP API. */
export class RemoteDataProvider implements TuiDataProvider {
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    // Normalize: remove trailing slash
    this.baseUrl = baseUrl.replace(/\/+$/, "");
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
    return (await resp.json()) as Contribution[];
  }

  async getContribution(cid: string): Promise<ContributionDetail | undefined> {
    const resp = await fetch(`${this.baseUrl}/api/contributions/${encodeURIComponent(cid)}`);
    if (resp.status === 404) return undefined;
    if (!resp.ok) throw new Error(`HTTP ${String(resp.status)}: ${resp.statusText}`);
    const contribution = (await resp.json()) as Contribution;

    // Fetch ancestors, children, and thread in parallel
    const [ancestorsResp, childrenResp, threadResp] = await Promise.all([
      fetch(`${this.baseUrl}/api/dag/${encodeURIComponent(cid)}/ancestors`),
      fetch(`${this.baseUrl}/api/dag/${encodeURIComponent(cid)}/children`),
      fetch(`${this.baseUrl}/api/threads/${encodeURIComponent(cid)}`),
    ]);

    const ancestors = ancestorsResp.ok ? ((await ancestorsResp.json()) as Contribution[]) : [];
    const children = childrenResp.ok ? ((await childrenResp.json()) as Contribution[]) : [];

    let thread: ThreadNode[] = [];
    if (threadResp.ok) {
      const raw = (await threadResp.json()) as {
        cid: string;
        depth: number;
        contribution: Contribution;
      }[];
      thread = raw.map((n) => ({
        contribution: n.contribution,
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
    return (await resp.json()) as Claim[];
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
    return (await resp.json()) as Frontier;
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
      // Fetch ancestors and children from the root
      const [ancestorsResp, childrenResp, rootResp] = await Promise.all([
        fetch(`${this.baseUrl}/api/dag/${encodeURIComponent(rootCid)}/ancestors`),
        fetch(`${this.baseUrl}/api/dag/${encodeURIComponent(rootCid)}/children`),
        fetch(`${this.baseUrl}/api/contributions/${encodeURIComponent(rootCid)}`),
      ]);

      const contributions: Contribution[] = [];
      if (rootResp.ok) contributions.push((await rootResp.json()) as Contribution);
      if (ancestorsResp.ok) contributions.push(...((await ancestorsResp.json()) as Contribution[]));
      if (childrenResp.ok) contributions.push(...((await childrenResp.json()) as Contribution[]));

      // Deduplicate
      const seen = new Set<string>();
      const unique = contributions.filter((c) => {
        if (seen.has(c.cid)) return false;
        seen.add(c.cid);
        return true;
      });

      return { contributions: unique };
    }

    // No root — get recent contributions
    const contributions = await this.getContributions({ limit: 200 });
    return { contributions };
  }

  async getHotThreads(limit = 20): Promise<readonly ThreadSummary[]> {
    const params = new URLSearchParams({ limit: String(limit) });
    const resp = await fetch(`${this.baseUrl}/api/threads?${params.toString()}`);
    if (!resp.ok) throw new Error(`HTTP ${String(resp.status)}: ${resp.statusText}`);
    const raw = (await resp.json()) as {
      cid: string;
      replyCount: number;
      lastReplyAt: string;
      contribution: Contribution;
    }[];
    return raw.map((t) => ({
      contribution: t.contribution,
      replyCount: t.replyCount,
      lastReplyAt: t.lastReplyAt,
    }));
  }

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
    };
  }

  close(): void {
    // No resources to release for HTTP client
  }
}

/** Build a compact frontier summary from full frontier data. */
function buildFrontierSummary(frontier: Frontier): FrontierSummary {
  const topByMetric: FrontierSummary["topByMetric"][number][] = [];
  for (const [metric, entries] of Object.entries(frontier.byMetric)) {
    const top = entries[0];
    if (top) {
      topByMetric.push({
        metric,
        cid: top.cid,
        summary: top.summary,
        value: top.value,
      });
    }
  }

  const topByAdoption = frontier.byAdoption.slice(0, 3).map((e) => ({
    cid: e.cid,
    summary: e.summary,
    count: e.value,
  }));

  return { topByMetric, topByAdoption };
}
