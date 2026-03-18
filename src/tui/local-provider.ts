/**
 * Local data provider for the TUI.
 *
 * Extends {@link StoreBackedProvider} with local-specific behaviour:
 * artifact access via a local CAS, bounty listing, and local resource
 * cleanup.  Used when running `grove tui` against a local .grove directory.
 */

import type { Bounty } from "../core/bounty.js";
import type { BountyQuery, BountyStore } from "../core/bounty-store.js";
import type { ContentStore } from "../core/cas.js";
import type { Contribution } from "../core/models.js";
import type { GoalSessionStore } from "../local/sqlite-goal-session-store.js";
import type {
  ArtifactMeta,
  ProviderCapabilities,
  TuiArtifactProvider,
  TuiBountyProvider,
} from "./provider.js";
import { StoreBackedProvider, type StoreBackedProviderDeps } from "./store-backed-provider.js";

// ---------------------------------------------------------------------------
// Dependency bundle
// ---------------------------------------------------------------------------

/** Configuration for the local provider. */
export interface LocalProviderDeps extends StoreBackedProviderDeps {
  readonly bountyStore?: BountyStore | undefined;
  readonly cas?: ContentStore | undefined;
  readonly goalSessionStore?: GoalSessionStore | undefined;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/** TUI data provider backed by local SQLite stores. */
export class LocalDataProvider
  extends StoreBackedProvider
  implements TuiArtifactProvider, TuiBountyProvider
{
  protected readonly mode = "local";

  readonly capabilities: ProviderCapabilities;

  private readonly bountyStore: BountyStore | undefined;
  private readonly cas: ContentStore | undefined;

  constructor(deps: LocalProviderDeps) {
    super({ ...deps, backendLabel: deps.backendLabel ?? "local (.grove/)" });
    this.bountyStore = deps.bountyStore;
    this.cas = deps.cas;
    this.capabilities = {
      outcomes: deps.outcomeStore !== undefined,
      artifacts: deps.cas !== undefined,
      vfs: false,
      messaging: true,
      costTracking: true,
      askUser: true,
      github: true,
      bounties: true,
      gossip: false,
      goals: deps.goalSessionStore !== undefined,
      sessions: deps.goalSessionStore !== undefined,
    };
  }

  // ---------------------------------------------------------------------------
  // TuiArtifactProvider
  // ---------------------------------------------------------------------------

  async getArtifact(cid: string, name: string): Promise<Buffer> {
    const contribution = await this.store.get(cid);
    if (!contribution) throw new Error(`Contribution not found: ${cid}`);

    const contentHash = contribution.artifacts[name];
    if (contentHash === undefined) {
      throw new Error(`Artifact '${name}' not found on contribution ${cid}`);
    }

    if (this.cas) {
      const data = await this.cas.get(contentHash);
      if (data) return Buffer.from(data);
    }

    // Fallback: return the content hash as a buffer
    return Buffer.from(contentHash, "utf-8");
  }

  async getArtifactMeta(cid: string, name: string): Promise<ArtifactMeta> {
    const contribution = await this.store.get(cid);
    if (!contribution) throw new Error(`Contribution not found: ${cid}`);

    const contentHash = contribution.artifacts[name];
    if (contentHash === undefined) {
      throw new Error(`Artifact '${name}' not found on contribution ${cid}`);
    }

    if (this.cas) {
      const stat = await this.cas.stat(contentHash);
      if (stat) {
        return { sizeBytes: stat.sizeBytes, mediaType: stat.mediaType };
      }
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
    if (!this.bountyStore) return [];
    return this.bountyStore.listBounties(query);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  protected override closeExtra(): void {
    this.bountyStore?.close();
    this.cas?.close();
  }
}
