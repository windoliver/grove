/**
 * Provider factory — creates TuiDataProvider instances from resolved backends.
 *
 * Extracted from src/tui/main.ts to share between TUI and `grove up`.
 * No TUI/React imports — pure provider instantiation.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ContributionStore } from "../core/store.js";
import type { TuiDataProvider } from "../tui/provider.js";
import type { ResolvedBackend } from "../tui/resolve-backend.js";

/**
 * Create a type-safe stub ContributionStore.
 *
 * Every required method returns a sensible default (empty arrays, undefined,
 * 0, empty maps). Because the return type is `ContributionStore` (not
 * `unknown`), the compiler will catch any interface drift.
 */
export function createStubContributionStore(identity?: string): ContributionStore {
  return {
    storeIdentity: identity,
    get: async () => undefined,
    getMany: async () => new Map(),
    put: async () => {},
    putMany: async () => {},
    list: async () => [],
    ancestors: async () => [],
    children: async () => [],
    count: async () => 0,
    countSince: async () => 0,
    thread: async () => [],
    hotThreads: async () => [],
    search: async () => [],
    relationsOf: async () => [],
    relatedTo: async () => [],
    findExisting: async () => [],
    replyCounts: async () => new Map(),
    close: () => {},
  };
}

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
  const stubContributionStore = createStubContributionStore("nexus-workspace-stub");

  const casRoot = join(groveRoot, "cas");
  mkdirSync(casRoot, { recursive: true });
  const cas = new FsCas(casRoot);

  const workspaceManager = new LocalWorkspaceManager({
    groveRoot,
    db,
    contributionStore: stubContributionStore,
    cas,
  });

  // Detect co-located grove server for gossip peer data.
  // When grove.json declares services.server, the server runs on PORT (default 4515).
  // Always attempt resolution — resolveGroveDir() walks up from cwd when no override is given,
  // which is the default `grove up` path.
  let serverUrl: string | undefined;
  try {
    const { resolveGroveDir } = await import("../cli/utils/grove-dir.js");
    const { groveDir } = resolveGroveDir(backend.groveOverride);
    const configPath = join(groveDir, "grove.json");
    if (existsSync(configPath)) {
      const { readFileSync } = await import("node:fs");
      const raw = readFileSync(configPath, "utf-8");
      const parsed = JSON.parse(raw) as { services?: { server?: boolean } };
      if (parsed.services?.server) {
        const port = process.env.PORT ?? "4515";
        serverUrl = `http://localhost:${port}`;
      }
    }
  } catch {
    // Config read failed — skip server URL
  }

  return new NexusDataProvider({
    nexusConfig: { client, zoneId: "default" },
    workspaceManager,
    backendLabel: label,
    serverUrl,
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
