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
import { listAvailableSkills } from "../core/runtime-skill-acquisition.js";
import type { WorkspaceManager } from "../core/workspace.js";
import type { GoalSessionStore } from "../local/sqlite-goal-session-store.js";
import { listBundledPrompts } from "../mcp/prompts.js";
import type { NexusClient } from "../nexus/client.js";
import type { NexusConfig } from "../nexus/config.js";
import { resolveConfig } from "../nexus/config.js";
import { NexusBountyStore } from "../nexus/nexus-bounty-store.js";
import { NexusClaimStore } from "../nexus/nexus-claim-store.js";
import { NexusContributionStore } from "../nexus/nexus-contribution-store.js";
import { NexusInboxClient } from "../nexus/nexus-inbox-client.js";
import { NexusOutcomeStore } from "../nexus/nexus-outcome-store.js";
import { NexusSessionStore } from "../nexus/nexus-session-store.js";
import { casMetaPath, casPath } from "../nexus/vfs-paths.js";
import { debugLog } from "./debug-log.js";
import type {
  ArtifactMeta,
  FsEntry,
  GoalData,
  PromptInfo,
  ProviderCapabilities,
  SessionRecord,
  SkillInfo,
  TuiArtifactProvider,
  TuiBountyProvider,
  TuiGossipProvider,
  TuiPromptProvider,
  TuiSkillProvider,
  TuiVfsProvider,
} from "./provider.js";
import {
  addContributionToSessionHttp,
  archiveSessionHttp,
  contributionsForCidsInOrder,
  createSessionHttp,
  fetchGoalHttp,
  getSessionContributionsHttp,
  getSessionHttp,
  listSessionsHttp,
  setGoalHttp,
} from "./provider-shared.js";
import type { DangerousToken } from "./safety/index.js";
import { mintTokenForCompensation } from "./safety/internal/compensation.js";
import { StoreBackedProvider } from "./store-backed-provider.js";

/** Configuration for the Nexus provider. */
export interface NexusProviderConfig {
  readonly nexusConfig: NexusConfig;
  readonly groveName?: string | undefined;
  readonly nexusUrl?: string | undefined;
  readonly apiKey?: string | undefined;
  /** Optional workspace manager for local workspace lifecycle (hybrid mode). */
  readonly workspaceManager?: WorkspaceManager | undefined;
  readonly backendLabel?: string | undefined;
  /**
   * Optional URL of a co-located grove server.
   * When provided, goal/session state and gossip peer data are fetched
   * from the server's HTTP API so that all agents share the same state.
   */
  readonly serverUrl?: string | undefined;
  /** Bearer token for authenticating to the co-located server (from .grove/api-key). */
  readonly serverApiKey?: string | undefined;
  /** Optional goal/session store — only used when no serverUrl is available. */
  readonly goalSessionStore?: GoalSessionStore | undefined;
  /** Optional handoff store — reads from local grove.db, not Nexus. */
  readonly handoffStore?: import("../core/handoff.js").HandoffStore | undefined;
}

