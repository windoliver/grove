/**
 * Local data provider for the TUI.
 *
 * Wraps the local SQLite stores and frontier calculator to implement
 * the TuiDataProvider interface. Used when running `grove tui` against
 * a local .grove directory.
 */

import type { Frontier, FrontierCalculator, FrontierQuery } from "../core/frontier.js";
import type { Contribution } from "../core/models.js";
import type {
  ClaimStore,
  ContributionQuery,
  ContributionStore,
  ThreadSummary,
} from "../core/store.js";
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

/** Configuration for the local provider. */
export interface LocalProviderDeps {
  readonly contributionStore: ContributionStore;
  readonly claimStore: ClaimStore;
  readonly frontier: FrontierCalculator;
  readonly groveName: string;
}

/** TUI data provider backed by local SQLite stores. */
export class LocalDataProvider implements TuiDataProvider {
  private readonly store: ContributionStore;
  private readonly claims: ClaimStore;
  private readonly calc: FrontierCalculator;
  private readonly name: string;

  constructor(deps: LocalProviderDeps) {
    this.store = deps.contributionStore;
    this.claims = deps.claimStore;
    this.calc = deps.frontier;
    this.name = deps.groveName;
  }

  async getDashboard(): Promise<DashboardData> {
    const [contributionCount, activeClaims, recentContributions, frontier] = await Promise.all([
      this.store.count(),
      this.claims.activeClaims(),
      this.store.list({ limit: 10 }),
      this.calc.compute({ limit: 3 }),
    ]);

    const metadata: GroveMetadata = {
      name: this.name,
      contributionCount,
      activeClaimCount: activeClaims.length,
      mode: "local",
    };

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
    return this.store.list(query);
  }

  async getContribution(cid: string): Promise<ContributionDetail | undefined> {
    const contribution = await this.store.get(cid);
    if (!contribution) return undefined;

    const [ancestors, children, thread] = await Promise.all([
      this.store.ancestors(cid),
      this.store.children(cid),
      this.store.thread(cid, { maxDepth: 20, limit: 50 }),
    ]);

    return { contribution, ancestors, children, thread };
  }

  async getClaims(query?: ClaimsQuery): Promise<readonly import("../core/models.js").Claim[]> {
    if (!query || query.status === "active") {
      // activeClaims() accepts targetRef, not agentId.
      // If agentId filtering is requested, use listClaims() instead.
      if (query?.agentId) {
        return this.claims.listClaims({ status: "active", agentId: query.agentId });
      }
      return this.claims.activeClaims();
    }
    return this.claims.listClaims({
      agentId: query.agentId,
    });
  }

  async getFrontier(query?: FrontierQuery): Promise<Frontier> {
    return this.calc.compute(query);
  }

  async getActivity(query?: ActivityQuery): Promise<readonly Contribution[]> {
    return this.store.list({
      kind: query?.kind,
      tags: query?.tags ? [...query.tags] : undefined,
      agentId: query?.agentId,
      limit: query?.limit ?? 100,
      offset: query?.offset,
    });
  }

  async getDag(rootCid?: string): Promise<DagData> {
    if (rootCid) {
      // BFS from root, collecting connected contributions
      const visited = new Set<string>();
      const queue: string[] = [rootCid];
      const result: Contribution[] = [];

      while (queue.length > 0 && result.length < 200) {
        const cid = queue.shift();
        if (cid === undefined) break;
        if (visited.has(cid)) continue;
        visited.add(cid);

        const contribution = await this.store.get(cid);
        if (!contribution) continue;
        result.push(contribution);

        const children = await this.store.children(cid);
        for (const child of children) {
          if (!visited.has(child.cid)) {
            queue.push(child.cid);
          }
        }
      }

      return { contributions: result };
    }

    // No root — get recent contributions for DAG display
    const contributions = await this.store.list({ limit: 200 });
    return { contributions };
  }

  async getHotThreads(limit = 20): Promise<readonly ThreadSummary[]> {
    return this.store.hotThreads({ limit });
  }

  close(): void {
    this.store.close();
    this.claims.close();
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
