/**
 * Remote data provider for the TUI.
 *
 * Fetches data from a grove-server HTTP API. Used when running
 * `grove tui --url http://server:4515`.
 */

import type { AgentTaskView } from "../core/agent-task.js";
import type { Bounty } from "../core/bounty.js";
import type { BountyQuery } from "../core/bounty-store.js";
import type { Frontier, FrontierQuery } from "../core/frontier.js";
import type { PeerInfo } from "../core/gossip/types.js";
import type { Handoff, HandoffQuery } from "../core/handoff.js";
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
import type { SessionTimeline, WorkBlock } from "../core/timeline.js";
import { parseSessionTimeline, parseWorkBlocks } from "../core/timeline-schemas.js";
import type {
  ActivityQuery,
  ArtifactMeta,
  ClaimInput,
  ClaimsQuery,
  ContributionDetail,
  DagData,
  DashboardData,
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
  TuiBountyProvider,
  TuiCostProvider,
  TuiDataProvider,
  TuiGitHubProvider,
  TuiGoalProvider,
  TuiGossipProvider,
  TuiHandoffProvider,
  TuiMessagingProvider,
  TuiOutcomeProvider,
  TuiSessionProvider,
} from "./provider.js";
import {
  addContributionToSessionHttp,
  archiveSessionHttp,
  createSessionHttp,
  diffArtifactsUsing,
  fetchGoalHttp,
  getSessionHttp,
  listSessionsHttp,
  setGoalHttp,
} from "./provider-shared.js";
import { buildFrontierSummary } from "./provider-utils.js";
import type { DangerousToken } from "./safety/index.js";