/** TUI data provider backed by Nexus VFS. */
export class NexusDataProvider
  extends StoreBackedProvider
  implements
    TuiArtifactProvider,
    TuiVfsProvider,
    TuiBountyProvider,
    TuiGossipProvider,
    TuiPromptProvider,
    TuiSkillProvider
{
  readonly capabilities: ProviderCapabilities;

  /**
   * Public discriminator — `"nexus"` here, `"local"` on the sqlite provider.
   * Used by the TUI to decide whether fatal session-create failures can
   * safely fall back to a synthetic UUID (local mode: yes, Nexus mode: no,
   * because the authoritative Nexus store has never seen the fake id).
   */
  readonly mode = "nexus" as const;

  private readonly client: NexusClient;
  private readonly zoneId: string;
  private readonly bountyStore: NexusBountyStore;
  private readonly serverUrl: string | undefined;
  private readonly serverApiKey: string | undefined;
  private readonly nexusUrl: string | undefined;
  private readonly apiKey: string | undefined;
  private readonly nexusSessionStore: NexusSessionStore;

  constructor(config: NexusProviderConfig) {
    const resolved = resolveConfig(config.nexusConfig);
    const store = new NexusContributionStore(config.nexusConfig);
    const claims = new NexusClaimStore(config.nexusConfig);
    const outcomes = new NexusOutcomeStore(config.nexusConfig);
    const frontier = new DefaultFrontierCalculator(store);
    const inboxReadSource =
      config.nexusUrl !== undefined
        ? new NexusInboxClient({
            nexusUrl: config.nexusUrl,
            ...(config.apiKey ? { apiKey: config.apiKey } : {}),
            client: resolved.client,
            sessionId: resolved.sessionId,
            zoneId: resolved.zoneId,
          })
        : undefined;
    super({
      contributionStore: store,
      claimStore: claims,
      frontier,
      groveName: config.groveName ?? "nexus",
      outcomeStore: outcomes,
      workspace: config.workspaceManager,
      backendLabel: config.backendLabel ?? "nexus",
      goalSessionStore: config.goalSessionStore,
      handoffStore: config.handoffStore,
      inboxReadSource,
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
      sessions: true, // Always available via NexusSessionStore
      // Handoffs are in local grove.db (written by MCP, readable from SQLite)
      handoffs: !!config.handoffStore,
      prompts: true,
      skills: true,
    };

    this.bountyStore = new NexusBountyStore(config.nexusConfig);
    this.serverUrl = config.serverUrl?.replace(/\/+$/, "");
    this.serverApiKey = config.serverApiKey;
    this.nexusUrl = config.nexusUrl;
    this.apiKey = config.apiKey;

    this.client = resolved.client;
    this.zoneId = resolved.zoneId;
    this.nexusSessionStore = new NexusSessionStore(this.client, this.zoneId);
  }

  getNexusZoneId(): string {
    return this.zoneId;
  }

  private get authHeaders(): Record<string, string> | undefined {
    return this.serverApiKey ? { Authorization: `Bearer ${this.serverApiKey}` } : undefined;
  }

  /**
   * Switch to a session-scoped contribution store.
   * Called when a session is selected/created — subsequent reads only see
   * contributions from this session, avoiding the N+1 VFS read storm from
   * scanning all historical contributions.
   */
  override setSessionScope(sessionId: string): void {
    super.setSessionScope(sessionId); // sets this.activeSessionId
    const oldId = this.store.storeIdentity;
    const scopedStore = new NexusContributionStore({
      ...({ client: this.client, zoneId: this.zoneId } as NexusConfig),
      sessionId,
    });
    const newId = scopedStore.storeIdentity;
    debugLog(
      "provider.setSessionScope",
      `sessionId=${sessionId} oldStoreId=${oldId} newStoreId=${newId}`,
    );
    // Replace the inherited store (StoreBackedProvider.store)
    (this as unknown as { store: NexusContributionStore }).store = scopedStore;
    // Also update the frontier calculator to use the scoped store
    (this as unknown as { calc: DefaultFrontierCalculator }).calc = new DefaultFrontierCalculator(
      scopedStore,
    );
    this.setInboxReadSource(
      this.nexusUrl !== undefined
        ? new NexusInboxClient({
            nexusUrl: this.nexusUrl,
            ...(this.apiKey ? { apiKey: this.apiKey } : {}),
            client: this.client,
            sessionId,
            zoneId: this.zoneId,
          })
        : undefined,
    );
    // Handoff store uses readAllHandoffs (dir scan) — no session scoping needed.
    // The sessionStartedAt time filter in HandoffsView handles session isolation.
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
        const resp = await fetch(`${this.serverUrl}/api/gossip/peers`, {
          headers: this.authHeaders,
        });
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
        return await fetchGoalHttp(this.serverUrl, this.authHeaders);
      } catch {
        /* server unreachable — fall through to local store */
      }
    }
    return super.getGoal();
  }

  override async setGoal(
    token: DangerousToken<"Goal">,
    goal: string,
    acceptance: readonly string[],
  ): Promise<GoalData> {
    if (this.serverUrl) {
      return setGoalHttp(token, this.serverUrl, goal, acceptance, this.authHeaders);
    }
    return super.setGoal(token, goal, acceptance);
  }

  override async listSessions(query?: {
    status?: "active" | "archived";
    presetName?: string;
  }): Promise<readonly SessionRecord[]> {
    if (this.serverUrl) {
      try {
        return await listSessionsHttp(this.serverUrl, query, this.authHeaders);
      } catch {
        /* fall through */
      }
    }
    return super.listSessions(query);
  }

  override async createSession(
    input: import("./provider.js").SessionInput,
  ): Promise<SessionRecord> {
    let result: SessionRecord;
    if (this.serverUrl) {
      try {
        result = await createSessionHttp(this.serverUrl, input, this.authHeaders);
      } catch {
        // HTTP server not running — fall back to local SQLite
        result = await super.createSession(input);
      }
    } else {
      result = await super.createSession(input);
    }
    // Mirror to Nexus VFS BEFORE returning. The stdio MCP server is spawned
    // per agent shortly after this returns (TUI → setSessionScope → spawn),
    // and it loads its GroveContract from this exact record. A fire-and-forget
    // write used to race the spawn and leave the MCP server with "session not
    // found", which (since the serve.ts rewrite) now fails closed and kills
    // the spawn. Awaiting serializes the mirror before the agent starts.
    //
    // Retry a few times to absorb transient Nexus blips before giving up.
    // On final failure we ARCHIVE the local session so each retry doesn't
    // create a new orphan `active` record without a Nexus counterpart.
    // Without this cleanup, users pressing "retry" would accumulate
    // abandoned local sessions that can later show up in session lists
    // and fail closed when agents are spawned against them.
    const retryDelaysMs = [0, 200, 500, 1000];
    let lastErr: unknown;
    for (const delay of retryDelaysMs) {
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      try {
        await this.nexusSessionStore.putSession(result);
        lastErr = undefined;
        break;
      } catch (err) {
        lastErr = err;
      }
    }
    if (lastErr) {
      const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
      process.stderr.write(
        `[nexus-provider] FATAL: session mirror to Nexus failed after retries: ${msg}\n`,
      );
      // Compensate: archive the just-created local/server session so retries
      // don't leave orphan active records. Best-effort — we still rethrow
      // either way so the caller sees the original mirror error.
      //
      // C6 (#304): mint a compensation token from the freshly-created
      // session's resourceVersion. The session was created moments ago in
      // this very method, so no operator confirmation is needed; CAS is
      // still enforced server-side. See `safety/internal/compensation.ts`.
      try {
        const rv = String(result.resourceVersion ?? 1);
        const token = mintTokenForCompensation("AgentSession", result.id, rv);
        await this.archiveSession(token);
      } catch (archiveErr) {
        process.stderr.write(
          `[nexus-provider] WARN: failed to archive orphan session ${result.id}: ` +
            `${archiveErr instanceof Error ? archiveErr.message : String(archiveErr)}\n`,
        );
      }
      throw new Error(
        `Failed to mirror session ${result.id} to Nexus: ${msg}. ` +
          `The local session has been archived; please retry.`,
      );
    }
    return result;
  }

  override async getSession(sessionId: string): Promise<SessionRecord | undefined> {
    if (this.serverUrl) {
      try {
        return await getSessionHttp(this.serverUrl, sessionId, this.authHeaders);
      } catch {
        /* fall through */
      }
    }
    return super.getSession(sessionId);
  }

  override async getSessionContributions(sessionId: string): Promise<readonly Contribution[]> {
    const scopedStore = new NexusContributionStore({
      ...({ client: this.client, zoneId: this.zoneId } as NexusConfig),
      sessionId,
    });
    try {
      const scopedContributions = await scopedStore.list();
      if (scopedContributions.length > 0) return scopedContributions;
    } finally {
      scopedStore.close();
    }

    if (this.serverUrl) {
      try {
        const serverContributions = await getSessionContributionsHttp(
          this.serverUrl,
          sessionId,
          this.authHeaders,
        );
        if (serverContributions.length > 0) return serverContributions;
      } catch {
        /* fall through to Nexus VFS */
      }
    }
    const cids = await this.nexusSessionStore.getContributions(sessionId);
    return contributionsForCidsInOrder(this.store, cids);
  }

  override async archiveSession(token: DangerousToken<"AgentSession">): Promise<void> {
    if (this.serverUrl) {
      return archiveSessionHttp(token, this.serverUrl, this.authHeaders);
    }
    return super.archiveSession(token);
  }

  override async addContributionToSession(sessionId: string, cid: string): Promise<void> {
    if (this.serverUrl) {
      return addContributionToSessionHttp(this.serverUrl, sessionId, cid, this.authHeaders);
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

  async readFile(path: string, maxBytes?: number): Promise<Buffer | undefined> {
    const vfsPath = `/zones/${this.zoneId}${path.startsWith("/") ? path : `/${path}`}`;
    const data = await this.client.read(vfsPath);
    if (data === undefined) return undefined;
    const buf = Buffer.from(data);
    return maxBytes !== undefined && buf.length > maxBytes ? buf.subarray(0, maxBytes) : buf;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // TuiPromptProvider
  // ---------------------------------------------------------------------------

  async listMcpPrompts(): Promise<readonly PromptInfo[]> {
    const defs = await listBundledPrompts();
    return defs.map((d) => ({ name: d.name, description: d.description, template: d.template }));
  }

  // ---------------------------------------------------------------------------
  // TuiSkillProvider
  // ---------------------------------------------------------------------------

  async listAvailableSkills(): Promise<readonly SkillInfo[]> {
    const skills = await listAvailableSkills();
    return skills.map((s) => ({ name: s.name }));
  }

  protected override closeExtra(): void {
    this.bountyStore.close();
    // workspace is closed by the base class
  }
}
