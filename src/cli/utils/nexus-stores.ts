/**
 * CLI Nexus store resolver.
 *
 * Most contribution CLI commands open local SQLite stores. When a grove is
 * Nexus-managed, the session's contributions live in the Nexus VFS, not local
 * SQLite, so those commands read an empty local DB. This helper resolves the
 * Nexus connection (URL + API key + namespace) from the grove dir — the same
 * inputs `grove-server` / `grove-mcp` use — and builds Nexus-backed stores so a
 * CLI command can see live session data.
 *
 * Resolution mirrors the server: env overrides first, then the project-local
 * `nexus.yaml` / `.state.json` / namespace file. When no URL or no namespace is
 * available, the grove is local-only and the caller falls back to SQLite.
 */

import type { ContentStore } from "../../core/cas.js";
import { readNamespace } from "../../core/project-key.js";
import type { ClaimStore, ContributionStore } from "../../core/store.js";
import { readNexusApiKey, readNexusUrl } from "../nexus-lifecycle.js";

/** Connection parameters for Nexus-backed CLI stores. */
export interface NexusStoreParams {
  readonly url: string;
  readonly apiKey?: string | undefined;
  readonly zoneId: string;
  /** When set, stores are scoped to this session; otherwise zone-wide. */
  readonly sessionId?: string | undefined;
}

/**
 * Resolve Nexus connection params for a grove dir, or `undefined` when the
 * grove is local-only (no Nexus URL, or no resolvable namespace to scope to).
 *
 * @param groveDir  the `.grove` directory (holds the namespace file)
 * @param groveRoot the project root (holds `nexus.yaml` / `.state.json`)
 */
export function resolveNexusParams(
  groveDir: string,
  groveRoot: string,
): NexusStoreParams | undefined {
  const url = process.env.GROVE_NEXUS_URL ?? readNexusUrl(groveRoot);
  if (!url) return undefined;

  const zoneId = readNamespace(groveDir) ?? process.env.GROVE_ZONE_ID;
  if (!zoneId) return undefined;

  const apiKey = readNexusApiKey(groveRoot);
  const sessionId = process.env.GROVE_SESSION_ID;

  return {
    url,
    ...(apiKey ? { apiKey } : {}),
    zoneId,
    ...(sessionId ? { sessionId } : {}),
  };
}

/** Nexus-backed stores for CLI contribution operations. */
export interface NexusStores {
  readonly contributionStore: ContributionStore;
  readonly claimStore: ClaimStore;
  readonly cas: ContentStore;
  /**
   * The session the contribution store is scoped to, or `undefined` for a
   * zone-wide store. Reported by the caller so the user knows what was queried.
   */
  readonly sessionId?: string | undefined;
}

/**
 * Pick the most recently created session id in the zone, or `undefined` when
 * there are none. Contributions in Nexus mode are written at session-scoped
 * VFS paths, so a zone-wide store sees nothing; defaulting to the latest
 * session makes standalone `grove eval --latest` find live session data
 * without the caller having to know GROVE_SESSION_ID.
 */
async function latestSessionId(
  client: import("../../nexus/nexus-http-client.js").NexusHttpClient,
  zoneId: string,
): Promise<string | undefined> {
  try {
    const { NexusSessionStore } = await import("../../nexus/nexus-session-store.js");
    const store = new NexusSessionStore(client, zoneId);
    const sessions = await store.listSessions();
    if (sessions.length === 0) return undefined;
    return [...sessions].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]?.id;
  } catch {
    // Session store unavailable — fall back to a zone-wide store.
    return undefined;
  }
}

/**
 * Build Nexus-backed contribution/claim/CAS stores from resolved params.
 * Mirrors the construction in `src/mcp/serve.ts`. When no explicit sessionId
 * is provided, the contribution store is scoped to the latest session.
 */
export async function openNexusStores(params: NexusStoreParams): Promise<NexusStores> {
  const { NexusHttpClient } = await import("../../nexus/nexus-http-client.js");
  const { NexusContributionStore } = await import("../../nexus/nexus-contribution-store.js");
  const { NexusClaimStore } = await import("../../nexus/nexus-claim-store.js");
  const { NexusCas } = await import("../../nexus/nexus-cas.js");

  const client = new NexusHttpClient({
    url: params.url,
    ...(params.apiKey ? { apiKey: params.apiKey } : {}),
  });

  const sessionId = params.sessionId ?? (await latestSessionId(client, params.zoneId));

  const contributionStore = new NexusContributionStore({
    client,
    zoneId: params.zoneId,
    ...(sessionId ? { sessionId } : {}),
  });
  const claimStore = new NexusClaimStore({ client, zoneId: params.zoneId });
  const cas = new NexusCas({ client, zoneId: params.zoneId });

  return { contributionStore, claimStore, cas, sessionId };
}
