/**
 * Provider factory — creates TuiDataProvider instances from resolved backends.
 *
 * Extracted from src/tui/main.ts to share between TUI and `grove up`.
 * No TUI/React imports — pure provider instantiation.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { TuiDataProvider } from "../tui/provider.js";
import type { ResolvedBackend } from "../tui/resolve-backend.js";

/**
 * Create a TuiDataProvider from a resolved backend.
 *
 * Uses dynamic imports to avoid loading unused provider dependencies.
 */
export async function createProvider(
  backend: ResolvedBackend,
  label: string,
): Promise<TuiDataProvider> {
  if (backend.mode === "remote") {
    const { RemoteDataProvider } = await import("../tui/remote-provider.js");
    return new RemoteDataProvider(backend.url, label);
  }

  if (backend.mode === "nexus") {
    return createNexusProvider(backend, label);
  }

  return createLocalProvider(backend, label);
}

async function createNexusProvider(
  backend: Extract<ResolvedBackend, { mode: "nexus" }>,
  label: string,
): Promise<TuiDataProvider> {
  const { NexusHttpClient } = await import("../nexus/nexus-http-client.js");
  const { NexusDataProvider } = await import("../tui/nexus-provider.js");
  const { LocalWorkspaceManager } = await import("../local/workspace.js");
  const { mkdirSync } = await import("node:fs");
  const { initSqliteDb } = await import("../local/sqlite-store.js");
  const { FsCas } = await import("../local/fs-cas.js");

  const client = new NexusHttpClient({ url: backend.url });

  const homeDir = process.env.HOME ?? "/tmp";
  const groveRoot = join(homeDir, ".grove", "nexus-workspaces");
  mkdirSync(groveRoot, { recursive: true });

  const dbPath = join(groveRoot, "nexus.db");
  const db = initSqliteDb(dbPath);

  // Stub contribution store — bare workspace creation doesn't fetch artifacts
  const stubContributionStore = {
    get: async () => undefined,
    put: async () => {},
    putMany: async () => {},
    list: async () => [],
    ancestors: async () => [],
    children: async () => [],
    count: async () => 0,
    thread: async () => [],
    hotThreads: async () => [],
    search: async () => [],
    relationsOf: async () => [],
    relatedTo: async () => [],
    findExisting: async () => undefined,
    replyCounts: async () => new Map(),
    close: () => {},
    storeIdentity: "nexus-workspace-stub",
  } as unknown as import("../core/store.js").ContributionStore;

  const casRoot = join(groveRoot, "cas");
  mkdirSync(casRoot, { recursive: true });
  const cas = new FsCas(casRoot);

  const workspaceManager = new LocalWorkspaceManager({
    groveRoot,
    db,
    contributionStore: stubContributionStore,
    cas,
  });

  return new NexusDataProvider({
    nexusConfig: { client, zoneId: "default" },
    workspaceManager,
    backendLabel: label,
  });
}

async function createLocalProvider(
  backend: Extract<ResolvedBackend, { mode: "local" }>,
  label: string,
): Promise<TuiDataProvider> {
  const { initCliDeps } = await import("../cli/context.js");
  const { createSqliteStores } = await import("../local/sqlite-store.js");
  const { LocalDataProvider } = await import("../tui/local-provider.js");

  const deps = initCliDeps(process.cwd(), backend.groveOverride);

  // Read grove name from .grove/grove.json
  let groveName = "grove";
  try {
    const metaPath = join(deps.groveRoot, ".grove", "grove.json");
    if (existsSync(metaPath)) {
      const raw = await Bun.file(metaPath).text();
      const meta = JSON.parse(raw) as { name?: string };
      groveName = meta.name ?? "grove";
    }
  } catch {
    // Ignore — use default name
  }

  const dbPath = join(deps.groveRoot, ".grove", "grove.db");
  const stores = createSqliteStores(dbPath);

  return new LocalDataProvider({
    contributionStore: deps.store,
    claimStore: stores.claimStore,
    frontier: deps.frontier,
    groveName,
    outcomeStore: stores.outcomeStore,
    bountyStore: stores.bountyStore,
    cas: deps.cas,
    workspace: deps.workspace,
    backendLabel: label,
  });
}