/** TUI data provider backed by a remote grove-server HTTP API. */
export class RemoteDataProvider
  implements
    TuiDataProvider,
    TuiOutcomeProvider,
    TuiArtifactProvider,
    TuiMessagingProvider,
    TuiCostProvider,
    TuiAskUserProvider,
    TuiGitHubProvider,
    TuiBountyProvider,
    TuiGossipProvider,
    TuiGoalProvider,
    TuiSessionProvider,
    TuiHandoffProvider
{
  readonly capabilities: ProviderCapabilities = {
    outcomes: true,
    artifacts: true,
    vfs: false,
    messaging: true,
    costTracking: true,
    askUser: true,
    github: true,
    bounties: true,
    gossip: true,
    goals: true,
    sessions: true,
    handoffs: true, // Available via GET /api/handoffs on the local grove server
  };

  readonly baseUrl: string;
  private readonly label: string;
  private readonly apiKey: string | undefined;
  /** Set by {@link setSessionScope} — scopes contribution and frontier reads to this session. */
  private activeSessionId: string | undefined;

  constructor(baseUrl: string, options?: { apiKey?: string; backendLabel?: string } | string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    if (typeof options === "string") {
      // Legacy: constructor(baseUrl, backendLabel)
      this.label = options ?? `remote (${this.baseUrl})`;
      this.apiKey = undefined;
    } else {
      this.label = options?.backendLabel ?? `remote (${this.baseUrl})`;
      this.apiKey = options?.apiKey;
    }
  }

  /** Auth headers sent on every request when an API key is configured. */
  private get authHeaders(): Record<string, string> {
    return this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {};
  }

  /** Public auth headers for direct fetch calls that bypass provider methods. */
  get httpAuthHeaders(): Record<string, string> {
    return this.authHeaders;
  }

  /**
   * Scope all subsequent contribution and frontier reads to the given session.
   * Called by screen-manager.tsx when a session is started or resumed.
   */
  setSessionScope(sessionId: string): void {
    const prev = this.activeSessionId;
    this.activeSessionId = sessionId;
    if (prev === undefined) {
      for (const fn of [...this.scopeListeners]) {
        try {
          fn(true);
        } catch (err) {
          process.stderr.write(`[remote-provider] scope listener threw: ${String(err)}\n`);
        }
      }
    }
  }

  /**
   * Whether a session scope is currently active. Migrated views (PR2 #388)
   * gate the informer hook path on this — the watch protocol does not
   * forward sessionId, so a scoped view would otherwise observe the full
   * namespace stream and leak cross-session contributions. Until PR3+
   * extends `/api/watch` with sessionId, scoped views stay on polling.
   */
  hasSessionScope(): boolean {
    return this.activeSessionId !== undefined;
  }

  /**
   * Subscribe to scope on/off transitions. Returns an unsubscribe.
   * The InformerProvider hooks this so the remote watch factory can
   * stop streaming as soon as the user enters a scoped session — the
   * watch route does not filter by sessionId, so a running factory
   * would otherwise keep pulling cross-session data. PR2 (#388),
   * Codex round 2 finding 1.
   */
  onSessionScopeChange(listener: (scoped: boolean) => void): () => void {
    this.scopeListeners.add(listener);
    return () => {
      this.scopeListeners.delete(listener);
    };
  }

  private readonly scopeListeners = new Set<(scoped: boolean) => void>();

  private sessionScopedUrl(path: string, params?: URLSearchParams): string {
    const url = new URL(`${this.baseUrl}${path}`);
    if (params !== undefined) {
      for (const [key, value] of params) {
        url.searchParams.append(key, value);
      }
    }
    if (this.activeSessionId !== undefined && !url.searchParams.has("sessionId")) {
      url.searchParams.set("sessionId", this.activeSessionId);
    }
    return url.toString();
  }

  private handoffActionUrl(
    handoffId: string,
    action: string,
    sessionId?: string | undefined,
  ): string {
    const params = new URLSearchParams();
    const effective = sessionId ?? this.activeSessionId;
    if (effective) params.set("sessionId", effective);
    const qs = params.toString();
    return `${this.baseUrl}/api/handoffs/${encodeURIComponent(handoffId)}/${action}${qs ? `?${qs}` : ""}`;
  }

  private async postHandoffAction(
    url: string,
    body: Readonly<Record<string, unknown>> = {},
  ): Promise<void> {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.authHeaders },
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(`HTTP ${String(resp.status)}: ${resp.statusText}`);
  }

  async getDashboard(): Promise<DashboardData> {
    const [metadata, recentContributions, frontier] = await Promise.all([
      this.fetchGroveMetadata(),
      this.getContributions({ limit: 10 }),
      this.getFrontier({ limit: 3 }),
    ]);

    // Claims have no session ownership — suppress when session-scoped to avoid
    // cross-session pollution of dashboard counts and role-status indicators.
    const activeClaims = this.activeSessionId ? [] : await this.getClaims({ status: "active" });

    const frontierSummary = buildFrontierSummary(frontier);

    // `/api/grove` aggregates contributionCount/activeClaimCount across every
    // session. When the dashboard is scoped (activeSessionId set), those
    // global counts are inconsistent with the rest of the view (recent
    // contributions, claims, frontier all session-scoped). Zero them out so
    // the header doesn't mislead the operator about the current session's
    // activity — the scoped recentContributions / frontier already tell the
    // true story.
    const scopedMetadata =
      this.activeSessionId !== undefined
        ? { ...metadata, contributionCount: 0, activeClaimCount: 0 }
        : metadata;

    return {
      metadata: scopedMetadata,
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
    if (query?.sessionId) params.set("sessionId", query.sessionId);

    const resp = await fetch(this.sessionScopedUrl("/api/contributions", params), {
      headers: this.authHeaders,
    });
    if (!resp.ok) throw new Error(`HTTP ${String(resp.status)}: ${resp.statusText}`);
    return parseContributions(await resp.json());
  }

  async getContribution(cid: string): Promise<ContributionDetail | undefined> {
    const resp = await fetch(
      this.sessionScopedUrl(`/api/contributions/${encodeURIComponent(cid)}`),
      {
        headers: this.authHeaders,
      },
    );
    if (resp.status === 404) return undefined;
    if (!resp.ok) throw new Error(`HTTP ${String(resp.status)}: ${resp.statusText}`);
    const contribution = parseContribution(await resp.json());

    const [ancestorsResp, childrenResp, threadResp] = await Promise.all([
      fetch(this.sessionScopedUrl(`/api/dag/${encodeURIComponent(cid)}/ancestors`), {
        headers: this.authHeaders,
      }),
      fetch(this.sessionScopedUrl(`/api/dag/${encodeURIComponent(cid)}/children`), {
        headers: this.authHeaders,
      }),
      fetch(this.sessionScopedUrl(`/api/threads/${encodeURIComponent(cid)}`), {
        headers: this.authHeaders,
      }),
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
    const resp = await fetch(`${this.baseUrl}/api/claims${qs ? `?${qs}` : ""}`, {
      headers: this.authHeaders,
    });
    if (!resp.ok) throw new Error(`HTTP ${String(resp.status)}: ${resp.statusText}`);
    const body = (await resp.json()) as { claims: unknown };
    return parseClaims(body.claims);
  }

  async getAgentTasks(): Promise<readonly AgentTaskView[]> {
    const resp = await fetch(`${this.baseUrl}/api/agent-tasks`, {
      headers: this.authHeaders,
    });
    if (resp.status === 501) return [];
    if (!resp.ok) throw new Error(`HTTP ${String(resp.status)}: ${resp.statusText}`);
    return (await resp.json()) as readonly AgentTaskView[];
  }

  async createClaim(input: ClaimInput): Promise<Claim> {
    const resp = await fetch(`${this.baseUrl}/api/claims`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.authHeaders },
      body: JSON.stringify(input),
    });
    if (!resp.ok) throw new Error(`HTTP ${String(resp.status)}: ${resp.statusText}`);
    return parseClaim(await resp.json());
  }

  async releaseClaim(claimId: string): Promise<void> {
    const resp = await fetch(`${this.baseUrl}/api/claims/${encodeURIComponent(claimId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...this.authHeaders },
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
    if (query?.sessionId) params.set("sessionId", query.sessionId);

    const resp = await fetch(this.sessionScopedUrl("/api/frontier", params), {
      headers: this.authHeaders,
    });
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
        fetch(this.sessionScopedUrl(`/api/dag/${encodeURIComponent(rootCid)}/ancestors`), {
          headers: this.authHeaders,
        }),
        fetch(this.sessionScopedUrl(`/api/dag/${encodeURIComponent(rootCid)}/children`), {
          headers: this.authHeaders,
        }),
        fetch(this.sessionScopedUrl(`/api/contributions/${encodeURIComponent(rootCid)}`), {
          headers: this.authHeaders,
        }),
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
    const resp = await fetch(this.sessionScopedUrl("/api/threads", params), {
      headers: this.authHeaders,
    });
    if (!resp.ok) throw new Error(`HTTP ${String(resp.status)}: ${resp.statusText}`);
    const body = (await resp.json()) as { threads: unknown };
    return parseThreadSummaries(body.threads);
  }

  async getWorkBlocks(query?: {
    readonly sessionId?: string | undefined;
  }): Promise<readonly WorkBlock[]> {
    const params = new URLSearchParams();
    if (query?.sessionId !== undefined) params.set("sessionId", query.sessionId);
    const resp = await fetch(this.sessionScopedUrl("/api/work-blocks", params), {
      headers: this.authHeaders,
    });
    if (!resp.ok) throw new Error(`HTTP ${String(resp.status)}: ${resp.statusText}`);
    const body = (await resp.json()) as { readonly items?: unknown };
    return parseWorkBlocks(body.items ?? []);
  }

  async getTimeline(query?: {
    readonly sessionId?: string | undefined;
    readonly afterRv?: string | undefined;
    readonly limit?: number | undefined;
    readonly includeWorkBlocks?: boolean | undefined;
  }): Promise<SessionTimeline> {
    const params = new URLSearchParams();
    if (query?.sessionId !== undefined) params.set("sessionId", query.sessionId);
    if (query?.afterRv !== undefined) params.set("afterRv", query.afterRv);
    if (query?.limit !== undefined) params.set("limit", String(query.limit));
    if (query?.includeWorkBlocks === true) params.set("includeWorkBlocks", "true");
    const resp = await fetch(this.sessionScopedUrl("/api/timeline", params), {
      headers: this.authHeaders,
    });
    if (!resp.ok) throw new Error(`HTTP ${String(resp.status)}: ${resp.statusText}`);
    return parseSessionTimeline(await resp.json());
  }

  // ---------------------------------------------------------------------------
  // TuiOutcomeProvider
  // ---------------------------------------------------------------------------

  async getOutcome(cid: string): Promise<OutcomeRecord | undefined> {
    const resp = await fetch(`${this.baseUrl}/api/outcomes/${encodeURIComponent(cid)}`, {
      headers: this.authHeaders,
    });
    if (resp.status === 404 || resp.status === 501) return undefined;
    if (!resp.ok) throw new Error(`HTTP ${String(resp.status)}: ${resp.statusText}`);
    return parseOutcomeRecord(await resp.json());
  }

  async getOutcomes(cids: readonly string[]): Promise<ReadonlyMap<string, OutcomeRecord>> {
    if (cids.length === 0) return new Map();

    const map = new Map<string, OutcomeRecord>();
    const CHUNK_SIZE = 50;

    // Chunk CIDs to avoid overly long URLs
    const chunks: string[][] = [];
    for (let i = 0; i < cids.length; i += CHUNK_SIZE) {
      chunks.push(cids.slice(i, i + CHUNK_SIZE) as string[]);
    }

    const chunkResults = await Promise.allSettled(
      chunks.map(async (chunk) => {
        const params = new URLSearchParams({ cids: chunk.join(",") });
        const resp = await fetch(`${this.baseUrl}/api/outcomes?${params.toString()}`, {
          headers: this.authHeaders,
        });
        if (!resp.ok) throw new Error(`HTTP ${String(resp.status)}: ${resp.statusText}`);
        return parseOutcomeRecords(await resp.json());
      }),
    );

    for (let i = 0; i < chunkResults.length; i++) {
      const result = chunkResults[i] as PromiseSettledResult<readonly OutcomeRecord[]>;
      const chunk = chunks[i] as string[];
      if (result.status === "fulfilled") {
        for (const record of result.value) {
          map.set(record.cid, record);
        }
      } else {
        // Fall back to individual fetches so one bad chunk doesn't hide valid outcomes
        const fallbackResults = await Promise.allSettled(chunk.map((cid) => this.getOutcome(cid)));
        for (const fb of fallbackResults) {
          if (fb.status === "fulfilled" && fb.value !== undefined) {
            map.set(fb.value.cid, fb.value);
          }
        }
      }
    }

    return map;
  }

  async getOutcomeStats(): Promise<OperatorStats> {
    try {
      const resp = await fetch(`${this.baseUrl}/api/outcomes/stats`, { headers: this.authHeaders });
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
      const resp = await fetch(`${this.baseUrl}/api/outcomes${qs ? `?${qs}` : ""}`, {
        headers: this.authHeaders,
      });
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
      this.sessionScopedUrl(
        `/api/contributions/${encodeURIComponent(cid)}/artifacts/${encodeURIComponent(name)}`,
      ),
      { headers: this.authHeaders },
    );
    if (!resp.ok) throw new Error(`HTTP ${String(resp.status)}: ${resp.statusText}`);
    const arrayBuffer = await resp.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  async getArtifactMeta(cid: string, name: string): Promise<ArtifactMeta> {
    const resp = await fetch(
      this.sessionScopedUrl(
        `/api/contributions/${encodeURIComponent(cid)}/artifacts/${encodeURIComponent(name)}/meta`,
      ),
      { headers: this.authHeaders },
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
    return diffArtifactsUsing((cid, n) => this.getArtifact(cid, n), parentCid, childCid, name);
  }

  async search(query: string): Promise<readonly Contribution[]> {
    const params = new URLSearchParams({ q: query });
    const resp = await fetch(this.sessionScopedUrl("/api/search", params), {
      headers: this.authHeaders,
    });
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
      const resp = await fetch(`${this.baseUrl}/api/bounties${qs ? `?${qs}` : ""}`, {
        headers: this.authHeaders,
      });
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
      const resp = await fetch(`${this.baseUrl}/api/gossip/peers`, { headers: this.authHeaders });
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
  // TuiMessagingProvider
  // ---------------------------------------------------------------------------

  /** Boardroom summary URL — includes `?sessionId=` when a session scope is active. */
  private get boardroomSummaryUrl(): string {
    const base = `${this.baseUrl}/api/boardroom/summary`;
    return this.activeSessionId
      ? `${base}?sessionId=${encodeURIComponent(this.activeSessionId)}`
      : base;
  }

  async getInboxMessages(query?: {
    recipient?: string;
    limit?: number;
  }): Promise<readonly InboxMessage[]> {
    try {
      const resp = await fetch(this.boardroomSummaryUrl, { headers: this.authHeaders });
      if (!resp.ok) return [];
      const body = (await resp.json()) as {
        recentMessages: readonly {
          fromAgentId: string;
          fromAgentName?: string;
          body: string;
          recipients: readonly string[];
          createdAt: string;
          cid: string;
        }[];
      };
      let messages = body.recentMessages.map((m) => ({
        cid: m.cid,
        from: {
          agentId: m.fromAgentId,
          ...(m.fromAgentName !== undefined ? { agentName: m.fromAgentName } : {}),
        },
        body: m.body,
        recipients: [...m.recipients],
        createdAt: m.createdAt,
      }));
      if (query?.recipient) {
        const target = query.recipient;
        messages = messages.filter(
          (m) => m.recipients.includes(target) || m.recipients.includes("@all"),
        );
      }
      if (query?.limit) messages = messages.slice(0, query.limit);
      return messages;
    } catch {
      return [];
    }
  }

  // ---------------------------------------------------------------------------
  // TuiCostProvider
  // ---------------------------------------------------------------------------

  async getSessionCosts(): Promise<SessionCostSummary> {
    try {
      const resp = await fetch(this.boardroomSummaryUrl, { headers: this.authHeaders });
      if (!resp.ok) return { totalCostUsd: 0, totalTokens: 0, byAgent: [] };
      const body = (await resp.json()) as {
        costSummary: {
          totalCostUsd: number;
          totalTokens: number;
          byAgent: readonly {
            agentId: string;
            agentName?: string;
            costUsd: number;
            tokens: number;
          }[];
        };
      };
      return body.costSummary;
    } catch {
      return { totalCostUsd: 0, totalTokens: 0, byAgent: [] };
    }
  }

  // ---------------------------------------------------------------------------
  // TuiAskUserProvider
  // ---------------------------------------------------------------------------

  async getPendingQuestions(): Promise<readonly PendingQuestion[]> {
    try {
      const resp = await fetch(this.boardroomSummaryUrl, { headers: this.authHeaders });
      if (!resp.ok) return [];
      const body = (await resp.json()) as {
        pendingQuestions: readonly {
          cid: string;
          agentName?: string;
          question: string;
          options?: readonly string[];
          createdAt: string;
        }[];
      };
      return body.pendingQuestions;
    } catch {
      return [];
    }
  }

  async answerQuestion(questionCid: string, answer: string): Promise<void> {
    const resp = await fetch(`${this.baseUrl}/api/boardroom/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.authHeaders },
      body: JSON.stringify({
        questionCid,
        answer,
        ...(this.activeSessionId !== undefined ? { sessionId: this.activeSessionId } : {}),
      }),
    });
    if (!resp.ok) {
      throw new Error(`Failed to answer question: HTTP ${String(resp.status)}`);
    }
  }

  // ---------------------------------------------------------------------------
  // TuiGitHubProvider
  // ---------------------------------------------------------------------------

  async getActivePR(): Promise<GitHubPRSummary | undefined> {
    // gh CLI runs locally even for remote providers
    const { getActivePR: getActivePRFn } = await import("../github/active-pr.js");
    return getActivePRFn();
  }

  // ---------------------------------------------------------------------------
  // TuiGoalProvider — delegates to shared HTTP helpers
  // ---------------------------------------------------------------------------

  async getGoal(): Promise<import("./provider.js").GoalData | undefined> {
    try {
      return await fetchGoalHttp(this.baseUrl, this.authHeaders);
    } catch {
      /* server unreachable */
    }
    return undefined;
  }

  async setGoal(
    token: DangerousToken<"Goal">,
    goal: string,
    acceptance: readonly string[],
  ): Promise<import("./provider.js").GoalData> {
    return setGoalHttp(token, this.baseUrl, goal, acceptance, this.authHeaders);
  }

  // ---------------------------------------------------------------------------
  // TuiSessionProvider — delegates to shared HTTP helpers
  // ---------------------------------------------------------------------------

  async listSessions(query?: {
    status?: "active" | "archived";
    presetName?: string;
  }): Promise<readonly import("./provider.js").SessionRecord[]> {
    try {
      return await listSessionsHttp(this.baseUrl, query, this.authHeaders);
    } catch {
      /* fall through */
    }
    return [];
  }

  async createSession(
    input: import("./provider.js").SessionInput,
  ): Promise<import("./provider.js").SessionRecord> {
    return createSessionHttp(this.baseUrl, input, this.authHeaders);
  }

  async getSession(sessionId: string): Promise<import("./provider.js").SessionRecord | undefined> {
    try {
      return await getSessionHttp(this.baseUrl, sessionId, this.authHeaders);
    } catch {
      /* fall through */
    }
    return undefined;
  }

  async archiveSession(token: DangerousToken<"AgentSession">): Promise<void> {
    return archiveSessionHttp(token, this.baseUrl, this.authHeaders);
  }

  async addContributionToSession(sessionId: string, cid: string): Promise<void> {
    return addContributionToSessionHttp(this.baseUrl, sessionId, cid, this.authHeaders);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async fetchGroveMetadata(): Promise<GroveMetadata> {
    try {
      const resp = await fetch(`${this.baseUrl}/api/grove`, { headers: this.authHeaders });
      if (resp.ok) {
        const data = (await resp.json()) as {
          name?: string;
          goal?: string;
          activeSessionId?: string;
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
          ...(data.goal !== undefined ? { goal: data.goal } : {}),
          ...(data.activeSessionId !== undefined ? { activeSessionId: data.activeSessionId } : {}),
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

  async markHandoffDelivered(handoffId: string, sessionId?: string): Promise<void> {
    // Callers may pass an explicit `sessionId` to pin the scope to whatever
    // was active when they read the handoff — guards against activeSessionId
    // flipping between the preceding getHandoffs() and this POST (rare, but
    // would otherwise strand the handoff in pending_pickup when the POST
    // lands in the new session's scoped store that doesn't know this id).
    await fetch(this.handoffActionUrl(handoffId, "delivered", sessionId), {
      method: "POST",
      headers: this.authHeaders,
    });
  }

  async cancelHandoff(handoffId: string, reason?: string, sessionId?: string): Promise<void> {
    await this.postHandoffAction(this.handoffActionUrl(handoffId, "cancel", sessionId), {
      ...(reason !== undefined ? { reason } : {}),
    });
  }

  async manualResolveHandoff(
    handoffId: string,
    reason?: string,
    sessionId?: string,
  ): Promise<void> {
    await this.postHandoffAction(this.handoffActionUrl(handoffId, "manual-resolve", sessionId), {
      ...(reason !== undefined ? { reason } : {}),
    });
  }

  async resendHandoff(
    handoffId: string,
    options?: {
      readonly reason?: string | undefined;
      readonly replyDueAt?: string | undefined;
      readonly sessionId?: string | undefined;
    },
  ): Promise<void> {
    await this.postHandoffAction(this.handoffActionUrl(handoffId, "resend", options?.sessionId), {
      ...(options?.reason !== undefined ? { reason: options.reason } : {}),
      ...(options?.replyDueAt !== undefined ? { replyDueAt: options.replyDueAt } : {}),
    });
  }

  async rerouteHandoff(
    handoffId: string,
    options: {
      readonly toRole: string;
      readonly reason?: string | undefined;
      readonly replyDueAt?: string | undefined;
      readonly sessionId?: string | undefined;
    },
  ): Promise<void> {
    await this.postHandoffAction(this.handoffActionUrl(handoffId, "reroute", options.sessionId), {
      toRole: options.toRole,
      ...(options.reason !== undefined ? { reason: options.reason } : {}),
      ...(options.replyDueAt !== undefined ? { replyDueAt: options.replyDueAt } : {}),
    });
  }

  async getHandoffs(query?: HandoffQuery): Promise<readonly Handoff[]> {
    const params = new URLSearchParams();
    if (query?.toRole) params.set("toRole", query.toRole);
    if (query?.fromRole) params.set("fromRole", query.fromRole);
    if (query?.sourceCid) params.set("sourceCid", query.sourceCid);
    if (query?.status)
      params.set("status", Array.isArray(query.status) ? (query.status[0] ?? "") : query.status);
    if (query?.limit) params.set("limit", String(query.limit));
    if (this.activeSessionId) params.set("sessionId", this.activeSessionId);
    const qs = params.toString();
    const resp = await fetch(`${this.baseUrl}/api/handoffs${qs ? `?${qs}` : ""}`, {
      headers: this.authHeaders,
    });
    if (!resp.ok) return [];
    const data = (await resp.json()) as { handoffs?: Handoff[] };
    return data.handoffs ?? [];
  }

  close(): void {
    // No resources to release for HTTP client
  }
}
